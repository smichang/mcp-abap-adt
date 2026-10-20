import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

// Resolves a function module name to its containing function group via quickSearch
// (objectType=FUGR/FF). SAP's search response carries the group in the object URI
// itself (e.g. /sap/bc/adt/functions/groups/0002/fmodules/bapi_companycode_getdetail) —
// there is no separate "package" field for this, and a function module's package
// (DEVCLASS) is unrelated to its function group.
async function resolveFunctionGroup(functionName: string): Promise<string | null> {
    try {
        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(functionName)}&maxResults=5&objectType=${encodeURIComponent('FUGR/FF')}`;
        const response = await makeAdtRequest(url, 'GET', 15000);
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];
        const refKey = Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
        if (!refKey) return null;
        const raw = root[refKey];
        const refs = Array.isArray(raw) ? raw : [raw];

        for (const ref of refs) {
            const attrs = ref._attributes || {};
            const uriKey = Object.keys(attrs).find((k: string) => k === 'uri' || k.endsWith(':uri'));
            const uri = uriKey ? String(attrs[uriKey] || '') : '';
            const match = uri.match(/\/functions\/groups\/([^/]+)\/fmodules\//i);
            if (match) return match[1].toUpperCase();
        }
        return null;
    } catch {
        return null;
    }
}

// The function module's attributes, from its ADT metadata document (no /source/main). Above all the
// processing type: a plan once re-planned "make it remote-enabled" from a CALL_FUNCTION_NOT_REMOTE
// dump although the FM had been RFC-enabled four minutes later — the source alone cannot show it.
// Returned as a SECOND content item: output_file writes content[0] only, so a saved file stays
// pure source that can be written back.
const PROCESSING_TYPES: Record<string, string> = {
    normal: 'normal (NOT remote-enabled)',
    rfc: 'RFC (remote-enabled)',
    update: 'update module',
};

/** Pure: one readable line from an fmodule:abapFunctionModule document, or '' if it is not one. */
export function fmAttributesLine(xml: string): string {
    const attr = (name: string) => (xml.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '';
    if (!/<fmodule:abapFunctionModule\b/.test(xml)) return '';
    const type = attr('fmodule:processingType');
    const group = (xml.match(/<adtcore:containerRef[^>]*adtcore:name="([^"]*)"/) || [])[1] || '';
    const pkg = (xml.match(/<adtcore:containerRef[^>]*adtcore:packageName="([^"]*)"/) || [])[1] || '';
    const changedAt = attr('adtcore:changedAt').replace('T', ' ').replace(/Z$/, ' UTC');
    const parts = [
        `processing type: ${PROCESSING_TYPES[type] ?? (type || 'unknown')}`,
        type === 'rfc' && attr('fmodule:rfcScope') ? `RFC scope ${attr('fmodule:rfcScope')}` : '',
        attr('adtcore:version') ? `version ${attr('adtcore:version')}` : '',
        changedAt ? `last changed ${changedAt}${attr('adtcore:changedBy') ? ` by ${attr('adtcore:changedBy')}` : ''}` : '',
        attr('fmodule:releaseState') ? `release state ${attr('fmodule:releaseState')}` : '',
    ].filter(Boolean);
    return `[Function module ${attr('adtcore:name')}${group ? ` — group ${group}` : ''}${pkg ? `, package ${pkg}` : ''}] ${parts.join(' · ')}`;
}

export async function handleGetFunction(args: any) {
    try {
        if (!args?.function_group && !args?.function_name) {
            throw new McpError(ErrorCode.InvalidParams, 'function_group or function_name is required');
        }

        let functionGroup = args.function_group ? String(args.function_group).toUpperCase() : '';
        const functionName = args.function_name ? String(args.function_name).toUpperCase() : '';

        if (!functionGroup) {
            // function_name given without function_group — resolve it automatically
            // instead of requiring the caller to already know it (SearchObject returns
            // the DEVCLASS package, not the function group, so they can't derive it).
            const resolved = await resolveFunctionGroup(functionName);
            if (!resolved) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Could not resolve a function group for '${functionName}' (not found via search). Pass function_group explicitly if you know it.` }]
                };
            }
            functionGroup = resolved;
        }
        const encodedFunctionGroup = encodeURIComponent(functionGroup);

        // If function_name is provided, retrieve the specific function module source
        // Otherwise, retrieve the function group source
        if (functionName) {
            const encodedFunctionName = encodeURIComponent(functionName);
            const fmUrl = `${await getBaseUrl()}/sap/bc/adt/functions/groups/${encodedFunctionGroup}/fmodules/${encodedFunctionName}`;
            const url = `${fmUrl}/source/main`;

            try {
                const [response, meta] = await Promise.all([
                    makeAdtRequest(url, 'GET', 30000),
                    // Attributes are a bonus: any failure here must not fail the source read.
                    makeAdtRequest(fmUrl, 'GET', 15000, undefined, undefined, { Accept: 'application/vnd.sap.adt.functions.fmodules.v3+xml, application/xml, */*' })
                        .then(r => fmAttributesLine(String(r.data ?? '')), () => ''),
                ]);
                const res = return_response(response);
                if (meta) res.content.push({ type: 'text', text: meta });
                return res;
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: `Function '${functionName}' not found in function group '${functionGroup}'.\nReason: ${errMsg}` }]
                        };
                    }
                }
                return return_error(error);
            }
        } else {
            const url = `${await getBaseUrl()}/sap/bc/adt/functions/groups/${encodedFunctionGroup}/source/main`;

            try {
                const response = await makeAdtRequest(url, 'GET', 30000);
                return return_response(response);
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: `Function group '${functionGroup}' not found.\nReason: ${errMsg}` }]
                        };
                    }
                }
                return return_error(error);
            }
        }
    } catch (error) {
        return return_error(error);
    }
}
