import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { getConfig } from '../index';
import { AxiosError } from 'axios';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

const TYPE_PREFIX: Record<string, string> = {
    'PROG': '/sap/bc/adt/programs/programs',
    'CLAS': '/sap/bc/adt/oo/classes',
    'INTF': '/sap/bc/adt/oo/interfaces',
    'FUGR': '/sap/bc/adt/functions/groups',
    'INCL': '/sap/bc/adt/programs/includes',
    'TABL': '/sap/bc/adt/ddic/tables',
    'DTEL': '/sap/bc/adt/ddic/dataelements',
    'DOMA': '/sap/bc/adt/ddic/domains',
    'DDLS': '/sap/bc/adt/ddic/ddl/sources',
};

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A CR (transport request) and a task are different SAP objects, but SAP's own
// `POST /sap/bc/adt/cts/transports` (action=create's endpoint) already creates one task
// automatically alongside the request — verified live: creating a bare request with no
// object write and no explicit task call still comes back with exactly one `tm:task` owned
// by the connecting user. So action=create is already "one step, CR + task" with no extra
// call needed. What SAP does NOT give you is a *second* task for a *different* developer on
// a shared CR — that's what this endpoint (and action=add_task) is for: the same "add task"
// call the SAP GUI's transport organizer uses (verified against abap-adt-api's
// transportAddUser: POST .../tasks with tm:useraction="newtask" creates a new development
// task owned by tm:targetuser under the parent request).
export async function addTaskToTransport(
    baseUrl: Buffer | string, transportNumber: string, user: string
): Promise<{ taskNumber?: string; error?: string }> {
    const body = `<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${escapeXml(transportNumber)}" tm:targetuser="${escapeXml(user)}" tm:useraction="newtask"/>`;
    const url = `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}/tasks`;

    try {
        const response = await makeAdtRequest(url, 'POST', 20000, body, undefined, {
            'Content-Type': 'text/plain',
            'Accept': 'application/*'
        });
        const responseText = typeof response.data === 'string' ? response.data : String(response.data || '');
        let taskNumber = '';
        try {
            const convert = require('xml-js');
            const parsed = convert.xml2js(responseText, { compact: true }) as any;
            const uri: string = parsed?.['tm:root']?._attributes?.['tm:uri'] || '';
            taskNumber = uri.split('/').pop() || '';
        } catch (_parseError) { /* task was still created even if the response didn't parse */ }
        return { taskNumber };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { error: `Failed to add task for user '${user}' to transport '${transportNumber}'.\nReason: ${errMsg}` };
        }
        return { error: `Failed to add task for user '${user}' to transport '${transportNumber}': ${error instanceof Error ? error.message : String(error)}` };
    }
}

// Read-only: reports the task(s) SAP already attached to a request, so action=create (and
// WriteProgram's transport_description auto-create path) can show proof the CR isn't empty
// without placing a second, redundant task on top of SAP's own.
export async function getExistingTasks(baseUrl: Buffer | string, transportNumber: string): Promise<string[]> {
    try {
        const response = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`,
            'GET', 15000, undefined, undefined,
            { 'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml' }
        );
        const xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;

        const findTasks = (obj: any, results: string[] = []): string[] => {
            if (!obj || typeof obj !== 'object') return results;
            if (Array.isArray(obj)) { for (const item of obj) findTasks(item, results); return results; }
            for (const key of Object.keys(obj)) {
                if (key === 'tm:task') {
                    const tasks = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
                    for (const t of tasks) {
                        const n = t?._attributes?.['tm:number'];
                        if (n) results.push(n);
                    }
                } else {
                    findTasks(obj[key], results);
                }
            }
            return results;
        };
        return findTasks(parsed);
    } catch (_error) {
        return []; // non-fatal — the create itself already succeeded
    }
}

async function actionAddTask(args: any, baseUrl: Buffer | string): Promise<any> {
    const transportNumber = args.transport_number ? String(args.transport_number).toUpperCase() : '';
    const taskUser = args.task_user ? String(args.task_user).toUpperCase() : getConfig().username.toUpperCase();

    if (!transportNumber) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=add_task');

    const result = await addTaskToTransport(baseUrl, transportNumber, taskUser);
    if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
    return {
        isError: false,
        content: [{ type: 'text', text: `Task ${result.taskNumber || '(created)'} added to transport ${transportNumber} for user ${taskUser}.` }]
    };
}

async function actionCreate(args: any, baseUrl: Buffer | string): Promise<any> {
    const description = args.description;
    const devClass   = (args.dev_class || '').toUpperCase();

    // object_url can reference an object that does not exist yet — SAP derives the transport
    // layer/target purely from DEVCLASS and REF's URL *shape* (verified live: a REF pointing
    // at a not-yet-created program still creates the transport). object_type + object_name is
    // a convenience that builds that path via the same TYPE_PREFIX map used by assign_object,
    // so callers creating a brand-new object don't need to hand-construct the ADT URI just to
    // get a properly described transport before WriteProgram would otherwise auto-generate one.
    let objectUrl = args.object_url;
    if (!objectUrl && args.object_type && args.object_name) {
        const objectType = String(args.object_type).toUpperCase();
        const prefix = TYPE_PREFIX[objectType];
        if (!prefix) {
            return { isError: true, content: [{ type: 'text', text: `Unsupported object type: ${objectType}. Supported: ${Object.keys(TYPE_PREFIX).join(', ')}` }] };
        }
        objectUrl = `${prefix}/${String(args.object_name).toUpperCase()}`;
    }

    if (!description)        throw new McpError(ErrorCode.InvalidParams, 'description is required for action=create');
    if (description.length > 60) throw new McpError(ErrorCode.InvalidParams, `description exceeds SAP limit of 60 characters (got ${description.length})`);
    if (!objectUrl)          throw new McpError(ErrorCode.InvalidParams, 'object_url (or object_type + object_name) is required for action=create');
    if (!devClass)           throw new McpError(ErrorCode.InvalidParams, 'dev_class is required for action=create');

    const body = `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <DEVCLASS>${escapeXml(devClass)}</DEVCLASS>
      <REQUEST_TEXT>${escapeXml(description)}</REQUEST_TEXT>
      <REF>${escapeXml(objectUrl)}</REF>
      <OPERATION>I</OPERATION>
    </DATA>
  </asx:values>
</asx:abap>`;

    const url = `${baseUrl}/sap/bc/adt/cts/transports`;
    try {
        const response = await makeAdtRequest(url, 'POST', 30000, body, undefined, {
            'Content-Type': 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest',
            'Accept': 'text/plain'
        });
        const responseText = typeof response.data === 'string' ? response.data : String(response.data || '');
        const transportNumber = responseText.trim().split('/').pop() || responseText.trim();
        if (!transportNumber) {
            return { isError: true, content: [{ type: 'text', text: 'Create transport failed: SAP returned an empty response.' }] };
        }

        const lines = [
            `Transport ${transportNumber} created successfully.`,
            `Description: ${description}`,
            `Package: ${devClass}`
        ];

        // SAP already creates a task alongside the request itself (verified live) — read it
        // back so the caller has proof the CR isn't empty, without placing a second task on
        // top of SAP's own. Use action=add_task separately if a different developer needs
        // their own task on this CR.
        const existingTasks = await getExistingTasks(baseUrl, transportNumber);
        if (existingTasks.length > 0) {
            lines.push(`Task: ${existingTasks.join(', ')} (auto-created by SAP with the request)`);
        }


        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Create transport failed.\nReason: ${errMsg}` }] };
        }
        return return_error(error);
    }
}

async function actionRelease(args: any, baseUrl: Buffer | string): Promise<any> {
    const transportNumber = args.transport_number;
    const ignoreLocks = !!args.ignore_locks;

    if (!transportNumber) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=release');

    const action = ignoreLocks ? 'relwithignlock' : 'newreleasejobs';
    const url = `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}/${action}`;

    try {
        const response = await makeAdtRequest(url, 'POST', 60000, '', undefined, { 'Accept': 'application/*' });
        const responseText = typeof response.data === 'string' ? response.data : String(response.data || '');

        // Try to parse release reports for any warnings/errors
        try {
            const convert = require('xml-js');
            const parsed = convert.xml2js(responseText, { compact: true }) as any;
            const toArr = (v: any): any[] => (!v ? [] : Array.isArray(v) ? v : [v]);
            const reports = toArr(parsed?.['tm:root']?.['tm:releasereports']?.['chkrun:checkReport'] ||
                parsed?.['tm:root']?.['chkrun:checkReport']);

            const messages: string[] = [];
            let failed = false;
            for (const rep of reports) {
                const status = String(rep._attributes?.['chkrun:status'] || '');
                // SAP signals release failure via status codes like "abortrelgen", "error", "abort*".
                // A clean release reports "released" / "ok" / "G".
                if (/abort|error|fail/i.test(status)) failed = true;
                const msgList = toArr(rep['chkrun:checkMessageList']?.['chkrun:checkMessage']);
                for (const msg of msgList) {
                    const txt = msg._attributes?.['chkrun:shortText'] || msg._text || '';
                    const msgType = String(msg._attributes?.['chkrun:type'] || '');
                    if (/^E/i.test(msgType)) failed = true;
                    if (txt) messages.push(`  [${status}] ${txt}`);
                }
            }

            const lines = [`Transport ${transportNumber} release ${failed ? 'FAILED.' : 'job started.'}`];
            if (messages.length > 0) { lines.push('', 'Messages:'); lines.push(...messages); }
            return { isError: failed, content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (_) {
            return { isError: false, content: [{ type: 'text', text: `Transport ${transportNumber} release job started.\n${responseText}` }] };
        }
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Release failed for '${transportNumber}'.\nReason: ${errMsg}` }] };
        }
        return return_error(error);
    }
}

async function actionSetText(args: any, baseUrl: Buffer | string): Promise<any> {
    const transportNumber = args.transport_number ? String(args.transport_number).toUpperCase() : '';
    const description = args.description;
    const targetOverride = args.target !== undefined ? String(args.target) : undefined;

    if (!transportNumber)    throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=set_text');
    if (!description)        throw new McpError(ErrorCode.InvalidParams, 'description is required for action=set_text');
    if (description.length > 60) throw new McpError(ErrorCode.InvalidParams, `description exceeds SAP limit of 60 characters (got ${description.length})`);

    // Undocumented endpoint, verified live: PUT the same transportrequests/{number} URL used
    // for GET, body tm:root > tm:request with tm:number + the new tm:desc. Only works
    // pre-release — SAP refuses to rename a released transport.
    //
    // tm:target MUST be echoed back even though it is otherwise unrelated to the rename.
    // Live-verified 2026-09-08: a PUT carrying only tm:number+tm:desc silently CLEARS
    // tm:target — the request's CTS route/target system group — demoting a normal
    // Workbench request to "Local Change Requests" (no target at all). owner/type/status
    // survive omission just fine; target does not. GET first and echo it back.
    //
    // Optional `target` argument overrides the GET-derived value — needed to REPAIR a
    // transport whose target was already cleared by an earlier (pre-fix) set_text call,
    // since echoing back an already-empty GET result just re-confirms the broken state.
    const url = `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`;

    let currentTarget = '';
    if (targetOverride !== undefined) {
        currentTarget = targetOverride;
    } else {
        try {
            const getResponse = await makeAdtRequest(url, 'GET', 15000, undefined, undefined, {
                'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml'
            });
            const xml = typeof getResponse.data === 'string' ? getResponse.data : String(getResponse.data || '');
            const targetMatch = xml.match(/tm:target="([^"]*)"/);
            currentTarget = targetMatch ? targetMatch[1] : '';
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to read current transport '${transportNumber}' before renaming.\nReason: ${errMsg}` }] };
            }
            return return_error(error);
        }
    }

    const targetAttr = currentTarget ? ` tm:target="${escapeXml(currentTarget)}"` : '';
    const body = `<?xml version="1.0" encoding="UTF-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:request tm:number="${escapeXml(transportNumber)}" tm:desc="${escapeXml(description)}"${targetAttr}/></tm:root>`;

    try {
        await makeAdtRequest(url, 'PUT', 20000, body, undefined, {
            'Content-Type': 'application/xml',
            'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml'
        });
        return { isError: false, content: [{ type: 'text', text: `Transport ${transportNumber} description set to: ${description}` }] };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to rename transport '${transportNumber}'.\nReason: ${errMsg}\n(Note: SAP only allows renaming an unreleased transport.)` }] };
        }
        return return_error(error);
    }
}

async function actionDelete(args: any, baseUrl: Buffer | string): Promise<any> {
    const transportNumber = args.transport_number ? String(args.transport_number).toUpperCase() : '';
    if (!transportNumber) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=delete');

    const url = `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`;
    try {
        await makeAdtRequest(url, 'DELETE', 20000, undefined, undefined, { 'Accept': 'application/*' });
        return { isError: false, content: [{ type: 'text', text: `Transport ${transportNumber} deleted.` }] };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to delete transport '${transportNumber}'.\nReason: ${errMsg}\n(Note: SAP only allows deleting an unreleased, empty-of-others'-work transport.)` }] };
        }
        return return_error(error);
    }
}

// Reuses the exact tm:abap_object shape handleGetTransport.ts already parses
// (tm:pgmid / tm:type / tm:name, nested tm:task under tm:request) — same GET
// + Accept header, same xml-js compact parse. Returns a flat list across every
// task in the transport, for action=merge to iterate.
async function getTransportObjects(baseUrl: Buffer | string, transportNumber: string): Promise<Array<{ pgmid: string; type: string; name: string }>> {
    const url = `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`;
    const response = await makeAdtRequest(url, 'GET', 30000, undefined, undefined,
        { 'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml' });
    const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');

    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const toArr = (v: any): any[] => (!v ? [] : Array.isArray(v) ? v : [v]);
    const attr = (node: any, key: string): string => node?._attributes?.[key] || '';

    const findRequests = (obj: any, results: any[] = []): any[] => {
        if (!obj || typeof obj !== 'object') return results;
        if (Array.isArray(obj)) { for (const item of obj) findRequests(item, results); return results; }
        for (const key of Object.keys(obj)) {
            if (key === 'tm:request') { results.push(...toArr(obj[key])); }
            else { findRequests(obj[key], results); }
        }
        return results;
    };

    const out: Array<{ pgmid: string; type: string; name: string }> = [];
    for (const req of findRequests(parsed)) {
        for (const task of toArr(req['tm:task'])) {
            for (const obj of toArr(task['tm:abap_object'])) {
                out.push({ pgmid: attr(obj, 'tm:pgmid'), type: attr(obj, 'tm:type'), name: attr(obj, 'tm:name') });
            }
        }
    }
    return out;
}

async function actionMoveObject(args: any, baseUrl: Buffer | string): Promise<any> {
    const pgmid          = args.pgmid ? String(args.pgmid).toUpperCase() : 'R3TR';
    const objectType     = args.object_type ? String(args.object_type).toUpperCase() : '';
    const objectName     = args.object_name ? String(args.object_name).toUpperCase() : '';
    const transportNumber = args.transport_number ? String(args.transport_number).toUpperCase() : '';

    if (!objectType)      throw new McpError(ErrorCode.InvalidParams, 'object_type is required for action=move_object');
    if (!objectName)      throw new McpError(ErrorCode.InvalidParams, 'object_name is required for action=move_object');
    if (!transportNumber) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=move_object (target task or request)');

    // Standalone SICF endpoint (ZCL_HTTP_MCP_TRANSPORT_ADMIN, default_host/zmcp/transport_admin)
    // wrapping CTS_WBO_API_INSERT_OBJECTS — NOT an ADT resource, same family as
    // ManageAuthObject's own standalone endpoint. Plain-text response/error body,
    // so this follows handleManageAuthObject.ts's simpler return_error path, not
    // the parseAdtErrorXml path the other actions in this file use (those talk to
    // real ADT XML endpoints; this one doesn't).
    const url = `${baseUrl}/zmcp/transport_admin`;
    try {
        const response = await makeAdtRequest(url, 'POST', 20000, '', {
            pgmid,
            object_type: objectType,
            object_name: objectName,
            target_trkorr: transportNumber
        }, { 'Content-Type': 'text/plain; charset=utf-8' });
        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}

// Removes a locked object entry from a transport/task without touching the
// underlying repository object — the headless equivalent of SE01/SE09's own
// object-list right-click "Delete Object" feature. No ADT REST endpoint
// reaches this on this SAP release (the advertised `removeobject` HATEOAS
// link is genuinely registered but never actually dispatched by
// CL_CTS_ADT_TM_REST_RES_CONT's own POST/PUT handlers — confirmed by reading
// that class's dispatch source directly, not by guessing). Wraps
// ZCL_MCP_TRANSPORT_ADMIN=>delete_object, itself wrapping the real FM
// TR_DELETE_COMM_OBJECT_KEYS (same one SAP's own CTS REST API class calls
// internally with IV_DIALOG_FLAG=' ' for headless mode). See CLAUDE.md's
// ManageTransport section for the full discovery trail.
async function actionRemoveObject(args: any, baseUrl: Buffer | string): Promise<any> {
    const pgmid          = args.pgmid ? String(args.pgmid).toUpperCase() : 'R3TR';
    const objectType     = args.object_type ? String(args.object_type).toUpperCase() : '';
    const objectName     = args.object_name ? String(args.object_name).toUpperCase() : '';
    const transportNumber = args.transport_number ? String(args.transport_number).toUpperCase() : '';

    if (!objectType)      throw new McpError(ErrorCode.InvalidParams, 'object_type is required for action=remove_object');
    if (!objectName)      throw new McpError(ErrorCode.InvalidParams, 'object_name is required for action=remove_object');
    if (!transportNumber) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=remove_object (the task/request currently holding the object)');

    const url = `${baseUrl}/zmcp/transport_admin`;
    try {
        const response = await makeAdtRequest(url, 'POST', 20000, '', {
            action: 'delete_object',
            pgmid,
            object_type: objectType,
            object_name: objectName,
            trkorr: transportNumber
        }, { 'Content-Type': 'text/plain; charset=utf-8' });
        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}

async function actionMerge(args: any, baseUrl: Buffer | string): Promise<any> {
    const fromTransport = args.from_transport ? String(args.from_transport).toUpperCase() : '';
    const toTransport   = args.to_transport ? String(args.to_transport).toUpperCase() : '';

    if (!fromTransport) throw new McpError(ErrorCode.InvalidParams, 'from_transport is required for action=merge');
    if (!toTransport)   throw new McpError(ErrorCode.InvalidParams, 'to_transport is required for action=merge');
    if (fromTransport === toTransport) throw new McpError(ErrorCode.InvalidParams, 'from_transport and to_transport must differ');

    const objects = await getTransportObjects(baseUrl, fromTransport);

    const moved: string[] = [];
    const failed: string[] = [];
    const url = `${baseUrl}/zmcp/transport_admin`;
    for (const obj of objects) {
        try {
            await makeAdtRequest(url, 'POST', 20000, '', {
                pgmid: obj.pgmid || 'R3TR',
                object_type: obj.type,
                object_name: obj.name,
                target_trkorr: toTransport
            }, { 'Content-Type': 'text/plain; charset=utf-8' });
            moved.push(`${obj.type} ${obj.name}`);
        } catch (error) {
            const reason = error instanceof AxiosError ? String(error.response?.data ?? error.message) : String(error);
            failed.push(`${obj.type} ${obj.name}: ${reason}`);
        }
    }

    const lines = [`Moved ${moved.length}/${objects.length} object(s) from ${fromTransport} to ${toTransport}.`];
    if (moved.length)  lines.push(...moved.map(m => `  OK: ${m}`));
    if (failed.length) lines.push(...failed.map(f => `  FAILED: ${f}`));

    if (objects.length > 0 && failed.length === 0) {
        // Reuse actionDelete's own safety net rather than a bespoke DELETE call —
        // it already refuses a non-empty transport, so a merge that somehow left
        // something behind is caught here too, not just by the failed.length check.
        const delResult = await actionDelete({ transport_number: fromTransport }, baseUrl);
        const delText = delResult?.content?.[0]?.text || '';
        lines.push(delResult?.isError ? `Source transport NOT deleted: ${delText}` : delText);
    } else if (objects.length === 0) {
        lines.push(`${fromTransport} had no objects to move — nothing to merge.`);
    } else {
        lines.push(`Source transport ${fromTransport} NOT deleted (some objects failed to move).`);
    }

    return { isError: failed.length > 0, content: [{ type: 'text', text: lines.join('\n') }] };
}

async function actionAssignObject(args: any, baseUrl: Buffer | string): Promise<any> {
    const objectName      = args.object_name ? String(args.object_name).toUpperCase() : '';
    const objectType      = args.object_type ? String(args.object_type).toUpperCase() : '';
    const transportNumber = args.transport_number ? String(args.transport_number).toUpperCase() : '';

    if (!objectName)      throw new McpError(ErrorCode.InvalidParams, 'object_name is required for action=assign_object');
    if (!objectType)      throw new McpError(ErrorCode.InvalidParams, 'object_type is required for action=assign_object');
    if (!transportNumber) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for action=assign_object');

    const prefix = TYPE_PREFIX[objectType];
    if (!prefix) {
        return { isError: true, content: [{ type: 'text', text: `Unsupported object type: ${objectType}. Supported: ${Object.keys(TYPE_PREFIX).join(', ')}` }] };
    }

    const objectUrl = `${baseUrl}${prefix}/${encodeURIComponent(objectName)}`;
    const sourceUrl = `${objectUrl}/source/main`;

    // Step 1: GET current source
    let currentSource: string;
    try {
        const srcResponse = await makeAdtRequest(String(sourceUrl), 'GET', 30000);
        currentSource = typeof srcResponse.data === 'string' ? srcResponse.data : String(srcResponse.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Object '${objectName}' not found.\nReason: ${errMsg}` }] };
        }
        return return_error(error);
    }

    // Step 2: Lock — use stateful session so the lock handle is valid for the subsequent PUT
    let lockHandle: string;
    // Purge any sap-contextid left over from an earlier call that never reached its own
    // removeCookie (e.g. process killed mid-flight) — otherwise this LOCK POST rides that
    // stale session and self-conflicts with "User X is currently editing" on a free object.
    removeCookie('sap-contextid');
    try {
        const lockResponse = await makeAdtRequest(
            String(objectUrl), 'POST', 15000, '',
            { _action: 'LOCK', accessMode: 'MODIFY' },
            { 'Accept': 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
              'X-sap-adt-sessiontype': 'stateful' }
        );
        // Append sap-contextid to global cookies so all subsequent requests use the same stateful session
        const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
        const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctxMatch) {
            appendCookie(ctxMatch[1]);
            refreshStatefulOperationToken(ctxMatch[1]);
        }

        const lockXml = typeof lockResponse.data === 'string' ? lockResponse.data : String(lockResponse.data || '');
        const convert = require('xml-js');
        const lockParsed = convert.xml2js(lockXml, { compact: true }) as any;
        lockHandle = lockParsed?.['asx:abap']?.['asx:values']?.['DATA']?.['LOCK_HANDLE']?._text || '';
        if (!lockHandle) throw new Error('Lock handle not found in response');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to lock '${objectName}'.\nReason: ${errMsg}` }] };
        }
        return return_error(error);
    }

    // Step 3: PUT source with corrNr — stateful session (via cookie) ensures lock is recognised
    try {
        const contentType = /^<\?xml\s/i.test(currentSource) ? 'application/*' : 'text/plain; charset=utf-8';
        await makeAdtRequest(
            String(sourceUrl), 'PUT', 30000, currentSource,
            { lockHandle, corrNr: transportNumber },
            { 'Content-Type': contentType, 'X-sap-adt-sessiontype': 'stateful' }
        );
    } catch (error) {
        // Try to unlock before returning error
        try {
            await makeAdtRequest(String(objectUrl), 'POST', 15000, '',
                { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
                { 'X-sap-adt-sessiontype': 'stateless' });
        } catch (_) { /* ignore */ }
        removeCookie('sap-contextid');

        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to assign '${objectName}' to transport '${transportNumber}'.\nReason: ${errMsg}` }] };
        }
        return return_error(error);
    }

    // Step 4: Unlock — close the stateful session
    try {
        await makeAdtRequest(String(objectUrl), 'POST', 15000, '',
            { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
            { 'X-sap-adt-sessiontype': 'stateless' });
    } catch (_) { /* non-fatal */ }
    removeCookie('sap-contextid');

    return {
        isError: false,
        content: [{ type: 'text', text: `${objectName} (${objectType}) assigned to transport ${transportNumber}.` }]
    };
}

export async function handleManageTransport(args: any) {
    const action = args?.action ? String(args.action).toLowerCase() : '';
    if (action === 'assign_object') {
        const objectName = args?.object_name ? String(args.object_name).toUpperCase() : 'unknown';
        const gate = acquireStatefulOperationLock(`ManageTransport(assign_object:${objectName})`);
        if (!gate.ok) return { isError: true, content: [{ type: 'text', text: gate.message }] };
        try {
            return await manageTransportCore(args);
        } finally {
            releaseStatefulOperationLock();
        }
    }
    return manageTransportCore(args);
}

async function manageTransportCore(args: any) {
    try {
        const action = args?.action ? String(args.action).toLowerCase() : '';
        if (!action) {
            throw new McpError(ErrorCode.InvalidParams, 'action is required. Supported: create, release, assign_object, set_text, delete, add_task, move_object, merge, remove_object');
        }

        const baseUrl = await getBaseUrl();

        switch (action) {
            case 'create':
                return await actionCreate(args, baseUrl);
            case 'release':
                return await actionRelease(args, baseUrl);
            case 'assign_object':
                return await actionAssignObject(args, baseUrl);
            case 'set_text':
                return await actionSetText(args, baseUrl);
            case 'delete':
                return await actionDelete(args, baseUrl);
            case 'add_task':
                return await actionAddTask(args, baseUrl);
            case 'move_object':
                return await actionMoveObject(args, baseUrl);
            case 'merge':
                return await actionMerge(args, baseUrl);
            case 'remove_object':
                return await actionRemoveObject(args, baseUrl);
            default:
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Unknown action: '${action}'. Supported: create, release, assign_object, set_text, delete, add_task, move_object, merge, remove_object` }]
                };
        }
    } catch (error) {
        return return_error(error);
    }
}
