import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

export async function handleSearchObject(args: any) {
    try {
        if (!args?.query) {
            throw new McpError(ErrorCode.InvalidParams, 'Search query is required');
        }
        const maxResults = args.maxResults || 100;
        const encodedQuery = encodeURIComponent(args.query);
        // Server-side type filter (e.g. CLAS, PROG, INTF, TABL, or full subtype CLAS/OC).
        // SAP accepts the broad group code or the full subtype; a single type only.
        const objectType = args.object_type ? String(args.object_type).toUpperCase() : '';
        const typeParam = objectType ? `&objectType=${encodeURIComponent(objectType)}` : '';
        const url = `${await getBaseUrl()}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodedQuery}&maxResults=${maxResults}${typeParam}`;

        let xmlData: string;
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
                        content: [{ type: 'text', text: `Search failed.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }

        // Parse XML
        try {
            const convert = require('xml-js');
            const parsed = convert.xml2js(xmlData, { compact: true }) as any;

            // Find root key (adtcore:objectReferences)
            const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
            if (!rootKey) throw new Error('Unexpected XML structure');
            const root = parsed[rootKey];

            // Get objectReference elements
            const refKey = Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
            let refs: any[] = [];
            if (refKey) {
                const raw = root[refKey];
                refs = Array.isArray(raw) ? raw : [raw];
            }

            if (refs.length === 0) {
            const noteType = objectType ? ` with type=${objectType}` : '';
            return {
                isError: false,
                content: [{ type: 'text', text: `No objects found matching '${args.query}'${noteType}.` }]
            };
            }

            // Helper: get attribute by local name
            const getAttr = (obj: any, localName: string): string => {
                const key = Object.keys(obj).find((k: string) => k === localName || k.endsWith(':' + localName));
                return key ? (obj[key] || '') : '';
            };

            // Function modules (FUGR/FF) carry their function group in the object URI
            // (e.g. /sap/bc/adt/functions/groups/0002/fmodules/...), not in a separate
            // field — packageName is the DEVCLASS, which is a different grouping.
            const getFunctionGroup = (attrs: any): string => {
                if (getAttr(attrs, 'type').toUpperCase() !== 'FUGR/FF') return '';
                const uri = getAttr(attrs, 'uri');
                const match = uri.match(/\/functions\/groups\/([^/]+)\/fmodules\//i);
                return match ? match[1].toUpperCase() : '';
            };
            const hasFuncGroupHits = refs.some((r: any) => getFunctionGroup(r._attributes || {}));

            const lines: string[] = [];
            const typeNote = objectType ? ` (type=${objectType})` : '';
            // quickSearch has no total-count and no pagination — hitting the cap means
            // there may be more matches that are not shown. Signal it explicitly.
            const capNote = refs.length >= maxResults
                ? ` — cap reached, more may exist; refine the query or raise maxResults`
                : '';
            lines.push(`Found ${refs.length} object(s) matching '${args.query}'${typeNote}${capNote}:`);
            lines.push('');

            // Calculate column widths for alignment
            const nameWidth = Math.min(40, Math.max(4, ...refs.map((r: any) => (getAttr(r._attributes || {}, 'name') || '').length)));
            const typeWidth = Math.min(12, Math.max(4, ...refs.map((r: any) => (getAttr(r._attributes || {}, 'type') || '').length)));
            const groupWidth = hasFuncGroupHits ? Math.min(12, Math.max(5, ...refs.map((r: any) => getFunctionGroup(r._attributes || {}).length))) : 0;
            const pkgWidth = Math.min(25, Math.max(7, ...refs.map((r: any) => (getAttr(r._attributes || {}, 'packageName') || '').length)));

            const groupHeader = hasFuncGroupHits ? `${'Group'.padEnd(groupWidth)}  ` : '';
            const groupSep = hasFuncGroupHits ? `${'-'.repeat(groupWidth)}  ` : '';
            lines.push(`${'Name'.padEnd(nameWidth)}  ${'Type'.padEnd(typeWidth)}  ${groupHeader}${'Package'.padEnd(pkgWidth)}  Description`);
            lines.push(`${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  ${groupSep}${'-'.repeat(pkgWidth)}  -----------`);

            for (const ref of refs) {
                const a = ref._attributes || {};
                const name = getAttr(a, 'name');
                const type = getAttr(a, 'type');
                const pkg = getAttr(a, 'packageName');
                const desc = getAttr(a, 'description');
                const groupCell = hasFuncGroupHits ? `${getFunctionGroup(a).padEnd(groupWidth)}  ` : '';
                lines.push(`${name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}  ${groupCell}${pkg.padEnd(pkgWidth)}  ${desc}`);
            }

            return {
                isError: false,
                content: [{ type: 'text', text: lines.join('\n') }]
            };
        } catch (parseError) {
            return {
                isError: false,
                content: [{ type: 'text', text: xmlData }]
            };
        }
    } catch (error) {
        return return_error(error);
    }
}