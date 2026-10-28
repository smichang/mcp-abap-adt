import { McpError, ErrorCode, return_error } from '../lib/utils';
import { handleManageAuthObject } from './handleManageAuthObject';
import { handleManageMessageClass } from './handleManageMessageClass';
import { handleManagePackage } from './handleManagePackage';
import { handleManageTransaction } from './handleManageTransaction';
import { MANAGE_OBJECT_RESOURCES } from './manageObjectSchema';

// Dispatcher for the object maintainers that share a create/update/(delete) shape.
// Strips `resource` and forwards to the existing handler unchanged. ManageDDIC,
// ManageDynpro, ManageTransport, ManageSessions and ManageSicfNode stay standalone.
export async function handleManageObject(args: any) {
    try {
        const resource = args?.resource ? String(args.resource).toUpperCase() : '';
        const { resource: _r, ...rest } = args ?? {};
        switch (resource) {
            case 'AUTH_OBJECT':
                return await handleManageAuthObject(rest);
            case 'MESSAGE_CLASS':
                return await handleManageMessageClass(rest);
            case 'PACKAGE':
                return await handleManagePackage(rest);
            case 'TRANSACTION':
                return await handleManageTransaction(rest);
            default:
                throw new McpError(ErrorCode.InvalidParams,
                    `Invalid resource "${args?.resource}". Must be one of: ${MANAGE_OBJECT_RESOURCES.join(', ')}.`);
        }
    } catch (error) {
        return return_error(error);
    }
}
