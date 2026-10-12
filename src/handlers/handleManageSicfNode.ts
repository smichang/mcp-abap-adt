import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_response, return_error, getBaseUrl } from '../lib/utils';

// Talks to ZCL_HTTP_MCP_DISPATCH (package ZMCP), a standalone SICF service
// at default_host/zmcp/dispatch — NOT an ADT resource. Primary purpose:
// create/delete SICF nodes directly under default_host/zmcp
// (action=create_sicf_node|delete_sicf_node), via ZCL_MCP_SICF_ADMIN on the
// ABAP side — the one manual SICF step (this bootstrap node itself) never
// needs to happen again for a future ADT gap that needs its own node.
// Also exposes lightweight diagnostic actions (ping, echo_upper) proving the
// dispatch path itself, and forwards any future action added as a WHEN
// branch in ZCL_MCP_DISPATCH=>dispatch — this tool's `action`/`payload`
// pass-through never needs to change when a new ABAP-side action is added.
export async function handleManageSicfNode(args: any) {
    try {
        const action = args?.action ? String(args.action).toLowerCase() : '';
        const payload = args?.payload !== undefined && args.payload !== null ? String(args.payload) : '';
        const method = args?.method ? String(args.method).toUpperCase() : 'POST';

        if (!action) {
            throw new McpError(ErrorCode.InvalidParams, 'action is required');
        }
        if (!['GET', 'POST'].includes(method)) {
            throw new McpError(ErrorCode.InvalidParams, 'method must be "GET" or "POST"');
        }

        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/zmcp/dispatch`;

        const response = method === 'GET'
            ? await makeAdtRequest(url, 'GET', 15000, undefined, { action, payload })
            : await makeAdtRequest(url, 'POST', 15000, payload, { action }, {
                'Content-Type': 'text/plain; charset=utf-8'
            });

        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}
