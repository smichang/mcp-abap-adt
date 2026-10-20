import { McpError, ErrorCode, return_error } from '../lib/utils';
import { handleGetRuntimeDumps } from './handleGetRuntimeDumps';
import { handleGetABAPTraces } from './handleGetABAPTraces';
import { handleGetGatewayErrorLog } from './handleGetGatewayErrorLog';
import { maybeBackground } from '../lib/background';

const RESOURCES = ['DUMP', 'TRACE', 'GW_ERRORLOG'];

export async function handleGetDiagnostics(args: any) {
    try {
        const resource = args?.resource ? String(args.resource).toUpperCase() : '';
        const { resource: _r, ...rest } = args ?? {};
        // output_file / background (shared contract, lib/background.ts): until 2026-10-19 these were
        // neither in the schema nor honoured, so a requested evidence file was silently not written.
        const id = String(rest.dump_id || rest.trace_id || rest.entry_id || 'list');
        const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(-60);
        switch (resource) {
            case 'DUMP':
                return await maybeBackground(rest, `GetDiagnostics DUMP ${id}`, `dump-${slug(id)}`, () => handleGetRuntimeDumps(rest));
            case 'TRACE':
                return await maybeBackground(rest, `GetDiagnostics TRACE ${id}`, `trace-${slug(id)}`, () => handleGetABAPTraces(rest));
            case 'GW_ERRORLOG':
                return await maybeBackground(rest, `GetDiagnostics GW_ERRORLOG ${id}`, `gw-errorlog-${slug(id)}`, () => handleGetGatewayErrorLog(rest));
            default:
                throw new McpError(ErrorCode.InvalidParams, `Invalid resource "${args?.resource}". Must be one of: ${RESOURCES.join(', ')}.`);
        }
    } catch (error) {
        return return_error(error);
    }
}
