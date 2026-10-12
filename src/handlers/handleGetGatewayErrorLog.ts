import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, stripHtml } from '../lib/utils';
import { AxiosError } from 'axios';

/**
 * SAP Gateway Error Log — the same feed Eclipse ADT's "ABAP System Monitoring" view reads
 * at /sap/bc/adt/gw/errorlog. Surfaces recent OData/Gateway (Backend + Client) service
 * errors: missing services, binding failures, backend exceptions — invaluable for Fiori/UI5
 * app troubleshooting that no other tool here covers.
 *
 * GET /sap/bc/adt/gw/errorlog returns a plain (non-paged) atom:feed. Live-verified
 * 2026-09-02: username/maxResults/top query params are all silently ignored — the endpoint
 * always returns its full current buffer (a handful of the most recent errors system-wide,
 * across all users), so no filtering/pagination is implemented here. Each atom:entry's full
 * diagnostic detail (Header/Service/Context/Source/Stack) is embedded inline in its own
 * atom:summary (HTML) — there is no separate per-error detail sub-resource to drill into,
 * unlike GetRuntimeDumps/dump_id.
 */
export async function handleGetGatewayErrorLog(args: any) {
    try {
        const baseUrl = await getBaseUrl();
        const url = `${baseUrl}/sap/bc/adt/gw/errorlog`;

        let response: any;
        try {
            response = await makeAdtRequest(url, 'GET', 20000, undefined, undefined, { 'Accept': 'application/atom+xml;type=feed' });
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) return { isError: true, content: [{ type: 'text', text: errMsg }] };
            }
            return return_error(error);
        }

        const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const rawEntries = [...xmlData.matchAll(/<atom:entry>([\s\S]*?)<\/atom:entry>/g)].map(m => m[1]);

        if (rawEntries.length === 0) {
            return { isError: false, content: [{ type: 'text', text: 'No Gateway error log entries currently buffered.' }] };
        }

        const entries = rawEntries.map(e => ({
            id: e.match(/<atom:id>(.*?)<\/atom:id>/)?.[1] ?? '',
            title: decodeEntities(e.match(/<atom:title>(.*?)<\/atom:title>/)?.[1] ?? ''),
            updated: e.match(/<atom:updated>(.*?)<\/atom:updated>/)?.[1] ?? '',
            author: decodeEntities(e.match(/<atom:author>\s*<atom:name>(.*?)<\/atom:name>/)?.[1] ?? ''),
            summary: e.match(/<atom:summary[^>]*>([\s\S]*?)<\/atom:summary>/)?.[1] ?? ''
        }));

        const entryId = args?.entry_id ? String(args.entry_id) : '';
        if (entryId) {
            const match = entries.find(e => e.id === entryId || e.id.endsWith(entryId));
            if (!match) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `entry_id "${entryId}" not found in the current Gateway error log window (${entries.length} entries buffered). Call without entry_id to list available ids — the buffer is short-lived and this one may already be gone.` }]
                };
            }
            // atom:summary is HTML embedded as XML text, so it arrives double-escaped
            // (e.g. "&lt;h4&gt;" for a literal "<h4>") — decode entities first so
            // stripHtml's tag regexes (which look for real "<...>") actually match.
            const text = `${match.title}\n${match.updated}  user=${match.author}  id=${match.id}\n\n${stripHtml(decodeEntities(match.summary))}`;
            return { isError: false, content: [{ type: 'text', text }] };
        }

        const lines = [
            `SAP Gateway Error Log (${entries.length} entries buffered — most recent system-wide OData/Gateway errors; SAP ignores filter/paging query params here, so this is always the full current buffer):`,
            ''
        ];
        for (const e of entries) {
            lines.push(`- [${e.updated}] ${e.title}`);
            lines.push(`    user=${e.author}  id=${e.id}`);
        }
        lines.push('', 'Pass entry_id (the id shown above) to get full diagnostic detail for one entry.');

        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}
