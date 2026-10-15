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

        // Optional language: texts are read in that language via the sap-language header.
        // Only /messageclass honours it, and unknown ISO codes silently fall back to the
        // logon language, so the language SAP answered in is checked below.
        const requestedLang = args.language ? String(args.language).toUpperCase() : '';
        if (requestedLang && !/^[A-Z0-9]{2}$/.test(requestedLang)) {
            throw new McpError(ErrorCode.InvalidParams, `language must be a 2-character ISO code such as EN, DE or ZF (got '${args.language}')`);
        }
        const readHeaders = requestedLang ? { 'Accept': 'application/vnd.sap.adt.mc.messageclass+xml', 'sap-language': requestedLang } : undefined;

        // Try primary endpoint, fall back to alternative
        const endpoints = requestedLang
            ? [`${baseUrl}/sap/bc/adt/messageclass/${encodeURIComponent(messageClass)}`]
            : [
                `${baseUrl}/sap/bc/adt/vit/msgclass/${encodeURIComponent(messageClass)}`,
                `${baseUrl}/sap/bc/adt/messageclass/${encodeURIComponent(messageClass)}`
            ];

        let xmlData: string | null = null;
        let lastError: any = null;
        for (const url of endpoints) {
            try {
                const response = await makeAdtRequest(url, 'GET', 30000, undefined, undefined, readHeaders);
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
            if (requestedLang && language.toUpperCase() !== requestedLang) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Message class '${messageClass}': SAP answered in '${language || '?'}', not ${requestedLang} — is the language installed? Texts not shown.` }]
                };
            }
            const master = await masterLanguageIso(String(baseUrl), messageClass);
            // SAP echoes the requested language even when it holds no texts in it and serves the
            // master texts instead, so count the real T100 rows.
            if (requestedLang && master && requestedLang !== master) {
                const have = await translatedCount(String(baseUrl), messageClass, requestedLang);
                if (have === 0) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Message class '${messageClass}' has no texts in ${requestedLang} (master ${master}); SAP would only fall back to the master texts. Not shown.` }]
                    };
                }
                if (have !== null && have < messages.length) {
                    lines.push(`Note: only ${have} of ${messages.length} messages are translated to ${requestedLang}; the others show the master-language text.`);
                }
            }
            if (master) lines.push(`Master language: ${master}${requestedLang && requestedLang !== master ? ' (showing translation)' : ''}`);
            if (changedAt) {
                const dateStr = changedAt.replace('T', ' ').replace('Z', ' UTC').substring(0, 20);
                lines.push(`Last Changed: ${dateStr} by ${changedBy}`);
            }
            lines.push('');
            // Paged like every other list tool: class 00 has 927 messages (~35 KB) and a custom class can be
            // as big — the whole list went to the caller's context on every read.
            const offset = Number.isFinite(Number(args?.offset)) && Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0;
            const limit = Number.isFinite(Number(args?.max_results)) && Number(args.max_results) > 0 ? Math.floor(Number(args.max_results)) : 200;
            const window = messages.slice(offset, offset + limit);
            lines.push(window.length < messages.length
                ? `Messages (${messages.length} total, showing ${window.length} from offset ${offset}):`
                : `Messages (${messages.length} total):`);

            for (const msg of window) {
                const mAttrs = msg._attributes || {};
                const msgno = getAttr(mAttrs, 'msgno');
                const msgtext = getAttr(mAttrs, 'msgtext');
                if (msgno !== undefined) {
                    lines.push(`  ${msgno} | ${msgtext || '(no text)'}`);
                }
            }
            if (offset + limit < messages.length) {
                lines.push(`… ${messages.length - offset - limit} more — next page: offset=${offset + limit} (max_results=${limit}).`);
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

/** True master language (T100A-MASTERLANG as ISO); ADT's own masterLanguage attribute is unreliable. Non-fatal. */
async function masterLanguageIso(baseUrl: string, name: string): Promise<string> {
    if (!/^[A-Z0-9_/]+$/.test(name)) return '';
    try {
        const sql = `SELECT s~laiso FROM t100a AS t INNER JOIN t002 AS s ON s~spras = t~masterlang WHERE t~arbgb = '${name}'`;
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/datapreview/freestyle`, 'POST', 15000, sql, { rowNumber: 1 },
            { 'Accept': 'application/*', 'Content-Type': 'text/plain' });
        const xml = String(response.data || '');
        const m = xml.match(/<dataPreview:data>([^<]*)<\/dataPreview:data>/);
        return m ? m[1].trim().toUpperCase() : '';
    } catch (_e) {
        return '';
    }
}

/** Number of T100 rows of the class in an ISO language; null when the lookup fails. */
async function translatedCount(baseUrl: string, name: string, iso: string): Promise<number | null> {
    if (!/^[A-Z0-9_/]+$/.test(name) || !/^[A-Z0-9]{2}$/.test(iso)) return null;
    try {
        const sql = `SELECT t~msgnr FROM t100 AS t INNER JOIN t002 AS s ON s~spras = t~sprsl WHERE t~arbgb = '${name}' AND s~laiso = '${iso}'`;
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/datapreview/freestyle`, 'POST', 15000, sql, { rowNumber: 1000 },
            { 'Accept': 'application/*', 'Content-Type': 'text/plain' });
        const m = String(response.data || '').match(/<dataPreview:totalRows>\s*(\d+)/);
        return m ? Number(m[1]) : null;
    } catch (_e) {
        return null;
    }
}
