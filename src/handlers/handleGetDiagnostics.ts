import { McpError, ErrorCode, return_error } from '../lib/utils';
import { handleGetRuntimeDumps } from './handleGetRuntimeDumps';
import { handleGetABAPTraces } from './handleGetABAPTraces';
import { handleGetGatewayErrorLog } from './handleGetGatewayErrorLog';

const RESOURCES = ['DUMP', 'TRACE', 'GW_ERRORLOG'];

export async function handleGetDiagnostics(args: any) {
    try {
        const resource = args?.resource ? String(args.resource).toUpperCase() : '';
        const { resource: _r, ...rest } = args ?? {};
        switch (resource) {
            case 'DUMP':
                return await handleGetRuntimeDumps(rest);
            case 'TRACE':
                return await handleGetABAPTraces(rest);
            case 'GW_ERRORLOG':
                return await handleGetGatewayErrorLog(rest);
            default:
                throw new McpError(ErrorCode.InvalidParams, `Invalid resource "${args?.resource}". Must be one of: ${RESOURCES.join(', ')}.`);
        }
    } catch (error) {
        return return_error(error);
    }
}
