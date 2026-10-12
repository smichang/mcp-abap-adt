import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import convert from 'xml-js';
import { AxiosError } from 'axios';

/**
 * Query TSTC table to get the program name (PGMNA) and screen number (DYPNO)
 * linked to a transaction code. Uses the DataPreview freestyle SQL endpoint.
 */
async function fetchProgramFromTstc(baseUrl: Buffer, transactionName: string): Promise<{ program?: string; screen?: string }> {
    try {
        const sql = `SELECT PGMNA, DYPNO FROM TSTC WHERE TCODE = '${transactionName}'`;
        const url = `${baseUrl}/sap/bc/adt/datapreview/freestyle?rowNumber=1`;
        const response = await makeAdtRequest(url, 'POST', 15000, sql);
        const xmlData = response.data ?? response;
        if (typeof xmlData !== 'string' || !xmlData.trim().startsWith('<')) return {};

        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) return {};
        const tableData = parsed[rootKey];

        // dataPreview:columns is an array of column objects
        const colsKey = Object.keys(tableData).find((k: string) => k.endsWith(':columns') || k === 'columns');
        if (!colsKey) return {};
        const colsRaw = tableData[colsKey];
        const columns: any[] = Array.isArray(colsRaw) ? colsRaw : [colsRaw];

        const result: { program?: string; screen?: string } = {};
        for (const col of columns) {
            const metaKey = Object.keys(col).find((k: string) => k.endsWith(':metadata') || k === 'metadata');
            const dataSetKey = Object.keys(col).find((k: string) => k.endsWith(':dataSet') || k === 'dataSet');
            if (!metaKey || !dataSetKey) continue;

            const metaAttrs = col[metaKey]._attributes || {};
            const colName: string = Object.entries(metaAttrs).find(([k]) => k === 'name' || k.endsWith(':name'))?.[1] as string || '';
            const dataSet = col[dataSetKey];
            const dataKey = Object.keys(dataSet).find((k: string) => k.endsWith(':data') || k === 'data');
            if (!dataKey) continue;
            const rawData = dataSet[dataKey];
            const value: string = rawData?._text !== undefined ? String(rawData._text).trim()
                : Array.isArray(rawData) ? String(rawData[0]?._text ?? '').trim()
                : '';

            if (colName === 'PGMNA' && value) result.program = value;
            if (colName === 'DYPNO' && value) result.screen = value;
        }
        return result;
    } catch (_) {
        return {};
    }
}

export async function handleGetTransaction(args: any) {
    try {
        if (!args?.transaction_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Transaction name is required');
        }
        const transactionName = args.transaction_name.toUpperCase();
        const encodedTransactionName = encodeURIComponent(transactionName);
        const baseUrl = await getBaseUrl();
        const propsUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=%2Fsap%2Fbc%2Fadt%2Fvit%2Fwb%2Fobject_type%2Ftrant%2Fobject_name%2F${encodedTransactionName}&facet=package&facet=appl`;

        let response: any;
        try {
            response = await makeAdtRequest(propsUrl, 'GET', 30000);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Transaction '${transactionName}' not found or inaccessible.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }

        // Query TSTC for program name and screen number (best-effort).
        const programInfo = await fetchProgramFromTstc(baseUrl, transactionName);

        try {
            const xmlData = response.data;
            if (typeof xmlData === 'string' && xmlData.trim().startsWith('<')) {
                const parsed = convert.xml2js(xmlData, { compact: true }) as any;
                const lines: string[] = [];

                const rootKey = Object.keys(parsed).find(k => !k.startsWith('_'));
                if (rootKey) {
                    const root = parsed[rootKey];

                    const objectKey = Object.keys(root).find(k => k.endsWith(':object') || k === 'object');
                    if (objectKey) {
                        const attrs = root[objectKey]._attributes || {};
                        lines.push(`Transaction: ${attrs.name || transactionName}`);
                        if (attrs.text) lines.push(`Description: ${attrs.text}`);
                        if (attrs.type) lines.push(`Type: ${attrs.type}`);
                    } else {
                        lines.push(`Transaction: ${transactionName}`);
                    }

                    if (programInfo.program) lines.push(`Program: ${programInfo.program}`);
                    if (programInfo.screen) lines.push(`Screen: ${programInfo.screen}`);

                    const propertyKey = Object.keys(root).find(k => k.endsWith(':property') || k === 'property');
                    if (propertyKey) {
                        const properties = Array.isArray(root[propertyKey]) ? root[propertyKey] : [root[propertyKey]];

                        const facetMap: Record<string, string[]> = {};
                        for (const prop of properties) {
                            const attrs = prop._attributes || {};
                            const facet = (attrs.facet as string)?.toUpperCase();
                            const name = attrs.name as string;
                            const text = attrs.text as string;
                            if (facet && name) {
                                if (!facetMap[facet]) facetMap[facet] = [];
                                facetMap[facet].push(text ? `${name} (${text})` : name);
                            }
                        }

                        const facetLabels: Record<string, string> = {
                            PACKAGE: 'Package',
                            APPL: 'Application',
                        };
                        for (const [facet, values] of Object.entries(facetMap)) {
                            const label = facetLabels[facet] || facet;
                            lines.push(`${label}: ${values.join(', ')}`);
                        }
                    }
                }

                if (lines.length > 0) {
                    return {
                        isError: false,
                        content: [{ type: 'text', text: lines.join('\n') }]
                    };
                }
            }
        } catch (parseError) {
            // XML parsing failed, fall through to return raw response
        }

        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}
