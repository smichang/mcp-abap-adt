import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl } from '../lib/utils';
import { AxiosError } from 'axios';

// Talks to ZCL_HTTP_MCP_SESSION_ADMIN (default_host/zmcp/session_admin, package ZMCP): lists / ends the
// connection user's OWN HTTP (ADT) ABAP sessions on every application server. Stateless, one call
// each, so not behind the stateful-operation gate. All safety rules (own user only, HTTP only,
// not the current session, minimum age, fresh re-validation, never tid=-1) are enforced on the
// ABAP side; this handler only validates the shape of the arguments.
export async function handleManageSessions(args: any) {
    try {
        const action = args?.action ? String(args.action).toLowerCase() : '';
        if (action !== 'list' && action !== 'end') {
            throw new McpError(ErrorCode.InvalidParams, 'action must be "list" or "end"');
        }
        const params: Record<string, string> = { action };

        if (action === 'end') {
            const ids = Array.isArray(args?.ids) ? args.ids.map((i: any) => String(i).trim()).filter(Boolean) : [];
            if (ids.length === 0) {
                throw new McpError(ErrorCode.InvalidParams, 'ids is required for action=end (array of "server:tid" from action=list); there is deliberately no "end all"');
            }
            for (const id of ids) {
                if (!/^[^:\s,]+:\d{1,9}$/.test(id)) {
                    throw new McpError(ErrorCode.InvalidParams, `malformed id "${id}" — expected "server:tid" exactly as printed by action=list`);
                }
            }
            params.ids = ids.join(',');
            if (args?.min_age_minutes !== undefined && args.min_age_minutes !== null) {
                const m = Number(args.min_age_minutes);
                if (!Number.isInteger(m) || m < 0 || m > 99999) {
                    throw new McpError(ErrorCode.InvalidParams, 'min_age_minutes must be a non-negative integer');
                }
                params.min_age = String(m);
            }
        }

        const baseUrl = String(await getBaseUrl());
        try {
            const response = await makeAdtRequest(`${baseUrl}/zmcp/session_admin`, 'POST', 30000, '', params,
                { 'Content-Type': 'text/plain; charset=utf-8' });
            const text = String(response.data ?? '').trim();
            // HTTP 200 ≠ success: per-id refusals/failures are lines in the body.
            const failed = action === 'end' && /: (REFUSED|FAILED|AUTHORITY_ERROR|still there)/.test(text);
            return { isError: failed, content: [{ type: 'text', text }] };
        } catch (error) {
            if (error instanceof AxiosError && error.response) {
                const body = String(error.response.data ?? '').trim();
                return { isError: true, content: [{ type: 'text', text: `ManageSessions ${action} failed (HTTP ${error.response.status}): ${body || error.message}` }] };
            }
            throw error;
        }
    } catch (error) {
        return return_error(error);
    }
}
