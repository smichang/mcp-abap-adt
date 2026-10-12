import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_response, return_error, getBaseUrl } from '../lib/utils';

// Talks to ZCL_HTTP_MCP_AUTH_OBJECT (package ZMCP), a standalone SICF service
// at default_host/zmcp/auth_object — NOT an ADT resource. Exists because
// SU21 (Authorization Object Maintenance) has no ADT/REST surface at all —
// confirmed live: zero endpoint anywhere under /sap/bc/adt/... reaches TOBJ/
// TOBJT, and the real engine (CL_SUSO_APPL) is a class/CDS-based transaction
// implementation, not an FM this could otherwise wrap generically. Deliberately
// a standalone endpoint (own SICF node, own handler class), not a WHEN branch
// on the shared ZCL_MCP_DISPATCH router — see ManageSicfNode's own tool
// description for that alternative pattern, not used here per explicit
// house choice for this feature.
//
// Scope: create/update of the Authorization Object + its up to 10 fields,
// plus ACTVT's permitted-activity list (TACTZ). The Object Class (e.g. "CO",
// "FI", "PP") must already exist — creating a new class, or a new global
// SU20 authorization field, is out of scope. Delete is also out of scope (see docs/TOOL_INTERNALS.md for why).
export async function handleManageAuthObject(args: any) {
    try {
        const action = args?.action ? String(args.action) : '';
        const objectName = args?.object_name ? String(args.object_name).toUpperCase() : '';
        const objectClass = args?.object_class ? String(args.object_class).toUpperCase() : '';
        const description = args?.description !== undefined && args.description !== null ? String(args.description) : '';
        const packageName = args?.package_name ? String(args.package_name) : '';
        const transportNumber = args?.transport_number ? String(args.transport_number) : '';

        if (!['create', 'update'].includes(action)) {
            throw new McpError(ErrorCode.InvalidParams, 'action must be "create" or "update"');
        }
        if (!objectName) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required (e.g. Z_CO_IMG, max 10 chars, customer namespace Y/Z)');
        }

        const fieldsRaw = args?.fields;
        let fields: string[] = [];
        if (Array.isArray(fieldsRaw)) {
            fields = fieldsRaw
                .map((f: any) => String(f && typeof f === 'object' ? f.field_name : f).trim().toUpperCase())
                .filter(Boolean);
        } else if (fieldsRaw !== undefined && fieldsRaw !== null && String(fieldsRaw) !== '') {
            fields = String(fieldsRaw).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        }

        // ACTVT needs SU21's permitted-activity list (TACTZ), carried on the
        // ACTVT entry itself. ZCL_MCP_AUTH_OBJECT validates it (activities
        // exist in TACT, ACTVT present <=> list present) before any save, so
        // a bad list can no longer leave a half-built object behind.
        const actvtEntry = Array.isArray(fieldsRaw)
            ? fieldsRaw.find((f: any) => f && typeof f === 'object' && String(f.field_name ?? '').trim().toUpperCase() === 'ACTVT')
            : undefined;
        const misplaced = Array.isArray(fieldsRaw)
            ? fieldsRaw.find((f: any) => f && typeof f === 'object' && f !== actvtEntry && f.permitted_activities !== undefined)
            : undefined;
        if (misplaced) {
            throw new McpError(ErrorCode.InvalidParams,
                `permitted_activities is only valid on the ACTVT entry, not on "${String(misplaced.field_name)}".`);
        }
        const activitiesRaw = actvtEntry?.permitted_activities;
        let activities: string[] = [];
        if (Array.isArray(activitiesRaw)) {
            activities = activitiesRaw.map((a: any) => String(a).trim().toUpperCase()).filter(Boolean);
        } else if (activitiesRaw !== undefined && activitiesRaw !== null && String(activitiesRaw) !== '') {
            activities = String(activitiesRaw).split(',').map(a => a.trim().toUpperCase()).filter(Boolean);
        }
        if (action === 'create' && fields.includes('ACTVT') && activities.length === 0) {
            throw new McpError(ErrorCode.InvalidParams,
                'Field "ACTVT" requires permitted_activities on the same entry, e.g. {"field_name":"ACTVT","permitted_activities":["02","03"]} (SU21 rejects ACTVT without an activity list).');
        }

        if (action === 'create') {
            if (!objectClass) {
                throw new McpError(ErrorCode.InvalidParams, 'object_class is required for action=create (e.g. "CO", "FI", "PP" — must already exist)');
            }
            if (!description) {
                throw new McpError(ErrorCode.InvalidParams, 'description is required for action=create');
            }
            if (!packageName) {
                throw new McpError(ErrorCode.InvalidParams, 'package_name is required for action=create (development class for the transport registration)');
            }
        }

        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/zmcp/auth_object`;

        const params: Record<string, string> = {
            mode: action,
            object_name: objectName
        };
        if (objectClass) params.object_class = objectClass;
        if (description) params.description = description;
        if (packageName) params.devclass = packageName;
        if (transportNumber) params.trkorr = transportNumber;
        if (activities.length) params.activities = activities.join(',');

        const response = await makeAdtRequest(url, 'POST', 15000, fields.join(','), params, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        return return_response(response);
    } catch (error) {
        const result = return_error(error);
        // create is a two-phase save (header first, then fields — see
        // docs/TOOL_INTERNALS.md). A field-save failure means the header already exists
        // and is registered in the transport, so say so instead of leaving
        // the caller to assume a clean no-op.
        const text = result.content?.[0]?.text ?? '';
        if (args?.action === 'create' && /field save returned|SET_DATA_SUSO returned|field list of .* cannot be changed/i.test(String(text))) {
            result.content[0].text = `${text}\n\nNOTE: partial failure — the object header was already created (and registered in the transport, if any) before the field save failed. ` +
                'Do not retry action=create; use action=update with a corrected fields list, or finish the fields in SU21.';
        }
        return result;
    }
}
