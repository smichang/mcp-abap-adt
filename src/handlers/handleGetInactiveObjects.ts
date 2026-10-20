import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import convert from 'xml-js';
import { AxiosError } from 'axios';
import { freestyleRows } from '../lib/transportCheck';

/** Pure: the warning for an inactive version saved by `user` on an object `owner` is responsible for. */
export function ownerNote(user: string, owner: string): string {
    if (!owner || !user || owner.toUpperCase() === user.toUpperCase()) return '';
    return `    ⚠ responsible: ${owner} — this inactive version by ${user} sits on ${owner}'s object. `
        + `Activating publishes it into their object, DeleteObject deletes their object; to drop only `
        + `${user}'s changes, discard the inactive version (manual SE80/Eclipse) after comparing with GetCode resource=VERSION.`;
}

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

                // Who is responsible for each object (TADIR) — a plan-eval run called a colleague's
                // $TMP program "SSCR-owned" because this list only shows who saved the inactive version.
                const names = [...new Set(entries.map((en: any) => {
                    const ok = Object.keys(en).find(k => k.endsWith(':object') || k === 'object');
                    const node = ok ? en[ok] : {};
                    const rk = Object.keys(node).find(k => k.endsWith(':ref') || k === 'ref');
                    const ra = rk ? (node[rk]._attributes || {}) : {};
                    return String(ra.name || ra['adtcore:name'] || '').toUpperCase();
                }).filter((n: string) => /^[A-Z0-9_/]+$/.test(n)))].slice(0, 100) as string[];
                const owners = new Map<string, { author: string; devclass: string }>();
                if (names.length) {
                    try {
                        const rows = await freestyleRows(String(baseUrl),
                            `SELECT OBJ_NAME, AUTHOR, DEVCLASS FROM TADIR WHERE PGMID = 'R3TR' AND OBJ_NAME IN (${names.map(n => `'${n}'`).join(',')})`);
                        for (const r of rows) if (r.OBJ_NAME) owners.set(r.OBJ_NAME.toUpperCase(), { author: r.AUTHOR, devclass: r.DEVCLASS });
                    } catch { /* owner info is a bonus; the list itself stands */ }
                }

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

                    const own = owners.get(String(name).toUpperCase());
                    let line = `- ${name} (${type})${deleted ? ' [DELETION]' : ''}`;
                    if (user) line += `  user=${user}`;
                    if (own) line += `  responsible=${own.author || '?'}  package=${own.devclass || '?'}`;
                    if (uri) line += `  uri=${uri}`;
                    lines.push(line);
                    const note = own ? ownerNote(user, own.author) : '';
                    if (note) lines.push(note);

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
