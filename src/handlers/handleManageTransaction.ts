import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_response, return_error, getBaseUrl } from '../lib/utils';

// Talks to ZCL_HTTP_TRANSACTION (package ZAIMCP), a standalone SICF service at
// default_host/zaimcp/transaction — NOT an ADT resource. SE93 has no ADT write
// surface (ADT only reads a transaction). create wraps RPY_TRANSACTION_INSERT,
// delete wraps RPY_TRANSACTION_DELETE; SAP ships no update FM, so update writes
// TSTC/TSTCT/TSTCC behind the same RS_ACCESS_PERMISSION / RS_CORR_INSERT calls.
// Scope: dialog (D) and report (R) transactions in the customer namespace.
export async function handleManageTransaction(args: any) {
    try {
        const action = args?.action ? String(args.action) : '';
        const tcode = args?.transaction_name ? String(args.transaction_name).trim().toUpperCase() : '';
        const program = args?.program_name ? String(args.program_name).trim().toUpperCase() : '';
        const screen = args?.screen_number !== undefined && args.screen_number !== null ? String(args.screen_number).trim() : '';
        const description = args?.description ? String(args.description) : '';
        const type = args?.transaction_type ? String(args.transaction_type).trim().toUpperCase() : '';
        const packageName = args?.package_name ? String(args.package_name) : '';
        const transportNumber = args?.transport_number ? String(args.transport_number) : '';

        if (!['create', 'update', 'delete'].includes(action)) {
            throw new McpError(ErrorCode.InvalidParams, 'action must be "create", "update" or "delete"');
        }
        if (!tcode) {
            throw new McpError(ErrorCode.InvalidParams, 'transaction_name is required (customer namespace Y/Z, max 20 chars)');
        }
        if (tcode.length > 20) {
            throw new McpError(ErrorCode.InvalidParams, 'transaction_name is at most 20 characters');
        }
        if (!/^[YZ]/.test(tcode)) {
            throw new McpError(ErrorCode.InvalidParams, 'transaction_name must be in the customer namespace (start with Y or Z)');
        }
        if (screen && !/^\d{1,4}$/.test(screen)) {
            throw new McpError(ErrorCode.InvalidParams, 'screen_number must be up to 4 digits, e.g. "0100"');
        }
        if (type && !['D', 'R'].includes(type)) {
            throw new McpError(ErrorCode.InvalidParams, 'transaction_type must be "D" (dialog, default) or "R" (report)');
        }
        if (action === 'create') {
            if (!program) throw new McpError(ErrorCode.InvalidParams, 'program_name is required for action=create');
            if (!description) throw new McpError(ErrorCode.InvalidParams, 'description is required for action=create');
            if (!packageName) throw new McpError(ErrorCode.InvalidParams, 'package_name is required for action=create');
            if ((type || 'D') === 'D' && !screen) {
                throw new McpError(ErrorCode.InvalidParams, 'screen_number is required for a dialog transaction (transaction_type "D")');
            }
        }

        const guiFlag = (v: any): string => (v === undefined || v === null ? '' : v ? 'X' : 'N');
        const web = guiFlag(args?.web_gui);
        const java = guiFlag(args?.java_gui);
        const win = guiFlag(args?.win_gui);
        if (action === 'update' && !program && !screen && !description && !web && !java && !win) {
            throw new McpError(ErrorCode.InvalidParams,
                'nothing to update: pass program_name, screen_number, description, web_gui, java_gui or win_gui');
        }

        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/zaimcp/transaction`;

        const params: Record<string, string> = { action, tcode };
        if (program) params.program = program;
        if (screen) params.dynpro = screen;
        if (description) params.description = description;
        if (type) params.type = type;
        if (packageName) params.devclass = packageName;
        if (transportNumber) params.trkorr = transportNumber;
        if (web) params.web_gui = web;
        if (java) params.java_gui = java;
        if (win) params.win_gui = win;

        const response = await makeAdtRequest(url, 'POST', 15000, '', params, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}
