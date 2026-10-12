import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl } from '../lib/utils';
import convert from 'xml-js';
import { AxiosError } from 'axios';

/**
 * Parse SAP ADT error XML and extract the human-readable message.
 * Falls back to error type description when message is a raw message key (e.g. "I::000").
 */
function parseAdtErrorXml(xmlData: string): string | null {
    try {
        if (typeof xmlData !== 'string' || !xmlData.trim().startsWith('<')) return null;
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find(k => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];

        // Extract error type id (e.g. ExceptionResourceNotFound)
        let errorType = '';
        const typeKey = Object.keys(root).find(k => k.endsWith(':type') || k === 'type');
        if (typeKey) {
            const typeAttrs = root[typeKey]._attributes || {};
            errorType = (Object.values(typeAttrs)[0] as string) || '';
        }

        // Extract message text
        let msgText = '';
        for (const key of Object.keys(root)) {
            if (key.endsWith(':message') || key === 'message' ||
                key.endsWith(':localizedMessage') || key === 'localizedMessage') {
                const msgNode = root[key];
                if (msgNode?._text) {
                    msgText = (msgNode._text as string).trim();
                    break;
                }
            }
        }

        // If message looks like a raw key (e.g. "I::000", "E::042"), use error type instead
        if (!msgText || /^[A-Z]::/.test(msgText)) {
            if (errorType === 'ExceptionResourceNotFound') return 'Object not found in the system';
            if (errorType) return errorType.replace(/Exception/, '').replace(/([A-Z])/g, ' $1').trim();
            return null;
        }

        return msgText;
    } catch (e) { /* ignore */ }
    return null;
}

export async function handleGetInclude(args: any) {
    try {
        if (!args?.include_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Include name is required');
        }
        const includeName = args.include_name.toUpperCase();
        const encodedIncludeName = encodeURIComponent(includeName);
        const url = `${await getBaseUrl()}/sap/bc/adt/programs/includes/${encodedIncludeName}/source/main`;

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
                        content: [{ type: 'text', text: `Include '${includeName}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }
    } catch (error) {
        return return_error(error);
    }
}