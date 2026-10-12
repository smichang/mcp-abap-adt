import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

export async function handleGetInterface(args: any) {
    try {
        if (!args?.interface_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Interface name is required');
        }
        const interfaceName = args.interface_name.toUpperCase();
        const encodedInterfaceName = encodeURIComponent(interfaceName);
        const url = `${await getBaseUrl()}/sap/bc/adt/oo/interfaces/${encodedInterfaceName}/source/main`;

        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            return return_response(response);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Interface '${interfaceName}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }
    } catch (error) {
        return return_error(error);
    }
}