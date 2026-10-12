import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';

export async function handleGetProgram(args: any) {
    try {
        if (!args?.program_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Program name is required');
        }
        const programName = args.program_name.toUpperCase();
        const url = `${await getBaseUrl()}/sap/bc/adt/programs/programs/${encodeURIComponent(programName)}/source/main`;

        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            return return_response(response);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Program '${programName}' not found.\nReason: ${errMsg}` }]
                    };
                }
            }
            return return_error(error);
        }
    } catch (error) {
        return return_error(error);
    }
}