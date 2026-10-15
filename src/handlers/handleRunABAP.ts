import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { resolveAnyObject } from '../lib/resolveObject';

// Executes ABAP server-side through ADT's run resources:
//   CLAS  POST /sap/bc/adt/oo/classrun/{class}            (class must implement IF_OO_ADT_CLASSRUN)
//   PROG  POST /sap/bc/adt/programs/programrun/{program}  (executable report, selection-screen defaults)
// Both answer text/plain with the class's `out->write` / the report's WRITE output. Stateless, one
// call, so not behind the stateful-operation gate. Live-verified 2026-10-15 ($TMP class + report).
const DEFAULT_MAX_CHARS = 20000;

export async function handleRunABAP(args: any) {
    try {
        const objectName = args?.object_name ? String(args.object_name).toUpperCase().trim() : '';
        if (!objectName) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }
        let kind = args?.object_type ? String(args.object_type).toUpperCase().split('/')[0] : '';
        if (kind && kind !== 'CLAS' && kind !== 'PROG') {
            throw new McpError(ErrorCode.InvalidParams, 'object_type must be CLAS or PROG');
        }

        const baseUrl = String(await getBaseUrl());
        // Resolve first: a typo must not look like a successful empty run, and it tells us the kind.
        const resolution = await resolveAnyObject(baseUrl, objectName, kind || undefined);
        if ('error' in resolution) {
            return { isError: true, content: [{ type: 'text', text: resolution.error }] };
        }
        const resolvedKind = resolution.type.split('/')[0];
        if (resolvedKind !== 'CLAS' && resolvedKind !== 'PROG') {
            throw new McpError(ErrorCode.InvalidParams, `'${objectName}' is ${resolution.type}; only a class (CLAS) or an executable program (PROG) can be run`);
        }
        if (resolution.type === 'PROG/I') {
            throw new McpError(ErrorCode.InvalidParams, `'${objectName}' is an include — run its main program instead`);
        }
        kind = resolvedKind;

        // A report can do anything its author wrote (DB updates, background jobs); a classrun class
        // can too, but is by construction a deliberate console entry point. Make the caller say so.
        if (kind === 'PROG' && args?.confirm_side_effects !== true) {
            throw new McpError(ErrorCode.InvalidParams,
                `Running program '${objectName}' executes it for real with its selection-screen defaults — it may write to the database. ` +
                `Read its source first (GetCode OBJECT), and pass confirm_side_effects=true once you know it is safe.`);
        }

        // A class is a deliberate console entry point, but it can do anything its author wrote — and the
        // classrun classes on the system are not all ours (SAP ships demo classes that write data). A class
        // in a LOCAL `$` package is a disposable test object and runs without ceremony; anything else
        // (transportable, standard) needs the same acknowledgement as a report. If the package cannot be
        // determined, ask: unknown is not safe.
        if (kind === 'CLAS' && args?.confirm_side_effects !== true) {
            const pkg = await packageOf(baseUrl, resolution.uri);
            if (!pkg || !pkg.startsWith('$')) {
                throw new McpError(ErrorCode.InvalidParams,
                    `Class '${objectName}' ${pkg ? `is in package ${pkg}, not a local ($) package` : 'has no determinable package'} — running it executes its code for real and it may change data. ` +
                    `Read its source first (GetCode OBJECT), and pass confirm_side_effects=true once you know it is safe. (Classes in a local $ package run without confirmation.)`);
            }
        }

        const url = kind === 'CLAS'
            ? `${baseUrl}/sap/bc/adt/oo/classrun/${encodeURIComponent(objectName.toLowerCase())}`
            : `${baseUrl}/sap/bc/adt/programs/programrun/${encodeURIComponent(objectName.toLowerCase())}`;

        const started = Date.now();
        let response;
        try {
            response = await makeAdtRequest(url, 'POST', 120000, '', undefined, { 'Accept': 'text/plain' });
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const msg = parseAdtErrorXml(String(error.response.data));
                if (msg) {
                    const hint = kind === 'CLAS' && /classrun|not found|interface/i.test(msg)
                        ? '\nThe class must implement IF_OO_ADT_CLASSRUN (method MAIN, output via out->write).'
                        : '';
                    return { isError: true, content: [{ type: 'text', text: `Run of ${kind} '${objectName}' failed (HTTP ${error.response.status}).\nReason: ${msg}${hint}` }] };
                }
            }
            return return_error(error);
        }

        const output = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
        const maxChars = Number.isFinite(Number(args?.max_chars)) && Number(args.max_chars) > 0 ? Number(args.max_chars) : DEFAULT_MAX_CHARS;
        const truncated = output.length > maxChars;
        const shown = truncated ? output.slice(0, maxChars) : output;

        // HTTP 200 is not success: a class that lacks IF_OO_ADT_CLASSRUN answers 200 with
        // "Error: Class does not implement if_oo_adt_classrun~main method!" as its body (live-verified).
        if (kind === 'CLAS' && /^\s*Error:/i.test(output)) {
            return { isError: true, content: [{ type: 'text', text: `Run of CLAS '${objectName}' failed.\nReason: ${output.trim()}\nThe class must implement IF_OO_ADT_CLASSRUN (method MAIN, output via out->write).` }] };
        }

        const head = `Ran ${kind} ${objectName} in ${Date.now() - started} ms — ${output.length} char(s) of output${truncated ? ` (showing first ${maxChars}; raise max_chars)` : ''}`;
        return { isError: false, content: [{ type: 'text', text: `${head}\n${shown || '(no output)'}` }] };
    } catch (error) {
        return return_error(error);
    }
}

// The package an object belongs to, from its own metadata (adtcore:packageRef). null when it cannot be read.
async function packageOf(baseUrl: string, objectUri: string): Promise<string | null> {
    try {
        const r = await makeAdtRequest(`${baseUrl}${objectUri}`, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        const xml = typeof r.data === 'string' ? r.data : String(r.data ?? '');
        return xml.match(/<[\w:]*packageRef\b[^>]*?\bname="([^"]+)"/i)?.[1]?.toUpperCase() ?? null;
    } catch {
        return null;
    }
}
