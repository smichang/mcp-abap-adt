import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl } from '../lib/utils';
import convert from 'xml-js';
import { AxiosError } from 'axios';

/**
 * Parse SAP ADT error XML and extract the human-readable message.
 */
function parseAdtErrorXml(xmlData: string): string | null {
    try {
        if (typeof xmlData !== 'string' || !xmlData.trim().startsWith('<')) return null;
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find(k => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];
        for (const key of Object.keys(root)) {
            if (key.endsWith(':message') || key === 'message' ||
                key.endsWith(':localizedMessage') || key === 'localizedMessage') {
                const msgNode = root[key];
                if (msgNode?._text) return (msgNode._text as string).trim();
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

export async function handleGetStructure(args: any) {
    try {
        if (!args?.structure_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Structure name is required');
        }
        const structureName = args.structure_name.toUpperCase();
        const encodedStructureName = encodeURIComponent(structureName);
        const url = `${await getBaseUrl()}/sap/bc/adt/ddic/structures/${encodedStructureName}/source/main`;

        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            return return_response(response);
        } catch (error) {
            // Parse ADT error XML for a clean error message
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Structure '${structureName}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }
    } catch (error) {
        return return_error(error);
    }
}