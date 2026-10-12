import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

export async function handleGetTable(args: any) {
    try {
        if (!args?.table_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
        }
        const tableName = args.table_name.toUpperCase();
        const url = `${await getBaseUrl()}/sap/bc/adt/ddic/tables/${encodeURIComponent(tableName)}/source/main`;

        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            return return_response(response);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Table '${tableName}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }
    } catch (error) {
        return return_error(error);
    }
}