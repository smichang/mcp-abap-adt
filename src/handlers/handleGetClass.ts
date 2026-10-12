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

        // Extract error type id
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

        // If message looks like a raw key (e.g. "I::000"), use error type instead
        if (!msgText || /^[A-Z]::/.test(msgText)) {
            if (errorType === 'ExceptionResourceNotFound') return 'Object not found in the system';
            if (errorType) return errorType.replace(/Exception/, '').replace(/([A-Z])/g, ' $1').trim();
            return null;
        }

        return msgText;
    } catch (e) { /* ignore */ }
    return null;
}

export async function handleGetClass(args: any) {
    try {
        if (!args?.class_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Class name is required');
        }
        const className = args.class_name.toUpperCase();
        const encodedClassName = encodeURIComponent(className);
        const url = `${await getBaseUrl()}/sap/bc/adt/oo/classes/${encodedClassName}/source/main`;

        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            return return_response(response);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Class '${className}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }
    } catch (error) {
        return return_error(error);
    }
}