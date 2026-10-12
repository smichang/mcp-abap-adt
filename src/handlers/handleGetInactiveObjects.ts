import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import convert from 'xml-js';
import { AxiosError } from 'axios';

/**
 * Lists ABAP repository objects the connection's own SAP user currently has
 * inactive (written but not yet activated) — the same set SAP GUI/Eclipse
 * shows in the "Activate" dialog. No query params affect the result; a
 * `?user=` param is silently ignored by SAP — the list is always scoped to
 * the logged-in user of this connection (verified live 2026-09-02).
 */
export async function handleGetInactiveObjects(_args: any) {
    try {
        const baseUrl = await getBaseUrl();
        const url = `${baseUrl}/sap/bc/adt/activation/inactiveobjects`;

        let response: any;
        try {
            response = await makeAdtRequest(url, 'GET', 15000);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) return { isError: true, content: [{ type: 'text', text: errMsg }] };
            }
            return return_error(error);
        }

        try {
            const xmlData = response.data;
            if (typeof xmlData === 'string' && xmlData.trim().startsWith('<')) {
                const parsed = convert.xml2js(xmlData, { compact: true }) as any;
                const rootKey = Object.keys(parsed).find(k => !k.startsWith('_'));
                if (!rootKey) return return_response(response);
                const root = parsed[rootKey];

                const entryKey = Object.keys(root).find(k => k.endsWith(':entry') || k === 'entry');
                if (!entryKey) {
                    return { isError: false, content: [{ type: 'text', text: 'No inactive objects.' }] };
                }
                const entries = Array.isArray(root[entryKey]) ? root[entryKey] : [root[entryKey]];

                const lines: string[] = [`Inactive objects (${entries.length}):`, ''];
                for (const entry of entries) {
                    const objKey = Object.keys(entry).find(k => k.endsWith(':object') || k === 'object');
                    const transportKey = Object.keys(entry).find(k => k.endsWith(':transport') || k === 'transport');
                    if (!objKey) continue;
                    const objNode = entry[objKey];
                    const objAttrs = objNode._attributes || {};

                    const refKey = Object.keys(objNode).find(k => k.endsWith(':ref') || k === 'ref');
                    const refAttrs = refKey ? (objNode[refKey]._attributes || {}) : {};

                    const name = refAttrs.name || refAttrs['adtcore:name'] || '(unknown)';
                    const type = refAttrs.type || refAttrs['adtcore:type'] || '';
                    const uri = refAttrs.uri || refAttrs['adtcore:uri'] || '';
                    const user = objAttrs.user || objAttrs['ioc:user'] || '';
                    const deleted = String(objAttrs.deleted || objAttrs['ioc:deleted'] || 'false') === 'true';

                    let line = `- ${name} (${type})${deleted ? ' [DELETION]' : ''}`;
                    if (user) line += `  user=${user}`;
                    if (uri) line += `  uri=${uri}`;
                    lines.push(line);

                    if (transportKey) {
                        const tAttrs = entry[transportKey]._attributes || {};
                        const tEntries = Object.entries(tAttrs).filter(([k]) => !k.startsWith('_'));
                        if (tEntries.length > 0) {
                            lines.push(`    transport: ${tEntries.map(([k, v]) => `${k.replace(/^tm:|^ioc:/, '')}=${v}`).join(', ')}`);
                        }
                    }
                }

                return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
            }
        } catch (_parseError) {
            // fall through to raw response
        }

        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}
