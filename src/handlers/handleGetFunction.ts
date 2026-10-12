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
            const url = `${await getBaseUrl()}/sap/bc/adt/functions/groups/${encodedFunctionGroup}/fmodules/${encodedFunctionName}/source/main`;

            try {
                const response = await makeAdtRequest(url, 'GET', 30000);
                return return_response(response);
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
