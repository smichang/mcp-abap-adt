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

/** Get text content of a child element by local name (ignores namespace prefix). */
function childText(parent: any, localName: string): string {
    const key = Object.keys(parent).find(k => k === localName || k.endsWith(`:${localName}`));
    if (!key) return '';
    const node = parent[key];
    return node?._text ? (node._text as string).trim() : '';
}

/** Get attribute value by local name (ignores namespace prefix). */
function attrValue(attrs: any, localName: string): string {
    const key = Object.keys(attrs).find(k => k === localName || k.endsWith(`:${localName}`));
    return key ? (attrs[key] as string) : '';
}

/**
 * Parse the blue:wbobj XML returned by the data element / domain endpoint.
 * Returns a compact human-readable string, or null if parsing fails.
 */
function parseWbobjXml(xmlData: string, typeName: string): string | null {
    try {
        if (typeof xmlData !== 'string' || !xmlData.trim().startsWith('<')) return null;
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find(k => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];
        const attrs = root._attributes || {};

        const lines: string[] = [];

        // Root-level attributes
        const name = attrValue(attrs, 'name') || typeName;
        const type = attrValue(attrs, 'type');
        const description = attrValue(attrs, 'description');
        const changedAt = attrValue(attrs, 'changedAt');

        lines.push(`Name: ${name}`);
        if (type) lines.push(`Type: ${type}`);
        if (description) lines.push(`Description: ${description}`);

        // Package reference
        const pkgRefKey = Object.keys(root).find(k => k.endsWith(':packageRef') || k === 'packageRef');
        if (pkgRefKey) {
            const pkgAttrs = root[pkgRefKey]._attributes || {};
            const pkgName = attrValue(pkgAttrs, 'name');
            const pkgDesc = attrValue(pkgAttrs, 'description');
            if (pkgName) lines.push(`Package: ${pkgName}${pkgDesc ? ` (${pkgDesc})` : ''}`);
        }

        // Data element details (dtel:dataElement)
        const dtelKey = Object.keys(root).find(k => k.endsWith(':dataElement') || k === 'dataElement');
        if (dtelKey) {
            const dtel = root[dtelKey];

            const dataType = childText(dtel, 'dataType');
            const dataTypeLength = childText(dtel, 'dataTypeLength');
            const dataTypeDecimals = childText(dtel, 'dataTypeDecimals');
            const typeKind = childText(dtel, 'typeKind');
            const refTypeName = childText(dtel, 'typeName');

            if (dataType) {
                const len = parseInt(dataTypeLength || '0', 10);
                const dec = parseInt(dataTypeDecimals || '0', 10);
                let typeStr = dataType;
                if (len > 0) {
                    typeStr += dec > 0 ? `(${len},${dec})` : `(${len})`;
                }
                lines.push(`Data Type: ${typeStr}`);
            }

            if (typeKind && refTypeName) {
                const kindLabel = typeKind.charAt(0).toUpperCase() + typeKind.slice(1);
                lines.push(`${kindLabel}: ${refTypeName}`);
            }

            // Field labels (deduplicate)
            const shortLabel = childText(dtel, 'shortFieldLabel');
            const mediumLabel = childText(dtel, 'mediumFieldLabel');
            const longLabel = childText(dtel, 'longFieldLabel');
            const headingLabel = childText(dtel, 'headingFieldLabel');
            const uniqueLabels = [...new Set([shortLabel, mediumLabel, longLabel, headingLabel].filter(Boolean))];
            if (uniqueLabels.length > 0) lines.push(`Labels: ${uniqueLabels.join(' / ')}`);

            const searchHelp = childText(dtel, 'searchHelp');
            if (searchHelp) lines.push(`Search Help: ${searchHelp}`);

            const setGetParam = childText(dtel, 'setGetParameter');
            if (setGetParam) lines.push(`Set/Get Parameter: ${setGetParam}`);
        }

        if (changedAt) lines.push(`Last Changed: ${changedAt.split('T')[0]}`);

        return lines.length > 1 ? lines.join('\n') : null;
    } catch (e) {
        return null;
    }
}

export async function handleGetTypeInfo(args: any) {
    try {
        if (!args?.type_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Type name is required');
        }
    } catch (error) {
        return return_error(error);
    }

    const typeName = (args.type_name as string).toUpperCase();
    const enc = encodeURIComponent(typeName);
    const baseUrl = await getBaseUrl();

    // 1. Domain
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/domains/${enc}/source/main`, 'GET', 30000);
        const simplified = parseWbobjXml(response.data, typeName);
        if (simplified) return { isError: false, content: [{ type: 'text', text: simplified }] };
        return return_response(response);
    } catch { /* try next */ }

    // 2. Data element
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/dataelements/${enc}`, 'GET', 30000);
        const simplified = parseWbobjXml(response.data, typeName);
        if (simplified) return { isError: false, content: [{ type: 'text', text: simplified }] };
        return return_response(response);
    } catch { /* try next */ }

    // 3. Structure (DDL source — SAP also serves transparent tables from this endpoint)
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/structures/${enc}/source/main`, 'GET', 30000);
        const ddl: string = response.data ?? '';
        const kind = /define\s+table\b/i.test(ddl) ? 'Table' : 'Structure';
        return { isError: false, content: [{ type: 'text', text: `[${kind}: ${typeName}]\n${ddl}` }] };
    } catch { /* try next */ }

    // 4. Table (DDL source — fallback for tables not served by the structure endpoint)
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/tables/${enc}/source/main`, 'GET', 30000);
        return { isError: false, content: [{ type: 'text', text: `[Table: ${typeName}]\n${response.data}` }] };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Type '${typeName}' not found in domain, data element, structure, or table.\nReason: ${errMsg}` }] };
        }
        return { isError: true, content: [{ type: 'text', text: `Type '${typeName}' not found in domain, data element, structure, or table.` }] };
    }
}