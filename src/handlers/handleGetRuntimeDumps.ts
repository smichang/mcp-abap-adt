import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { handleGetRuntimeDumpDetails } from './handleGetRuntimeDumpDetails';
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';

/**
 * Handler for GetRuntimeDumps tool - dual mode (like GetTransport):
 *  - no dump_id  -> list runtime errors (short dumps), parsed from the Atom feed
 *  - dump_id set -> delegate to the dump-detail reader (readable /summary by default)
 */
export async function handleGetRuntimeDumps(args: any) {
    try {
        // Detail mode: a dump_id switches this into "drill into one dump".
        if (args?.dump_id) {
            return await handleGetRuntimeDumpDetails(args);
        }

        const user = args?.user ? String(args.user).toUpperCase() : '';
        const maxResults = Math.max(1, Number(args?.maxResults) || 100);
        const offset = Math.max(0, Number(args?.offset) || 0);

        // The full parsed dump list — cached (keyed by the actual filters, not
        // maxResults/offset) so a follow-up call with a different window pages without
        // re-querying SAP.
        const key = cacheKey('GetRuntimeDumps', {
            user, category: args?.category || '',
            fromDate: args?.fromDate || '', toDate: args?.toDate || ''
        });
        let allEntries = getCachedList<any>(key);
        const fromCache = !!allEntries;
        let xmlData = ''; // only populated on the fresh-fetch path; used as a raw-XML fallback if rendering throws

        if (!allEntries) {
            const params: Record<string, any> = {};
            if (user) params.user = user;
            if (args?.category) params.category = args.category;
            if (args?.fromDate) params.fromDate = args.fromDate;
            if (args?.toDate) params.toDate = args.toDate;

            const baseUrl = await getBaseUrl();
            const queryString = Object.entries(params)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
                .join('&');
            const url = `${baseUrl}/sap/bc/adt/runtime/dumps?${queryString}`;

            try {
                const response = await makeAdtRequest(url, 'GET', 30000);
                xmlData = response.data ?? response;
                if (typeof xmlData !== 'string') xmlData = String(xmlData);
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: `Runtime dumps retrieval failed.\nReason: ${errMsg}` }]
                        };
                    }
                }
                return return_error(error);
            }

            // Parse Atom feed XML
            try {
                const convert = require('xml-js');
                const parsed = convert.xml2js(xmlData, { compact: true }) as any;

                // Find feed root (atom:feed or feed)
                const feedKey = Object.keys(parsed).find((k: string) => k.endsWith(':feed') || k === 'feed');
                if (!feedKey) throw new Error('No feed element found');
                const feed = parsed[feedKey];

                // Get entries
                const entryKey = Object.keys(feed).find((k: string) => k.endsWith(':entry') || k === 'entry');
                if (!entryKey) {
                    return {
                        isError: false,
                        content: [{ type: 'text', text: 'No runtime dumps found.' }]
                    };
                }

                const rawEntries = feed[entryKey];
                allEntries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
                setCachedList(key, allEntries);
            } catch (parseError) {
                // Fallback: return raw XML if parsing fails
                return {
                    isError: false,
                    content: [{ type: 'text', text: xmlData }]
                };
            }
        }

        if (allEntries.length === 0) {
            return {
                isError: false,
                content: [{ type: 'text', text: 'No runtime dumps found.' }]
            };
        }

        // Guard the render step: an unanticipated entry shape should fall back to the raw
        // XML for debugging (fresh-fetch path) rather than surface only a bare error message.
        try {
            // SAP's dumps feed ignores the maxResults query param, so window it client-side.
            const totalEntries = allEntries.length;
            const entries = allEntries.slice(offset, offset + maxResults);
            const truncated = totalEntries > offset + entries.length;

            // Helper: get text from a node that may have namespace prefix
            const getText = (obj: any, localName: string): string => {
                const key = Object.keys(obj).find((k: string) => k === localName || k.endsWith(':' + localName));
                if (!key) return '';
                const node = obj[key];
                if (node?._text) return String(node._text).trim();
                return '';
            };

            // Helper: get attribute value
            const getAttr = (obj: any, attrName: string): string => {
                const attrs = obj._attributes || {};
                const key = Object.keys(attrs).find((k: string) => k === attrName || k.endsWith(':' + attrName));
                return key ? String(attrs[key] || '') : '';
            };

            const lines: string[] = [];
            const cacheNote = fromCache ? ' [cached]' : '';
            lines.push(truncated || offset > 0
                ? `Runtime Dumps${cacheNote} - showing ${entries.length === 0 ? 0 : offset + 1}-${offset + entries.length} of ${totalEntries}${truncated ? ' (raise maxResults or offset to see more)' : ''}:`
                : `Runtime Dumps${cacheNote} - ${entries.length} entry(ies):`);
            lines.push('');

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];

                // Title = short dump text
                const title = getText(entry, 'title');

                // Dump id (atom:id holds the full path; keep it as-is — GetRuntimeDumpDetails
                // accepts this path form and reduces it to the bare id).
                const dumpId = getText(entry, 'id');

                // Published date
                const published = getText(entry, 'published');
                const dateStr = published ? published.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '') : '';

                // Author
                const authorKey = Object.keys(entry).find((k: string) => k === 'author' || k.endsWith(':author'));
                let user = '';
                if (authorKey) {
                    const author = entry[authorKey];
                    user = getText(author, 'name');
                    // Also check FullName attribute on author element
                    const fullName = getAttr(author, 'FullName');
                    if (fullName && fullName !== user) user = `${user} (${fullName})`;
                }

                // Categories: first = error type, second = program name
                const catKey = Object.keys(entry).find((k: string) => k === 'category' || k.endsWith(':category'));
                let errorType = '';
                let programName = '';
                if (catKey) {
                    const cats = entry[catKey];
                    const catArr: any[] = Array.isArray(cats) ? cats : [cats];
                    for (const cat of catArr) {
                        const attrs = cat._attributes || {};
                        const term = attrs.term || '';
                        const scheme = attrs.scheme || '';
                        // Scheme ending in /type → error type; /program → program name
                        if (scheme.endsWith('/type') || scheme.includes('category/type')) {
                            errorType = term;
                        } else if (scheme.endsWith('/program') || scheme.includes('category/program')) {
                            programName = term;
                        } else if (!errorType) {
                            errorType = term;
                        } else if (!programName) {
                            programName = term;
                        }
                    }
                }

                lines.push(`[${offset + i + 1}] ${title}`);
                if (errorType) lines.push(`    Error Type : ${errorType}`);
                if (programName) lines.push(`    Program    : ${programName}`);
                if (user) lines.push(`    User       : ${user}`);
                if (dateStr) lines.push(`    Date/Time  : ${dateStr}`);
                if (dumpId) lines.push(`    Dump ID    : ${dumpId}`);
                lines.push('');
            }

            return {
                isError: false,
                content: [{ type: 'text', text: lines.join('\n').trimEnd() }]
            };
        } catch (renderError) {
            if (xmlData) return { isError: false, content: [{ type: 'text', text: xmlData }] };
            return return_error(renderError);
        }
    } catch (error) {
        return return_error(error);
    }
}