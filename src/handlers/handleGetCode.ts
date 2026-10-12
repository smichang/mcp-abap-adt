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
