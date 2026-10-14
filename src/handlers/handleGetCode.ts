import { McpError, ErrorCode, return_error } from '../lib/utils';
import { handleGetObject } from './handleGetObject';
import { handleGetObjectVersion } from './handleGetObjectVersion';
import { handleGetEnhancements } from './handleGetEnhancements';
import { handleGetWhereUsed } from './handleGetWhereUsed';
import { handleGetDynpro } from './handleGetDynpro';
import { maybeBackground, resolveOutPath } from '../lib/background';
import * as fs from 'fs/promises';

const RESOURCES = ['OBJECT', 'VERSION', 'ENHANCEMENTS', 'WHEREUSED', 'DYNPRO'];

export async function handleGetCode(args: any) {
    try {
        const resource = args?.resource ? String(args.resource).toUpperCase() : '';
        const { resource: _r, ...rest } = args ?? {};
        switch (resource) {
            // OBJECT/VERSION handlers don't wrap themselves in maybeBackground (ENHANCEMENTS/
            // WHEREUSED do), so honor the schema's background/output_file here instead.
            case 'OBJECT':
                if (rest?.objects !== undefined) {
                    return await maybeBackground(rest, `GetCode OBJECT x${Array.isArray(rest.objects) ? rest.objects.length : 0}`, 'getcode-batch', () => getObjectsBatch(rest));
                }
                return await maybeBackground(rest, `GetCode OBJECT ${slugName(rest)}`, `getcode-${slugName(rest)}`, () => handleGetObject(rest));
            case 'VERSION':
                return await maybeBackground(rest, `GetCode VERSION ${slugName(rest)}`, `version-${slugName(rest)}`, () => handleGetObjectVersion(rest));
            case 'ENHANCEMENTS':
                return await handleGetEnhancements(rest);
            case 'WHEREUSED':
                return await handleGetWhereUsed(rest);
            case 'DYNPRO':
                // raw JSON is 35-50 KB per screen: with output_file it goes ONLY to the
                // file (eval 2026-10-02: returning it inline as well overflowed a client)
                if (rest?.raw === true && rest?.output_file && rest?.background !== true) {
                    return await rawDynproToFile(rest);
                }
                return await maybeBackground(rest, `GetCode DYNPRO ${slugName(rest)}`, `dynpro-${slugName(rest)}${rest?.dynnr ? `-${rest.dynnr}` : ''}`, () => handleGetDynpro(rest));
            default:
                throw new McpError(ErrorCode.InvalidParams, `Invalid resource "${args?.resource}". Must be one of: ${RESOURCES.join(', ')}.`);
        }
    } catch (error) {
        return return_error(error);
    }
}

async function rawDynproToFile(args: any) {
    const res = await handleGetDynpro(args);
    if (res.isError) return res;
    const text = res.content?.[0]?.text ?? '';
    const outPath = resolveOutPath(String(args.output_file), `dynpro-${slugName(args)}`);
    try {
        await fs.writeFile(outPath, text, 'utf8');
    } catch (e: any) {
        // never claim a file that was not written - return the data inline instead
        return { isError: false, content: [{ type: 'text', text: `Could not write output_file '${outPath}' (${e?.message || String(e)}); definition follows inline:\n${text}` }] };
    }
    const dynnr = args?.dynnr ? String(args.dynnr).padStart(4, '0') : '';
    return { isError: false, content: [{ type: 'text', text: `Screen definition ${slugName(args)} ${dynnr} written to ${outPath} (${Buffer.byteLength(text, 'utf8')} bytes, JSON). Pass it to ManageDynpro as definition_file, or read/edit the file.` }] };
}

function slugName(args: any): string {
    return args?.object_name ? String(args.object_name).toUpperCase() : 'object';
}

const MAX_BATCH_OBJECTS = 10;

// resource=OBJECT with objects[]: fetch several objects in one tool call. Each entry is a name
// or { object_name, kind?, function_group? }; other top-level args are defaults for every entry.
// The reads run in parallel (makeAdtRequest's semaphore still caps the SAP concurrency); a failing
// object is reported in place and never hides the others. isError only when every object failed.
async function getObjectsBatch(args: any) {
    const { objects, object_name: _n, ...shared } = args;
    if (!Array.isArray(objects) || objects.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'objects must be a non-empty array of names or { object_name, kind?, function_group? }');
    }
    if (objects.length > MAX_BATCH_OBJECTS) {
        throw new McpError(ErrorCode.InvalidParams, `objects has ${objects.length} entries; the limit is ${MAX_BATCH_OBJECTS} per call (split the request).`);
    }
    const items = objects.map((o: any) => typeof o === 'string' ? { object_name: o } : o);
    for (const it of items) {
        if (!it?.object_name || typeof it.object_name !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'every objects[] entry needs an object_name');
        }
    }
    const { output_file: _o, background: _b, ...perCall } = shared;
    const results = await Promise.all(items.map(async (it: any) => {
        try {
            return { name: String(it.object_name).toUpperCase(), res: await handleGetObject({ ...perCall, ...it }) };
        } catch (e: any) {
            return { name: String(it.object_name).toUpperCase(), res: { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] } };
        }
    }));
    const failed = results.filter(r => r.res.isError).length;
    const text = results
        .map(r => `===== ${r.name}${r.res.isError ? ' — ERROR' : ''} =====\n${r.res.content?.map((c: any) => c.text).join('\n') ?? ''}`)
        .join('\n\n');
    return { isError: failed === results.length, content: [{ type: 'text', text: failed ? `${failed} of ${results.length} object(s) failed.\n\n${text}` : text }] };
}
