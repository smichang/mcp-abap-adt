import { McpError, ErrorCode, return_error } from '../lib/utils';
import { handleGetPackage } from './handleGetPackage';
import { handleGetTypeInfo } from './handleGetTypeInfo';
import { handleGetTransaction } from './handleGetTransaction';
import { handleGetTransport } from './handleGetTransport';
import { handleGetMessageClass } from './handleGetMessageClass';
import { handleGetDDICObject } from './handleGetDDICObject';
import { handleGetInactiveObjects } from './handleGetInactiveObjects';
import { maybeBackground } from '../lib/background';

const RESOURCES = ['PACKAGE', 'TYPEINFO', 'TRANSACTION', 'TRANSPORT', 'MESSAGE_CLASS', 'DDIC', 'INACTIVE_OBJECTS'];

export async function handleGetMeta(args: any) {
    try {
        const resource = args?.resource ? String(args.resource).toUpperCase() : '';
        const { resource: _r, ...rest } = args ?? {};
        switch (resource) {
            // PACKAGE wraps itself in maybeBackground; the rest are wrapped here so the
            // schema's background/output_file is honored for every resource.
            case 'PACKAGE':
                return await handleGetPackage(rest);
            case 'TYPEINFO':
                return await wrap(rest, 'TYPEINFO', () => handleGetTypeInfo(rest));
            case 'TRANSACTION':
                return await wrap(rest, 'TRANSACTION', () => handleGetTransaction(rest));
            case 'TRANSPORT':
                return await wrap(rest, 'TRANSPORT', () => handleGetTransport(rest));
            case 'MESSAGE_CLASS':
                return await wrap(rest, 'MESSAGE_CLASS', () => handleGetMessageClass(rest));
            case 'DDIC':
                return await wrap(rest, 'DDIC', () => handleGetDDICObject(rest));
            case 'INACTIVE_OBJECTS':
                return await wrap(rest, 'INACTIVE_OBJECTS', () => handleGetInactiveObjects(rest));
            default:
                throw new McpError(ErrorCode.InvalidParams, `Invalid resource "${args?.resource}". Must be one of: ${RESOURCES.join(', ')}.`);
        }
    } catch (error) {
        return return_error(error);
    }
}

function wrap(args: any, resource: string, core: () => Promise<any>) {
    const name = String(args?.object_name ?? args?.name ?? args?.transport_number ?? '').toUpperCase();
    const tag = name ? `${resource} ${name}` : resource;
    return maybeBackground(args, `GetMeta ${tag}`, `getmeta-${tag.replace(/[^A-Za-z0-9_]+/g, '-')}`, core);
}
