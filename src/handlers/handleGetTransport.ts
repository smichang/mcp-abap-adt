import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { getConfig } from '../index';
import { AxiosError } from 'axios';
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';

const toArr = (v: any): any[] => (!v ? [] : Array.isArray(v) ? v : [v]);
const attr = (node: any, key: string): string => node?._attributes?.[key] || '';

function findAllRequests(obj: any, results: any[] = []): any[] {
    if (!obj || typeof obj !== 'object') return results;
    if (Array.isArray(obj)) { for (const item of obj) findAllRequests(item, results); return results; }
    for (const key of Object.keys(obj)) {
        if (key === 'tm:request') { results.push(...toArr(obj[key])); }
        else { findAllRequests(obj[key], results); }
    }
    return results;
}

function formatList(parsed: any, user: string, maxResults: number, offset: number = 0, fromCache: boolean = false): string {
    const root = parsed['tm:root'];
    if (!root) return `Transports for user: ${user}\n\nNo transports found.`;

    const lines: string[] = [];
    lines.push(`Transports for user: ${user}${fromCache ? ' [cached]' : ''}`, '');

    let seen = 0;        // requests encountered so far, for offset skipping
    let total = 0;       // requests actually rendered in this window
    let grandTotal = 0;  // requests found across the whole feed

    const collectRequests = (container: any, sys: string, modLines: string[], relLines: string[]) => {
        for (const req of toArr(container['tm:modifiable']?.['tm:request'])) {
            const n = attr(req, 'tm:number'); if (!n) continue;
            grandTotal++;
            if (seen++ < offset) continue;
            if (total >= maxResults) continue;
            modLines.push(`  ${n.padEnd(14)}  ${attr(req, 'tm:desc').substring(0, 45).padEnd(45)}  ${attr(req, 'tm:owner').padEnd(10)}  ${sys}`);
            total++;
        }
        for (const req of toArr(container['tm:released']?.['tm:request'])) {
            const n = attr(req, 'tm:number'); if (!n) continue;
            grandTotal++;
            if (seen++ < offset) continue;
            if (total >= maxResults) continue;
            relLines.push(`  ${n.padEnd(14)}  ${attr(req, 'tm:desc').substring(0, 45).padEnd(45)}  ${attr(req, 'tm:owner').padEnd(10)}  ${sys}`);
            total++;
        }
    };

    const processSection = (section: any, label: string) => {
        if (!section) return;
        const modLines: string[] = [];
        const relLines: string[] = [];

        const targets = toArr(section['tm:target']);
        if (targets.length > 0) {
            // targets=true mode: modifiable/released nested under each tm:target
            for (const target of targets) {
                collectRequests(target, attr(target, 'tm:name'), modLines, relLines);
            }
        } else {
            // no-targets mode: modifiable/released directly on section
            collectRequests(section, '', modLines, relLines);
        }

        if (modLines.length > 0) {
            lines.push(`${label} — Modifiable (${modLines.length}):`);
            lines.push(`  ${'Transport'.padEnd(14)}  ${'Description'.padEnd(45)}  ${'Owner'.padEnd(10)}  Target`);
            lines.push(`  ${'-'.repeat(14)}  ${'-'.repeat(45)}  ${'-'.repeat(10)}  ------`);
            lines.push(...modLines, '');
        }
        if (relLines.length > 0) {
            lines.push(`${label} — Released (${relLines.length}):`);
            lines.push(`  ${'Transport'.padEnd(14)}  ${'Description'.padEnd(45)}  ${'Owner'.padEnd(10)}  Target`);
            lines.push(`  ${'-'.repeat(14)}  ${'-'.repeat(45)}  ${'-'.repeat(10)}  ------`);
            lines.push(...relLines, '');
        }
    };

    processSection(root['tm:workbench'], 'Workbench');
    processSection(root['tm:customizing'], 'Customizing');

    const omitted = grandTotal - offset - total;
    if (grandTotal === 0) lines.push('No transports found.');
    else if (total === 0) lines.push(`No transports in this window (offset ${offset} ≥ ${grandTotal} total).`);
    if (omitted > 0) lines.push(`… ${omitted} more transport(s) omitted (showing ${offset + 1}-${offset + total} of ${grandTotal}; raise max_results or offset to see more).`);
    return lines.join('\n');
}

function formatDetail(parsed: any, transportNumber: string): string {
    const requests = findAllRequests(parsed);
    const lines: string[] = [];

    if (requests.length === 0) {
        return `Transport: ${transportNumber}\nNo details available or transport not found.`;
    }

    for (const req of requests) {
        const num    = attr(req, 'tm:number') || transportNumber;
        const desc   = attr(req, 'tm:desc');
        const owner  = attr(req, 'tm:owner');
        const status = attr(req, 'tm:status_text') || attr(req, 'tm:status') || '';
        lines.push(`Transport: ${num}  |  ${desc}  |  Owner: ${owner}${status ? `  |  ${status}` : ''}`);
        lines.push('');

        const tasks = toArr(req['tm:task']);
        if (tasks.length > 0) {
            lines.push('Tasks:');
            for (const task of tasks) {
                const tnum = attr(task, 'tm:number');
                const towner = attr(task, 'tm:owner');
                const tdesc = attr(task, 'tm:desc');
                lines.push(`  ${tnum.padEnd(14)}  ${towner.padEnd(12)}  ${tdesc}`);

                const objects = toArr(task['tm:abap_object']);
                if (objects.length > 0) {
                    lines.push('  Objects:');
                    for (const obj of objects) {
                        const pgmid = attr(obj, 'tm:pgmid').padEnd(5);
                        const type  = attr(obj, 'tm:type').padEnd(6);
                        const name  = attr(obj, 'tm:name');
                        lines.push(`    ${pgmid}  ${type}  ${name}`);
                    }
                }
            }
        } else {
            lines.push('(No tasks or objects found in this transport)');
        }
    }

    return lines.join('\n');
}

export async function handleGetTransport(args: any) {
    try {
        const baseUrl = await getBaseUrl();
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : null;

        if (transportNumber) {
            const url = `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`;
            let xmlData: string;
            try {
                const response = await makeAdtRequest(url, 'GET', 30000, undefined, undefined,
                    { 'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml' });
                xmlData = response.data ?? response;
                if (typeof xmlData !== 'string') xmlData = String(xmlData);
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) return { isError: true, content: [{ type: 'text', text: `Transport '${transportNumber}' lookup failed.\nReason: ${errMsg}` }] };
                }
                return return_error(error);
            }

            try {
                const convert = require('xml-js');
                const parsed = convert.xml2js(xmlData, { compact: true }) as any;
                return { isError: false, content: [{ type: 'text', text: formatDetail(parsed, transportNumber) }] };
            } catch (_) {
                return { isError: false, content: [{ type: 'text', text: xmlData }] };
            }
        } else {
            const user = args?.user ? String(args.user).toUpperCase() : getConfig().username.toUpperCase();
            const maxResults = Math.max(1, Number(args?.max_results) || 100);
            const offset = Math.max(0, Number(args?.offset) || 0);

            // The full parsed transport tree — cached so a follow-up call with a different
            // offset/max_results pages without re-querying SAP.
            const key = cacheKey('GetTransport', { user });
            const cached = getCachedList<any>(key);
            let parsed: any;
            let fromCache = false;
            let xmlData = ''; // only populated on the fresh-fetch path; used as a raw-XML fallback if rendering throws

            if (cached) {
                parsed = cached[0];
                fromCache = true;
            } else {
                const url = `${baseUrl}/sap/bc/adt/cts/transportrequests`;
                try {
                    // requestStatus=DR returns BOTH modifiable (D, i.e. open) and released (R)
                    // requests. Without it SAP returns released-only, so open CRs were invisible.
                    const response = await makeAdtRequest(url, 'GET', 30000, undefined, { user, requestStatus: 'DR' });
                    xmlData = response.data ?? response;
                    if (typeof xmlData !== 'string') xmlData = String(xmlData);
                } catch (error) {
                    if (error instanceof AxiosError && error.response?.data) {
                        const errMsg = parseAdtErrorXml(String(error.response.data));
                        if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to list transports.\nReason: ${errMsg}` }] };
                    }
                    return return_error(error);
                }

                if (!xmlData.trim()) {
                    return { isError: false, content: [{ type: 'text', text: `No transports found for user '${user}'.` }] };
                }

                try {
                    const convert = require('xml-js');
                    parsed = convert.xml2js(xmlData, { compact: true }) as any;
                    setCachedList(key, [parsed]);
                } catch (_) {
                    return { isError: false, content: [{ type: 'text', text: xmlData }] };
                }
            }

            // formatList() traverses the parsed tree defensively, but guard the render step
            // anyway: an unanticipated shape should fall back to the raw XML for debugging
            // (fresh-fetch path) rather than surface only a bare error message.
            try {
                return { isError: false, content: [{ type: 'text', text: formatList(parsed, user, maxResults, offset, fromCache) }] };
            } catch (renderError) {
                if (xmlData) return { isError: false, content: [{ type: 'text', text: xmlData }] };
                return return_error(renderError);
            }
        }
    } catch (error) {
        return return_error(error);
    }
}
