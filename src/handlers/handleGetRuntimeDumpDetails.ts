import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, stripHtml } from '../lib/utils';
import { AxiosError } from 'axios';

/**
 * Handler for GetRuntimeDumpDetails tool
 *
 * Retrieves a specific runtime dump. Default returns the readable /summary (HTML → text).
 * Other types: formatted (~1MB), unformatted (~2MB), hitlist, dbAccesses, statements, metadata (base XML).
 *
 * Endpoint format: /sap/bc/adt/runtime/dump/{id}[/{type}]  (singular "dump" — plural 404s)
 */
export async function handleGetRuntimeDumpDetails(args: any) {
    try {
        // Validate required parameters
        if (!args?.dump_id) {
            throw new McpError(ErrorCode.InvalidParams, 'dump_id is required');
        }

        // Accept either the bare dump id or a full atom:id / self-link path and reduce to the bare id.
        // e.g. "/sap/bc/adt/vit/runtime/dumps/2026...15" or "adt://SID/sap/bc/adt/runtime/dump/2026...15"
        let dumpId = String(args.dump_id);
        const pathMatch = dumpId.match(/runtime\/dumps?\/(.+)$/i);
        if (pathMatch) dumpId = pathMatch[1].replace(/\/(formatted|hitlist|dbAccesses|statements)$/i, '');
        // Whether we just stripped a path prefix or the caller passed the bare id directly,
        // the id itself is still percent-encoded (SAP pads it with spaces as %20) — decode once
        // here so the encodeURIComponent() below doesn't double-encode it into %2520.
        try { dumpId = decodeURIComponent(dumpId); } catch { /* already decoded / not encoded */ }
        const detailType = args.type; // Optional: 'dbAccesses', 'hitlist', 'statements'
        const baseUrl = await getBaseUrl();

        // Default (and type=summary) returns the concise human-readable dump (~15 KB HTML → text).
        // Other content sub-resources are huge (formatted ~1 MB, unformatted ~2 MB) so they are opt-in.
        // type=metadata returns the base dump XML (chapter index + links).
        const type = detailType ? String(detailType) : 'summary';
        const root = `${baseUrl}/sap/bc/adt/runtime/dump/${encodeURIComponent(dumpId)}`;
        const url = type === 'metadata' ? root : `${root}/${type}`;

        try {
            const response = await makeAdtRequest(url, 'GET', 30000);
            const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '');

            // 'summary' is HTML — strip to readable text. Everything else is returned as-is.
            const text = type === 'summary' ? stripHtml(raw) : raw;
            return { isError: false, content: [{ type: 'text', text }] };
        } catch (error) {
            let sapReason = '';
            if (error instanceof AxiosError && error.response?.data) {
                const parsed = parseAdtErrorXml(String(error.response.data));
                if (parsed) sapReason = `SAP: ${parsed}\n\n`;
            }
            throw new McpError(
                ErrorCode.InternalError,
                `Runtime dump "${dumpId}" not found or not accessible.\n\n` +
                sapReason +
                `Possible reasons:\n` +
                `1. Dump ID format incorrect - use the exact ID from GetRuntimeDumps\n` +
                `2. Dump has been deleted or aged out\n` +
                `3. Missing authorization for dump access\n` +
                `4. Dump detail type "${detailType || 'summary'}" not supported\n\n` +
                `Valid types: summary (default, readable), formatted, unformatted, hitlist, dbAccesses, statements, metadata\n\n` +
                `Note: Use GetRuntimeDumps first to get valid dump IDs.`
            );
        }
    } catch (error) {
        return return_error(error);
    }
}
