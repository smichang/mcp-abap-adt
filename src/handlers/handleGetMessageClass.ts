import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

/**
 * Handler for GetMessageClass tool
 *
 * Retrieves message class information including all message texts.
 * Message classes are used throughout SAP for centralized message management.
 */
export async function handleGetMessageClass(args: any) {
    try {
        if (!args?.message_class) {
            throw new McpError(ErrorCode.InvalidParams, 'message_class is required');
        }

        const messageClass = args.message_class.toUpperCase();
        const baseUrl = await getBaseUrl();

        // Try primary endpoint, fall back to alternative
        const endpoints = [
            `${baseUrl}/sap/bc/adt/vit/msgclass/${encodeURIComponent(messageClass)}`,
            `${baseUrl}/sap/bc/adt/messageclass/${encodeURIComponent(messageClass)}`
        ];

        let xmlData: string | null = null;
        let lastError: any = null;
        for (const url of endpoints) {
            try {
                const response = await makeAdtRequest(url, 'GET', 30000);
                xmlData = response.data ?? response;
                if (typeof xmlData !== 'string') xmlData = String(xmlData);
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (xmlData === null) {
            if (lastError instanceof AxiosError && lastError.response?.data) {
                const errMsg = parseAdtErrorXml(String(lastError.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Message class '${messageClass}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(lastError);
        }

        // Parse XML
        try {
            const convert = require('xml-js');
            const parsed = convert.xml2js(xmlData, { compact: true }) as any;

            // Find root key (mc:messageClass)
            const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
            if (!rootKey) throw new Error('Unexpected XML structure');
            const root = parsed[rootKey];
            const attrs = root._attributes || {};

            // Helper to get attribute value by local name
            const getAttr = (obj: any, localName: string): string => {
                const key = Object.keys(obj).find((k: string) => k === localName || k.endsWith(':' + localName));
                return key ? (obj[key] || '') : '';
            };

            const name = getAttr(attrs, 'name');
            const description = getAttr(attrs, 'description');
            const responsible = getAttr(attrs, 'responsible');
            const language = getAttr(attrs, 'language');
            const changedAt = getAttr(attrs, 'changedAt');
            const changedBy = getAttr(attrs, 'changedBy');

            // Package
            const pkgKey = Object.keys(root).find((k: string) => k.endsWith(':packageRef') || k === 'packageRef');
            const pkgName = pkgKey ? getAttr(root[pkgKey]._attributes || {}, 'name') : '';

            // Messages
            const msgKey = Object.keys(root).find((k: string) => k.endsWith(':messages') || k === 'messages');
            let messages: any[] = [];
            if (msgKey) {
                const raw = root[msgKey];
                messages = Array.isArray(raw) ? raw : [raw];
            }

            const lines: string[] = [];
            lines.push(`Message Class: ${name}`);
            if (description) lines.push(`Description: ${description}`);
            if (pkgName) lines.push(`Package: ${pkgName}`);
            if (responsible) lines.push(`Responsible: ${responsible}`);
            if (language) lines.push(`Language: ${language}`);
            if (changedAt) {
                const dateStr = changedAt.replace('T', ' ').replace('Z', ' UTC').substring(0, 20);
                lines.push(`Last Changed: ${dateStr} by ${changedBy}`);
            }
            lines.push('');
            lines.push(`Messages (${messages.length} total):`);

            for (const msg of messages) {
                const mAttrs = msg._attributes || {};
                const msgno = getAttr(mAttrs, 'msgno');
                const msgtext = getAttr(mAttrs, 'msgtext');
                if (msgno !== undefined) {
                    lines.push(`  ${msgno} | ${msgtext || '(no text)'}`);
                }
            }

            return {
                content: [{ type: 'text', text: lines.join('\n') }]
            };
        } catch (parseError) {
            // Fallback: return raw XML if parsing fails
            return {
                content: [{ type: 'text', text: xmlData }]
            };
        }
    } catch (error) {
        return return_error(error);
    }
}