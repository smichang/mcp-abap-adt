import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

type DdicType = 'CDS' | 'DATA_ELEMENT' | 'DOMAIN';

async function fetchXml(urls: string[], label: string): Promise<{ xml: string } | { error: string }> {
    let lastError: any = null;
    for (const url of urls) {
        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            const xml = response.data ?? response;
            return { xml: typeof xml === 'string' ? xml : String(xml) };
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError instanceof AxiosError && lastError.response?.data) {
        const errMsg = parseAdtErrorXml(String(lastError.response.data));
        if (errMsg) return { error: `'${label}' not found.\nReason: ${errMsg}` };
    }
    return { error: String(lastError) };
}

function getAttr(obj: any, localName: string): string {
    const key = Object.keys(obj).find((k: string) => k === localName || k.endsWith(':' + localName));
    return key ? (obj[key] || '') : '';
}

function childText(parent: any, localName: string): string {
    const key = Object.keys(parent).find((k: string) => k === localName || k.endsWith(':' + localName));
    if (!key) return '';
    const node = parent[key];
    return node?._text ? String(node._text).trim() : '';
}

function childNode(parent: any, localName: string): any {
    const key = Object.keys(parent).find((k: string) => k === localName || k.endsWith(':' + localName));
    return key ? parent[key] : null;
}

async function handleCDS(name: string) {
    const baseUrl = await getBaseUrl();
    const result = await fetchXml([
        `${baseUrl}/sap/bc/adt/ddic/ddl/sources/${encodeURIComponent(name)}/source/main`,
        `${baseUrl}/sap/bc/adt/ddic/ddl/sources/${encodeURIComponent(name)}`
    ], name);
    if ('error' in result) return { isError: true, content: [{ type: 'text', text: result.error }] };
    return { isError: false, content: [{ type: 'text', text: result.xml }] };
}

async function handleDataElement(name: string) {
    const baseUrl = await getBaseUrl();
    const result = await fetchXml([
        `${baseUrl}/sap/bc/adt/ddic/dataelements/${encodeURIComponent(name)}/source/main`,
        `${baseUrl}/sap/bc/adt/ddic/dataelements/${encodeURIComponent(name)}`
    ], name);
    if ('error' in result) return { isError: true, content: [{ type: 'text', text: result.error }] };
    const xmlData = result.xml;

    try {
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) throw new Error('Unexpected XML structure');
        const root = parsed[rootKey];
        const attrs = root._attributes || {};

        const objName = getAttr(attrs, 'name');
        const description = getAttr(attrs, 'description');
        const changedAt = getAttr(attrs, 'changedAt');
        const changedBy = getAttr(attrs, 'changedBy');

        const pkgKey = Object.keys(root).find((k: string) => k.endsWith(':packageRef') || k === 'packageRef');
        const pkgAttrs = pkgKey ? (root[pkgKey]._attributes || {}) : {};
        const pkgName = getAttr(pkgAttrs, 'name');
        const pkgDesc = getAttr(pkgAttrs, 'description');

        const dtelKey = Object.keys(root).find((k: string) => k.endsWith(':dataElement') || k === 'dataElement');
        const dtel = dtelKey ? root[dtelKey] : {};

        const typeKind = childText(dtel, 'typeKind');
        const typeName = childText(dtel, 'typeName');
        const dataType = childText(dtel, 'dataType');
        const dataTypeLength = childText(dtel, 'dataTypeLength');
        const dataTypeDecimals = childText(dtel, 'dataTypeDecimals');
        const shortLabel = childText(dtel, 'shortFieldLabel');
        const shortLen = childText(dtel, 'shortFieldLength');
        const mediumLabel = childText(dtel, 'mediumFieldLabel');
        const mediumLen = childText(dtel, 'mediumFieldLength');
        const longLabel = childText(dtel, 'longFieldLabel');
        const longLen = childText(dtel, 'longFieldLength');
        const headingLabel = childText(dtel, 'headingFieldLabel');
        const headingLen = childText(dtel, 'headingFieldLength');
        const searchHelp = childText(dtel, 'searchHelp');
        const searchHelpParam = childText(dtel, 'searchHelpParameter');
        const setGetParam = childText(dtel, 'setGetParameter');
        const defaultComp = childText(dtel, 'defaultComponentName');
        const changeDoc = childText(dtel, 'changeDocument');

        const lenNum = parseInt(dataTypeLength, 10) || 0;
        const decNum = parseInt(dataTypeDecimals, 10) || 0;
        let dataTypeStr = dataType;
        if (lenNum > 0) dataTypeStr += decNum > 0 ? `(${lenNum},${decNum})` : `(${lenNum})`;

        const lines: string[] = [];
        lines.push(`Data Element: ${objName}`);
        if (description) lines.push(`Description: ${description}`);
        if (pkgName) lines.push(`Package: ${pkgName}${pkgDesc ? ` (${pkgDesc})` : ''}`);
        if (changedAt) {
            const dateStr = changedAt.replace('T', ' ').replace('Z', ' UTC').substring(0, 20);
            lines.push(`Last Changed: ${dateStr} by ${changedBy}`);
        }
        lines.push('');
        if (dataTypeStr) lines.push(`Data Type: ${dataTypeStr}`);
        if (typeKind) lines.push(`Type Kind: ${typeKind}`);
        if (typeName) lines.push(`Domain/Type: ${typeName}`);
        if (defaultComp) lines.push(`Default Component: ${defaultComp}`);

        const labelLines: string[] = [];
        if (shortLabel) labelLines.push(`  Short:   ${shortLabel} (${shortLen})`);
        if (mediumLabel && mediumLabel !== shortLabel) labelLines.push(`  Medium:  ${mediumLabel} (${mediumLen})`);
        if (longLabel && longLabel !== mediumLabel) labelLines.push(`  Long:    ${longLabel} (${longLen})`);
        if (headingLabel && headingLabel !== longLabel) labelLines.push(`  Heading: ${headingLabel} (${headingLen})`);
        if (labelLines.length > 0) {
            lines.push('');
            lines.push('Labels:');
            lines.push(...labelLines);
        }

        if (searchHelp) lines.push('', `Search Help: ${searchHelp}${searchHelpParam ? ` (Parameter: ${searchHelpParam})` : ''}`);
        if (setGetParam) lines.push(`Set/Get Parameter: ${setGetParam}`);
        if (changeDoc === 'true') lines.push('Change Document: yes');

        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch {
        return { isError: false, content: [{ type: 'text', text: xmlData }] };
    }
}

async function handleDomain(name: string) {
    const baseUrl = await getBaseUrl();
    const result = await fetchXml([
        `${baseUrl}/sap/bc/adt/ddic/domains/${encodeURIComponent(name)}/source/main`,
        `${baseUrl}/sap/bc/adt/ddic/domains/${encodeURIComponent(name)}`
    ], name);
    if ('error' in result) return { isError: true, content: [{ type: 'text', text: result.error }] };
    const xmlData = result.xml;

    try {
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) throw new Error('Unexpected XML structure');
        const root = parsed[rootKey];
        const attrs = root._attributes || {};

        const objName = getAttr(attrs, 'name');
        const description = getAttr(attrs, 'description');
        const changedAt = getAttr(attrs, 'changedAt');
        const changedBy = getAttr(attrs, 'changedBy');

        const pkgKey = Object.keys(root).find((k: string) => k.endsWith(':packageRef') || k === 'packageRef');
        const pkgAttrs = pkgKey ? (root[pkgKey]._attributes || {}) : {};
        const pkgName = getAttr(pkgAttrs, 'name');
        const pkgDesc = getAttr(pkgAttrs, 'description');

        const content = childNode(root, 'content') || {};
        const typeInfo = childNode(content, 'typeInformation') || {};
        const outputInfo = childNode(content, 'outputInformation') || {};
        const valueInfo = childNode(content, 'valueInformation') || {};

        const dataType = childText(typeInfo, 'datatype');
        const typeLength = childText(typeInfo, 'length');
        const typeDecimals = childText(typeInfo, 'decimals');
        const outputLength = childText(outputInfo, 'length');
        const conversionExit = childText(outputInfo, 'conversionExit');
        const signExists = childText(outputInfo, 'signExists');
        const lowercase = childText(outputInfo, 'lowercase');

        const vtRef = childNode(valueInfo, 'valueTableRef');
        const valueTable = vtRef ? getAttr(vtRef._attributes || {}, 'name') : '';

        const fixValuesNode = childNode(valueInfo, 'fixValues');
        let fixValues: Array<{ low: string; high: string; text: string }> = [];
        if (fixValuesNode) {
            const fvKey = Object.keys(fixValuesNode).find((k: string) => k.endsWith(':fixValue') || k === 'fixValue');
            if (fvKey) {
                const raw = fixValuesNode[fvKey];
                const fvArr = Array.isArray(raw) ? raw : [raw];
                for (const fv of fvArr) {
                    fixValues.push({ low: childText(fv, 'low'), high: childText(fv, 'high'), text: childText(fv, 'text') });
                }
            }
        }

        const lenNum = parseInt(typeLength, 10) || 0;
        const decNum = parseInt(typeDecimals, 10) || 0;
        let dataTypeStr = dataType;
        if (lenNum > 0) dataTypeStr += decNum > 0 ? `(${lenNum},${decNum})` : `(${lenNum})`;

        const lines: string[] = [];
        lines.push(`Domain: ${objName}`);
        if (description) lines.push(`Description: ${description}`);
        if (pkgName) lines.push(`Package: ${pkgName}${pkgDesc ? ` (${pkgDesc})` : ''}`);
        if (changedAt) {
            const dateStr = changedAt.replace('T', ' ').replace('Z', ' UTC').substring(0, 20);
            lines.push(`Last Changed: ${dateStr} by ${changedBy}`);
        }
        lines.push('');
        if (dataTypeStr) lines.push(`Data Type: ${dataTypeStr}`);
        const outLen = parseInt(outputLength, 10) || 0;
        if (outLen > 0) lines.push(`Output Length: ${outLen}`);
        if (conversionExit) lines.push(`Conversion Exit: ${conversionExit}`);
        if (lowercase === 'true') lines.push('Lowercase: yes');
        if (signExists === 'true') lines.push('Sign: yes');
        if (valueTable) lines.push('', `Value Table: ${valueTable}`);

        if (fixValues.length > 0) {
            lines.push('', 'Fixed Values:');
            for (const fv of fixValues) {
                const range = fv.high ? `${fv.low} - ${fv.high}` : fv.low;
                lines.push(`  ${range.padEnd(10)} | ${fv.text}`);
            }
        }

        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch {
        return { isError: false, content: [{ type: 'text', text: xmlData }] };
    }
}

export async function handleGetDDICObject(args: any) {
    try {
        if (!args?.object_type) throw new McpError(ErrorCode.InvalidParams, 'object_type is required (CDS | DATA_ELEMENT | DOMAIN)');
        if (!args?.name) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const objectType = String(args.object_type).toUpperCase() as DdicType;
        const name = String(args.name).toUpperCase();

        switch (objectType) {
            case 'CDS':           return await handleCDS(name);
            case 'DATA_ELEMENT':  return await handleDataElement(name);
            case 'DOMAIN':        return await handleDomain(name);
            default:
                throw new McpError(ErrorCode.InvalidParams, `Unknown object_type '${objectType}'. Use CDS, DATA_ELEMENT, or DOMAIN.`);
        }
    } catch (error) {
        return return_error(error);
    }
}
