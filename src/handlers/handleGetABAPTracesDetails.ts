import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

/**
 * Handler for GetABAPTraces detail mode (called when a trace_id is supplied).
 *
 * The raw hitlist is huge (~400 KB for a few hundred entries), so this returns a
 * concise, readable performance summary instead of dumping XML:
 *  - header: title, user, total/ABAP/system/DB runtime
 *  - top-N hitlist entries by gross time (default 20, via `top`)
 *  - database-access summary (all rows — the dbAccesses payload is small)
 */
export async function handleGetABAPTracesDetails(args: any) {
    try {
        if (!args?.trace_id) {
            throw new McpError(ErrorCode.InvalidParams, 'trace_id is required');
        }

        // Accept a bare trace id (GUID) or a full atom:id / self-link path; reduce to the bare id.
        let traceIdRaw = String(args.trace_id);
        const m = traceIdRaw.match(/abaptraces\/([^/?#]+)/i);
        if (m) traceIdRaw = m[1];
        const traceId = encodeURIComponent(traceIdRaw);
        const top = Math.max(1, Number(args?.top) || 20);
        const baseUrl = await getBaseUrl();

        const base = `${baseUrl}/sap/bc/adt/runtime/traces/abaptraces/${traceId}`;

        // Main metadata (small). Failure here means the trace id is bad → surface a clear error.
        let mainXml: string;
        try {
            const r = await makeAdtRequest(base, 'GET', 30000);
            mainXml = typeof r.data === 'string' ? r.data : String(r.data ?? '');
        } catch (error) {
            let sapReason = '';
            if (error instanceof AxiosError && error.response?.data) {
                const parsed = parseAdtErrorXml(String(error.response.data));
                if (parsed) sapReason = `SAP: ${parsed}\n\n`;
            }
            throw new McpError(
                ErrorCode.InternalError,
                `Trace "${args.trace_id}" not found or not accessible.\n\n` +
                sapReason +
                `Possible reasons:\n` +
                `1. Trace ID does not exist or has expired\n` +
                `2. Missing authorization for trace access\n` +
                `3. Trace was deleted or aged out\n\n` +
                `Use GetABAPTraces (list mode) to find valid trace IDs.`
            );
        }

        // Hitlist + dbAccesses are non-fatal; fetch in parallel.
        const [hitlistXml, dbXml] = await Promise.all([
            makeAdtRequest(`${base}/hitlist`, 'GET', 30000)
                .then(r => (typeof r.data === 'string' ? r.data : String(r.data ?? ''))).catch(() => ''),
            makeAdtRequest(`${base}/dbAccesses`, 'GET', 30000)
                .then(r => (typeof r.data === 'string' ? r.data : String(r.data ?? ''))).catch(() => '')
        ]);

        const convert = require('xml-js');
        const us = (v: string) => (v ? `${(Number(v) / 1000).toFixed(1)} ms` : '');

        const lines: string[] = [];

        // ── Header ──
        try {
            const main = convert.xml2js(mainXml, { compact: true }) as any;
            const entry = main['atom:entry'] || main['entry'] || {};
            const title = entry['atom:title']?._text || entry['title']?._text || '(no title)';
            const ext = entry['trc:extendedData'] || entry['extendedData'] || {};
            const t = (k: string) => ext[`trc:${k}`]?._text || ext[k]?._text || '';
            lines.push(`Trace: ${title}`);
            lines.push(`Trace ID: ${traceIdRaw}`);
            const meta: string[] = [];
            if (t('user')) meta.push(`user ${t('user')}`);
            if (t('client')) meta.push(`client ${t('client')}`);
            if (ext['trc:state']?._attributes?.text) meta.push(ext['trc:state']._attributes.text);
            if (meta.length) lines.push(meta.join('  |  '));
            const rt = t('runtime'), rtA = t('runtimeABAP'), rtS = t('runtimeSystem'), rtD = t('runtimeDatabase');
            if (rt) lines.push(`Runtime: ${us(rt)} total  (ABAP ${us(rtA)}, System ${us(rtS)}, DB ${us(rtD)})`);
        } catch { /* header best-effort */ }

        // ── Top-N hitlist by gross time ──
        try {
            const hl = convert.xml2js(hitlistXml, { compact: true }) as any;
            const root = hl['trc:hitlist'] || hl['hitlist'] || {};
            const raw = root['trc:entry'] || root['entry'];
            const entries: any[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];
            const rows = entries.map((e: any) => {
                const a = e._attributes || {};
                const gross = e['trc:grossTime']?._attributes || {};
                const net = e['trc:proceduralNetTime']?._attributes || e['trc:traceEventNetTime']?._attributes || {};
                const prog = (e['trc:callingProgram']?._attributes || {})['adtcore:name'] || '';
                return {
                    desc: String(a.description || '').trim(),
                    hits: a.hitCount || '',
                    prog,
                    grossUs: Number(gross.time || 0),
                    grossPct: Number(gross.percentage || 0),
                    netUs: Number(net.time || 0)
                };
            }).sort((x, y) => y.grossUs - x.grossUs);

            lines.push('');
            lines.push(`Hit List — top ${Math.min(top, rows.length)} of ${rows.length} by gross time:`);
            lines.push('');
            lines.push('  #  Gross%   Gross(ms)  Net(ms)  Hits  Program / Operation');
            lines.push('  -  -------  ---------  -------  ----  -------------------');
            rows.slice(0, top).forEach((r, i) => {
                const idx = String(i + 1).padStart(2);
                const pct = r.grossPct.toFixed(2).padStart(6);
                const g = (r.grossUs / 1000).toFixed(1).padStart(9);
                const n = (r.netUs / 1000).toFixed(1).padStart(7);
                const h = String(r.hits).padStart(4);
                const op = [r.prog, r.desc].filter(Boolean).join(' — ');
                lines.push(`  ${idx}  ${pct}  ${g}  ${n}  ${h}  ${op}`);
            });
            if (rows.length > top) lines.push(`  … and ${rows.length - top} more (raise top= to see more).`);
        } catch { /* hitlist best-effort */ }

        // ── DB access summary (payload is small; show all) ──
        try {
            const db = convert.xml2js(dbXml, { compact: true }) as any;
            const root = db['trc:dbAccesses'] || db['dbAccesses'] || {};
            const raw = root['trc:dbAccess'] || root['dbAccess'];
            const accesses: any[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];
            const rows = accesses.map((e: any) => {
                const a = e._attributes || {};
                const at = e['trc:accessTime']?._attributes || {};
                return {
                    table: String(a.tableName || '').trim(),
                    type: String(a.type || '').trim(),
                    count: a.totalCount || '0',
                    buffered: a.bufferedCount || '0',
                    pct: Number(at.ratioOfTraceTotal || 0)
                };
            }).filter(r => r.table).sort((x, y) => y.pct - x.pct);
            if (rows.length) {
                lines.push('');
                lines.push(`Database Accesses — ${rows.length} table(s):`);
                lines.push('');
                lines.push('  Trace%  Count  Buffered  Type             Table');
                lines.push('  ------  -----  --------  ---------------  -----');
                rows.forEach(r => {
                    lines.push(`  ${r.pct.toFixed(2).padStart(6)}  ${String(r.count).padStart(5)}  ${String(r.buffered).padStart(8)}  ${r.type.padEnd(15)}  ${r.table}`);
                });
            }
        } catch { /* dbAccesses best-effort */ }

        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}
