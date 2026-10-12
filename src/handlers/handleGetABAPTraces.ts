import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { handleGetABAPTracesDetails } from './handleGetABAPTracesDetails';
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';

/**
 * Handler for GetABAPTraces tool - dual mode (like GetRuntimeDumps / GetTransport):
 *  - no trace_id  -> list ABAP runtime traces (SAT/SQL perf traces), parsed from the Atom feed
 *  - trace_id set -> delegate to the trace-detail reader (details + hit list)
 *
 * Use cases: performance bottlenecks, SQL analysis, execution flow, DB call optimization.
 */
export async function handleGetABAPTraces(args: any) {
    try {
        // Detail mode: a trace_id switches this into "drill into one trace".
        if (args?.trace_id) {
            return await handleGetABAPTracesDetails(args);
        }

        const user = args?.user ? String(args.user).toUpperCase() : '';
        const objectName = args?.object_name ? String(args.object_name).toUpperCase() : '';
        const maxResults = Math.max(1, Number(args?.max_results) || 50);
        const offset = Math.max(0, Number(args?.offset) || 0);

        // The full parsed trace list — cached (keyed by the actual filters, not
        // max_results/offset) so a follow-up call with a different window pages without
        // re-querying SAP.
        const key = cacheKey('GetABAPTraces', { user, object: objectName });
        let entries = getCachedList<any>(key);
        const fromCache = !!entries;
        let xmlData = ''; // only populated on the fresh-fetch path; used as a raw-XML fallback if rendering throws

        if (!entries) {
            const baseUrl = await getBaseUrl();
            const params: any = {};
            if (user) params.user = user;
            if (objectName) params.object = objectName;

            const url = `${baseUrl}/sap/bc/adt/runtime/traces/abaptraces`;

            try {
                const response = await makeAdtRequest(url, 'GET', 30000, undefined, params);
                xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) return { isError: true, content: [{ type: 'text', text: errMsg }] };
                }
                return return_error(error);
            }

            // Parse the Atom feed into a friendly list that surfaces each Trace ID.
            try {
                const convert = require('xml-js');
                const parsed = convert.xml2js(xmlData, { compact: true }) as any;
                const feedKey = Object.keys(parsed).find((k: string) => k.endsWith(':feed') || k === 'feed');
                const feed = feedKey ? parsed[feedKey] : null;
                const entryKey = feed ? Object.keys(feed).find((k: string) => k.endsWith(':entry') || k === 'entry') : null;

                if (!entryKey) {
                    const who = user ? `user '${user}'` : 'the logon user';
                    return {
                        isError: false,
                        content: [{ type: 'text', text: `No ABAP traces found for ${who}. (Traces are per-user; pass user='*' to list all users.)` }]
                    };
                }

                const rawEntries = feed[entryKey];
                entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
                setCachedList(key, entries);
            } catch (_parseError) {
                // Fall back to raw XML if parsing fails
                return { isError: false, content: [{ type: 'text', text: xmlData }] };
            }
        }

        // Guard the render step: an unanticipated entry shape should fall back to the raw
        // XML for debugging (fresh-fetch path) rather than surface only a bare error message.
        try {
            const total = entries.length;
            const shown = entries.slice(offset, offset + maxResults);

            const getText = (obj: any, localName: string): string => {
                if (!obj) return '';
                const key = Object.keys(obj).find((k: string) => k === localName || k.endsWith(':' + localName));
                const node = key ? obj[key] : null;
                return node?._text ? String(node._text).trim() : '';
            };
            const getAttr = (node: any, attrName: string): string => {
                const attrs = node?._attributes || {};
                const key = Object.keys(attrs).find((k: string) => k === attrName || k.endsWith(':' + attrName));
                return key ? String(attrs[key] || '') : '';
            };

            const cacheNote = fromCache ? ' [cached]' : '';
            const windowEnd = offset + shown.length;
            const lines: string[] = [
                total > windowEnd || offset > 0
                    ? `ABAP Traces${cacheNote} - showing ${shown.length === 0 ? 0 : offset + 1}-${windowEnd} of ${total}${total > windowEnd ? ' (raise max_results or offset to see more)' : ''}:`
                    : `ABAP Traces${cacheNote} - ${total} entry(ies):`,
                ''
            ];
            for (let i = 0; i < shown.length; i++) {
                const e = shown[i];
                const idPath = getText(e, 'id');                       // /sap/bc/adt/runtime/traces/abaptraces/{GUID}
                const traceId = idPath.split('/').pop() || idPath;     // bare GUID
                const title = getText(e, 'title');
                const published = getText(e, 'published');
                const dateStr = published ? published.replace('T', ' ').replace('Z', '') : '';

                // trc:extendedData fields
                const extKey = Object.keys(e).find((k: string) => k.endsWith(':extendedData') || k === 'extendedData');
                const ext = extKey ? e[extKey] : null;
                const user = getText(ext, 'user');
                const runtimeUs = getText(ext, 'runtime');
                const runtimeMs = runtimeUs ? `${(Number(runtimeUs) / 1000).toFixed(1)} ms` : '';
                const stateNode = ext && (ext['trc:state'] || ext['state']);
                const state = stateNode ? getAttr(stateNode, 'text') : '';

                lines.push(`[${offset + i + 1}] ${title}`);
                if (user) lines.push(`    User      : ${user}`);
                if (dateStr) lines.push(`    Date/Time : ${dateStr}`);
                if (runtimeMs) lines.push(`    Runtime   : ${runtimeMs}`);
                if (state) lines.push(`    State     : ${state}`);
                if (traceId) lines.push(`    Trace ID  : ${traceId}`);
                lines.push('');
            }
            return { isError: false, content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
        } catch (renderError) {
            if (xmlData) return { isError: false, content: [{ type: 'text', text: xmlData }] };
            return return_error(renderError);
        }
    } catch (error) {
        return return_error(error);
    }
}
