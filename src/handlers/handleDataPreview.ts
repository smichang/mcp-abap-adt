import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { maybeBackground } from '../lib/background';

/**
 * Handler for DataPreview tool - previews table/view/CDS data via ADT REST API
 * Parses column-oriented dataPreview XML into a readable table format
 */
export async function handleDataPreview(args: any) {
    const target = args?.table_name ? String(args.table_name).toUpperCase()
        : args?.ddicEntityName ? String(args.ddicEntityName).toUpperCase() : 'query';
    const slug = `datapreview-${target}`;
    return maybeBackground(args, `DataPreview for ${target}`, slug, () => dataPreviewCore(args));
}

async function dataPreviewCore(args: any) {
    try {
        if (!args?.table_name && !args?.ddicEntityName && !args?.query) {
            throw new McpError(ErrorCode.InvalidParams, 'table_name or query is required');
        }

        const tableName = (args.table_name || args.ddicEntityName || '').toUpperCase();
        const maxRows = args.max_rows || args.rowNumber || 100;
        const sqlQuery = args.query;
        const baseUrl = await getBaseUrl();

        let xmlData: string | null = null;
        let modeLabel = '';

        if (sqlQuery) {
            // Custom SQL query → use freestyle endpoint directly
            try {
                const url = `${baseUrl}/sap/bc/adt/datapreview/freestyle?rowNumber=${maxRows}`;
                const response = await makeAdtRequest(url, 'POST', 30000, sqlQuery, undefined, { 'Accept': 'application/*', 'Content-Type': 'text/plain' });
                xmlData = response.data ?? response;
                if (typeof xmlData !== 'string') xmlData = String(xmlData);
                modeLabel = 'Freestyle SQL';
            } catch (err1) {
                try {
                    const url = `${baseUrl}/sap/bc/adt/datapreview/freestyle`;
                    const response = await makeAdtRequest(url, 'POST', 30000, sqlQuery, undefined, { 'Accept': 'application/*', 'Content-Type': 'text/plain' });
                    xmlData = response.data ?? response;
                    if (typeof xmlData !== 'string') xmlData = String(xmlData);
                    modeLabel = 'Freestyle SQL';
                } catch (err2) {
                    if (err2 instanceof AxiosError && err2.response?.data) {
                        const errMsg = parseAdtErrorXml(String(err2.response.data));
                        if (errMsg) {
                            return {
                                isError: true,
                                content: [{ type: 'text', text: `DataPreview SQL failed.\nReason: ${errMsg}` }]
                            };
                        }
                    }
                    return return_error(err2);
                }
            }
        } else {
            // Table preview → try DDIC mode first, then freestyle fallback
            try {
                const url = `${baseUrl}/sap/bc/adt/datapreview/ddic?ddicEntityName=${encodeURIComponent(tableName)}&rowNumber=${maxRows}`;
                const response = await makeAdtRequest(url, 'POST', 30000, '', undefined, { 'Accept': 'application/*' });
                xmlData = response.data ?? response;
                if (typeof xmlData !== 'string') xmlData = String(xmlData);
                modeLabel = 'DDIC';
            } catch (err1) {
                try {
                    const sqlStr = `SELECT * FROM ${tableName}`;
                    const url = `${baseUrl}/sap/bc/adt/datapreview/freestyle?rowNumber=${maxRows}`;
                    const response = await makeAdtRequest(url, 'POST', 30000, sqlStr, undefined, { 'Accept': 'application/*' });
                    xmlData = response.data ?? response;
                    if (typeof xmlData !== 'string') xmlData = String(xmlData);
                    modeLabel = 'Freestyle SQL';
                } catch (err2) {
                    try {
                        const sqlStr = `SELECT * FROM ${tableName} UP TO ${maxRows} ROWS`;
                        const url = `${baseUrl}/sap/bc/adt/datapreview/freestyle`;
                        const response = await makeAdtRequest(url, 'POST', 30000, sqlStr, undefined, { 'Accept': 'application/*' });
                        xmlData = response.data ?? response;
                        if (typeof xmlData !== 'string') xmlData = String(xmlData);
                        modeLabel = 'Freestyle SQL';
                    } catch (err3) {
                        if (err3 instanceof AxiosError && err3.response?.data) {
                            const errMsg = parseAdtErrorXml(String(err3.response.data));
                            if (errMsg) {
                                return {
                                    isError: true,
                                    content: [{ type: 'text', text: `DataPreview failed for '${tableName}'.\nReason: ${errMsg}` }]
                                };
                            }
                        }
                        return {
                            isError: true,
                            content: [{
                                type: 'text',
                                text: `DataPreview is not available for '${tableName}'.\n\n` +
                                    `Possible causes:\n` +
                                    `  - Missing authorization (S_TABU_NAM, S_TABU_DIS)\n` +
                                    `  - SAP NetWeaver < 7.50\n` +
                                    `  - Object does not exist`
                            }]
                        };
                    }
                }
            }
        }

        if (!xmlData) {
            return {
                isError: true,
                content: [{ type: 'text', text: `DataPreview returned no data for '${tableName}'.` }]
            };
        }

        // Parse dataPreview XML into table format
        try {
            const convert = require('xml-js');
            const parsed = convert.xml2js(xmlData, { compact: true }) as any;

            // Find root: dataPreview:tableData or tableData
            const rootKey = Object.keys(parsed).find((k: string) => k.endsWith(':tableData') || k === 'tableData');
            if (!rootKey) throw new Error('No tableData element found');
            const tableData = parsed[rootKey];

            // Helper: get text value from a node
            const getText = (obj: any, localName: string): string => {
                const key = Object.keys(obj).find((k: string) => k === localName || k.endsWith(':' + localName));
                if (!key) return '';
                const node = obj[key];
                if (node?._text !== undefined) return String(node._text).trim();
                return '';
            };

            const totalRows = getText(tableData, 'totalRows');
            const execTime = getText(tableData, 'queryExecutionTime');

            // Find columns - may be dataPreview:columns array directly, or a container with column children
            const colsKey = Object.keys(tableData).find((k: string) => k.endsWith(':columns') || k === 'columns');
            if (!colsKey) throw new Error('No columns element found');
            const colsRaw = tableData[colsKey];

            // Determine if colsRaw is the columns array itself, or a container with column children
            let columns: any[];
            if (Array.isArray(colsRaw)) {
                // dataPreview:columns is already an array of column objects
                columns = colsRaw;
            } else if (colsRaw && typeof colsRaw === 'object') {
                // Check if it has metadata/dataSet directly → it IS a single column
                const hasMetaOrData = Object.keys(colsRaw).some((k: string) =>
                    k.endsWith(':metadata') || k === 'metadata' ||
                    k.endsWith(':dataSet') || k === 'dataSet'
                );
                if (hasMetaOrData) {
                    columns = [colsRaw];
                } else {
                    // Look for a column child element
                    const colKey = Object.keys(colsRaw).find((k: string) => k.endsWith(':column') || k === 'column');
                    if (!colKey) {
                        return {
                            isError: false,
                            content: [{ type: 'text', text: `Table: ${tableName}\nNo columns found in response.` }]
                        };
                    }
                    const inner = colsRaw[colKey];
                    columns = Array.isArray(inner) ? inner : [inner];
                }
            } else {
                return {
                    isError: false,
                    content: [{ type: 'text', text: `Table: ${tableName}\nNo columns found in response.` }]
                };
            }

            // Extract column metadata and data
            interface ColInfo {
                name: string;
                description: string;
                type: string;
                values: string[];
            }

            const colInfos: ColInfo[] = [];
            for (const col of columns) {
                // Metadata attributes
                const metaKey = Object.keys(col).find((k: string) => k.endsWith(':metadata') || k === 'metadata');
                let colName = '';
                let colDesc = '';
                let colType = '';
                if (metaKey) {
                    const meta = col[metaKey];
                    const attrs = meta._attributes || {};
                    colName = attrs.name || attrs['adtcore:name'] || '';
                    colDesc = attrs.description || attrs['adtcore:description'] || '';
                    colType = attrs.type || attrs['adtcore:type'] || '';
                    // Fallback: search attrs by local name
                    if (!colName) {
                        const nameAttrKey = Object.keys(attrs).find((k: string) => k === 'name' || k.endsWith(':name'));
                        if (nameAttrKey) colName = attrs[nameAttrKey] || '';
                    }
                    if (!colDesc) {
                        const descAttrKey = Object.keys(attrs).find((k: string) => k === 'description' || k.endsWith(':description'));
                        if (descAttrKey) colDesc = attrs[descAttrKey] || '';
                    }
                }

                // Data values (column-oriented)
                const dataSetKey = Object.keys(col).find((k: string) => k.endsWith(':dataSet') || k === 'dataSet');
                let values: string[] = [];
                if (dataSetKey) {
                    const dataSet = col[dataSetKey];
                    const dataKey = Object.keys(dataSet).find((k: string) => k.endsWith(':data') || k === 'data');
                    if (dataKey) {
                        const rawData = dataSet[dataKey];
                        const dataArr: any[] = Array.isArray(rawData) ? rawData : [rawData];
                        values = dataArr.map((d: any) => {
                            if (d?._text !== undefined) return String(d._text);
                            if (typeof d === 'string') return d;
                            return '';
                        });
                    }
                }

                colInfos.push({ name: colName, description: colDesc, type: colType, values });
            }

            if (colInfos.length === 0) {
                return {
                    isError: false,
                    content: [{ type: 'text', text: `Table: ${tableName}\nNo column data found.` }]
                };
            }

            // SAP's /datapreview/ddic endpoint treats rowNumber as an inclusive 0-based index
            // (rowNumber=3 returns 4 rows) rather than a count — verified live. Clamp here so
            // the tool always honors max_rows as a count regardless of that off-by-one.
            const requestedMax = Math.max(1, Math.floor(Number(maxRows)) || 100);
            for (const c of colInfos) {
                if (c.values.length > requestedMax) c.values = c.values.slice(0, requestedMax);
            }

            // Determine row count from data
            const rowCount = Math.max(...colInfos.map((c) => c.values.length), 0);

            // Calculate column widths (header vs data)
            const colWidths = colInfos.map((c) => {
                const headerLen = c.name.length;
                const maxDataLen = c.values.reduce((m, v) => Math.max(m, v.length), 0);
                return Math.min(50, Math.max(headerLen, maxDataLen, 3));
            });

            const lines: string[] = [];
            const displayName = getText(tableData, 'name') || tableName;
            const rowsDisplay = (totalRows && totalRows !== '0') ? totalRows : String(rowCount);
            lines.push(`Table: ${displayName}  |  Rows: ${rowsDisplay}${execTime ? `  |  Query time: ${execTime}ms` : ''}`);
            lines.push('');

            // Header row
            const header = colInfos.map((c, i) => c.name.padEnd(colWidths[i])).join('  ');
            const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');
            lines.push(header);
            lines.push(separator);

            // Data rows (transpose from column-oriented to row-oriented)
            if (rowCount === 0) {
                lines.push('(no data)');
            } else {
                for (let row = 0; row < rowCount; row++) {
                    const rowLine = colInfos.map((c, i) => {
                        const val = c.values[row] ?? '';
                        return val.padEnd(colWidths[i]);
                    }).join('  ');
                    lines.push(rowLine);
                }
            }

            lines.push('');
            const totalInfo = (totalRows && totalRows !== '0' && totalRows !== String(rowCount)) ? `, ${totalRows} total` : '';
            lines.push(`[${modeLabel} | ${rowCount} row(s) displayed${totalInfo}]`);

            return {
                isError: false,
                content: [{ type: 'text', text: lines.join('\n') }]
            };
        } catch (parseError) {
            // Fallback: return raw XML if parsing fails
            return {
                isError: false,
                content: [{ type: 'text', text: `[DataPreview - ${modeLabel}]\n${xmlData}` }]
            };
        }
    } catch (error) {
        return return_error(error);
    }
}