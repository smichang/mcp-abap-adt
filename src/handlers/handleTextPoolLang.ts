import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_response, return_error, getBaseUrl } from '../lib/utils';

// Talks to ZCL_HTTP_MCP_TEXTPOOL (package ZMCP), a standalone SICF service
// at default_host/zmcp/textpool — NOT an ADT resource. It exists because
// /sap/bc/adt/textelements/... has no language parameter at all (proven live:
// identical byte-for-byte output regardless of session language/headers/query
// params) and, separately, has non-deterministic write behavior across session
// languages (sometimes rejects, sometimes silently overwrites master).
// iv_language on the ABAP side accepts either the 2-char ISO code (e.g. "ZF")
// or the 1-char internal SAP code (e.g. "M") — resolved via the same
// CONVERSION_EXIT_ISOLA_INPUT SAP's own language fields use.
export async function handleTextPoolLang(args: any) {
    try {
        const action = args?.action ? String(args.action) : '';
        const programName = args?.program_name ? String(args.program_name).toUpperCase() : '';
        const language = args?.language ? String(args.language) : '';
        const category = args?.category ? String(args.category) : 'symbols';

        if (!['get', 'write'].includes(action)) {
            throw new McpError(ErrorCode.InvalidParams, 'action must be "get" or "write"');
        }
        if (!programName) {
            throw new McpError(ErrorCode.InvalidParams, 'program_name is required');
        }
        if (!language) {
            throw new McpError(ErrorCode.InvalidParams, 'language is required (ISO code like "ZF"/"EN" or internal SAP code like "M"/"E")');
        }
        if (!['symbols', 'selections', 'headings', 'title'].includes(category)) {
            throw new McpError(ErrorCode.InvalidParams, 'category must be one of: symbols, selections, headings, title');
        }

        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/zmcp/textpool`;

        if (action === 'get') {
            const response = await makeAdtRequest(url, 'GET', 15000, undefined, {
                program: programName,
                language,
                category
            });

            const offsetGiven = args?.offset !== undefined && args.offset !== null;
            const limitGiven = args?.limit !== undefined && args.limit !== null;
            if ((offsetGiven || limitGiven) && (category === 'symbols' || category === 'selections')) {
                const offset = offsetGiven ? Number(args.offset) : 0;
                const limit = limitGiven ? Number(args.limit) : undefined;
                const rawText = String(response.data ?? '');

                // Both categories render as blank-line-separated blocks, one
                // entry per block (symbols: 2 lines; selections: 1 line) —
                // see render_symbols/render_selections in ZCL_HTTP_MCP_TEXTPOOL.
                const blocks = rawText.replace(/\n+$/, '').split(/\n\n+/).filter(b => b.trim() !== '');
                const total = blocks.length;
                const windowed = limit !== undefined ? blocks.slice(offset, offset + limit) : blocks.slice(offset);
                const header = `(${total} total, showing ${windowed.length} from offset ${offset})\n\n`;
                const text = header + windowed.join('\n\n') + (windowed.length ? '\n\n' : '');
                return { isError: false, content: [{ type: 'text', text }] };
            }

            return return_response(response);
        }

        // action === 'write'
        const content = args?.content !== undefined && args.content !== null ? String(args.content) : '';
        const packageName = args?.package_name ? String(args.package_name) : '';
        const transportNumber = args?.transport_number ? String(args.transport_number) : '';
        const deleteKeysRaw = args?.delete_keys;
        const deleteKeys = Array.isArray(deleteKeysRaw)
            ? deleteKeysRaw.map(String)
            : (deleteKeysRaw !== undefined && deleteKeysRaw !== null && String(deleteKeysRaw) !== '')
                ? String(deleteKeysRaw).split(',')
                : [];

        if (!packageName) {
            throw new McpError(ErrorCode.InvalidParams, 'package_name is required for action=write (development class for the transport registration)');
        }
        if (!content && deleteKeys.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'content and/or delete_keys is required for action=write');
        }
        if (deleteKeys.length > 0 && category !== 'symbols' && category !== 'selections') {
            throw new McpError(ErrorCode.InvalidParams, 'delete_keys is only supported for category=symbols or selections');
        }

        const params: Record<string, string> = {
            program: programName,
            language,
            category,
            devclass: packageName
        };
        if (transportNumber) params.trkorr = transportNumber;
        if (deleteKeys.length > 0) params.delete_keys = deleteKeys.join(',');

        await makeAdtRequest(url, 'PUT', 15000, content, params, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        const parts: string[] = [];
        if (content) parts.push(`wrote ${category}`);
        if (deleteKeys.length > 0) parts.push(`deleted ${deleteKeys.length} ${category} key(s) [${deleteKeys.join(', ')}]`);

        return {
            isError: false,
            content: [{ type: 'text', text: `${parts.join(' and ')} for '${programName}' in language '${language}'.` }]
        };
    } catch (error) {
        return return_error(error);
    }
}
