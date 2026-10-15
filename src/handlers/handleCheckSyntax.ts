import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { resolveAnyObject } from '../lib/resolveObject';
import { checkSourceInContext, formatSyntaxMessages } from '../lib/syntaxCheck';

// GetCode resource=SYNTAX: ADT syntax check of an EXISTING object's current source — the read-only
// counterpart of WriteProgram's check_only (which needs the new source passed in). Reads
// {object}/source/main (SAP returns the inactive working version when one exists, otherwise the
// active one) and feeds it to the same stateless checkrun used before a write. No lock, no write.
// Includes are checked without their master program, so a false error is possible there.
export async function handleCheckSyntax(args: any) {
    try {
        const objectName = args?.object_name ? String(args.object_name).toUpperCase().trim() : '';
        if (!objectName) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }
        const objectType = args?.object_type ? String(args.object_type).toUpperCase() : undefined;
        const maxLines = Number.isFinite(Number(args?.max_messages)) && Number(args.max_messages) > 0 ? Math.min(Number(args.max_messages), 200) : 20;

        const baseUrl = String(await getBaseUrl());
        const resolution = await resolveAnyObject(baseUrl, objectName, objectType);
        if ('error' in resolution) {
            return { isError: true, content: [{ type: 'text', text: resolution.error }] };
        }

        let source: string;
        try {
            const r = await makeAdtRequest(`${baseUrl}${resolution.uri}/source/main`, 'GET', 30000, undefined, undefined, { 'Accept': 'text/plain' });
            source = typeof r.data === 'string' ? r.data : String(r.data ?? '');
        } catch (error) {
            if (error instanceof AxiosError && error.response?.status === 404) {
                return { isError: true, content: [{ type: 'text', text: `${resolution.type} '${objectName}' has no source/main resource, so it cannot be syntax-checked this way (data dictionary objects and function groups have none; check a function module or its include instead).` }] };
            }
            throw error;
        }

        let result;
        try {
            result = await checkSourceInContext(baseUrl, resolution.uri, source);
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const msg = parseAdtErrorXml(String(error.response.data));
                if (msg) return { isError: true, content: [{ type: 'text', text: `Syntax check call failed for ${objectName}.\nReason: ${msg}` }] };
            }
            return return_error(error);
        }

        const head = `${resolution.type} ${objectName} — ${source.split('\n').length} line(s) checked`;
        const note = '';
        return { isError: result.errors > 0, content: [{ type: 'text', text: `${head}\n${formatSyntaxMessages(result, maxLines)}${note}` }] };
    } catch (error) {
        return return_error(error);
    }
}
