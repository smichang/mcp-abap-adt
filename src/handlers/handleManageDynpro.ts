import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl } from '../lib/utils';
import * as fs from 'fs/promises';
import { writeTranslation } from './dynproTranslation';
import * as path from 'path';

// Writes classic SAP GUI screens (Dynpro) through ZCL_HTTP_MCP_DYNPRO (package
// ZMCP), the standalone SICF service at default_host/zmcp/dynpro — NOT an
// ADT resource (ADT has no screen write contract). The ABAP side wraps
// RPY_DYNPRO_INSERT / RS_SCRP_DELETE; its behavior was probed live before the
// wrapper was built:
//   - SAP locks the screen and records LIMU DYNP itself; the endpoint passes
//     the request (a task is resolved to its request) so the entry lands in
//     the caller's task;
//   - the write is generated immediately (active) — no ActivateObjects step;
//   - a generation error rolls back, the existing screen stays unchanged;
//   - a subscreen area without CALL SUBSCREEN in PBO/PAI is refused before
//     anything is written;
//   - a screen already recorded in a different open request is refused (409)
//     instead of SAP silently keeping it in the other request;
//   - after a successful write the endpoint runs SE51's consistency check
//     (it commits implicitly, so it can only report, not undo) and flags the
//     result in header x-mcp-check: errors | warnings | ok. "errors" (e.g. a
//     MODULE the program does not define) is returned as isError — the
//     screen IS saved, it just won't work until the program is fixed.
// One stateless HTTP call per action, so no stateful-operation gate is needed
// (same as TextPoolLang / ManageAuthObject); SAP's enqueue covers concurrency.

const FLOW_LINE_MAX = 72;    // D022S-LINE (DYNTXLINE, CHAR72)
const DESCRIPTION_MAX = 60;  // RPY_DYHEAD-DESCRIPT (SCRHDTXT, CHAR60)

// screen_attributes: SE51 Attributes-tab names -> RPY_DYHEAD fields.
// Live-verified 2026-10-02: every field below writes and reads back exactly
// (create with all set, update back to defaults, type M -> I).
const SCREEN_TYPES: Record<string, string> = {
    n: 'N', normal: 'N', i: 'I', subscreen: 'I', m: 'M', modal: 'M', modal_dialog: 'M', modal_dialog_box: 'M',
};
const FLAG_ATTRIBUTES: Record<string, string> = {
    hold_data: 'hold_data',
    switch_off_runtime_compression: 'no_compr',
    hold_scroll_position: 'keep_scpos',
    without_application_toolbar: 'no_toolbar',
    fiori_no_enlargement: 'fiorienlargeoff',
};
const ATTRIBUTE_NAMES = ['type', 'next_screen', 'cursor_position', 'screen_group', 'lines', 'columns',
    'context_menu', ...Object.keys(FLAG_ATTRIBUTES)];

export async function handleManageDynpro(args: any) {
    try {
        const action = args?.action ? String(args.action).trim().toLowerCase() : '';
        const program = args?.program_name ? String(args.program_name).trim().toUpperCase() : '';
        const dynnrArg = args?.dynnr !== undefined && args.dynnr !== null ? String(args.dynnr).trim() : '';
        const transport = args?.transport_number ? String(args.transport_number).trim().toUpperCase() : '';

        if (!['create', 'update', 'delete', 'check', 'translate'].includes(action)) {
            throw new McpError(ErrorCode.InvalidParams, 'action must be "create", "update", "delete", "check" or "translate"');
        }
        if (!program) {
            throw new McpError(ErrorCode.InvalidParams, 'program_name is required (the program owning the screen; SAPL<group> for a function group)');
        }
        if (!/^\d{1,4}$/.test(dynnrArg)) {
            throw new McpError(ErrorCode.InvalidParams, `dynnr is required, 1-4 digits (got "${dynnrArg}")`);
        }
        const dynnr = dynnrArg.padStart(4, '0');

        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/zmcp/dynpro`;
        const params: Record<string, string> = { program, dynnr };
        if (transport) params.trkorr = transport;

        if (action === 'translate') {
            // Target-language texts only (what SE63 does) — the master-language screen is not touched.
            return await writeTranslation(program, dynnr, args?.language !== undefined ? String(args.language) : '', args?.translations);
        }
        if (action === 'delete') {
            const response = await makeAdtRequest(url, 'DELETE', 30000, undefined, params);
            return { isError: false, content: [{ type: 'text', text: String(response.data ?? '') }] };
        }
        if (action === 'check') {
            const response = await makeAdtRequest(url, 'GET', 60000, undefined, { program, dynnr, check: 'true' });
            return checkedResult(response);
        }

        const definition = await buildDefinition(args, action, url, program, dynnr);
        const body = JSON.stringify(definition);
        const response = await makeAdtRequest(url, 'POST', 60000, body, { ...params, mode: action }, {
            'Content-Type': 'application/json; charset=utf-8'
        });
        return checkedResult(response);
    } catch (error) {
        return return_error(error);
    }
}

function checkedResult(response: any) {
    const text = String(response.data ?? '');
    const check = String(response.headers?.['x-mcp-check'] ?? '').toLowerCase();
    return { isError: check === 'errors', content: [{ type: 'text', text }] };
}

// The full definition comes from `definition` / `definition_file` (the JSON
// GetCode resource=DYNPRO raw=true returns). On update it may be omitted when
// only flow logic and/or the description change: the current definition is
// read first and just those parts are replaced.
async function buildDefinition(args: any, action: string, url: string, program: string, dynnr: string): Promise<any> {
    let definition: any;
    const defFile = args?.definition_file ? String(args.definition_file) : '';
    const defArg = args?.definition;

    if (defFile) {
        const resolved = path.resolve(defFile);
        let text: string;
        try {
            text = await fs.readFile(resolved, 'utf8');
        } catch (e: any) {
            throw new McpError(ErrorCode.InvalidParams, `Could not read definition_file '${resolved}': ${e?.message || String(e)}`);
        }
        definition = parseDefinition(text, `definition_file '${resolved}'`);
    } else if (defArg !== undefined && defArg !== null && defArg !== '') {
        definition = typeof defArg === 'string' ? parseDefinition(defArg, 'definition') : defArg;
    }

    const flowLogic = await readFlowLogic(args);
    const description = args?.description !== undefined && args.description !== null ? String(args.description) : undefined;
    // Validate the caller's own input before any SAP round trip.
    if (flowLogic !== undefined) validateFlowLines(flowLogic);
    if (description !== undefined && description.length > DESCRIPTION_MAX) {
        throw new McpError(ErrorCode.InvalidParams, `description is ${description.length} characters, max ${DESCRIPTION_MAX}`);
    }
    const headerPatch = parseScreenAttributes(args?.screen_attributes);

    if (!definition) {
        if (action === 'create') {
            throw new McpError(ErrorCode.InvalidParams,
                'action=create needs definition or definition_file (screen JSON). Tip: take GetCode resource=DYNPRO raw=true of a similar screen, adapt it, and pass it here.');
        }
        if (flowLogic === undefined && description === undefined && headerPatch === undefined) {
            throw new McpError(ErrorCode.InvalidParams,
                'action=update needs definition / definition_file, or flow_logic / flow_logic_file, description and/or screen_attributes to change only those parts');
        }
        const current = await makeAdtRequest(url, 'GET', 30000, undefined, { program, dynnr });
        definition = typeof current.data === 'string' ? JSON.parse(current.data) : current.data;
    }

    if (typeof definition !== 'object' || Array.isArray(definition)) {
        throw new McpError(ErrorCode.InvalidParams, 'definition must be a JSON object { header, containers, fields_to_containers, flow_logic, params }');
    }
    if (flowLogic !== undefined) {
        definition.flow_logic = flowLogic.map(line => ({ line }));
    }
    if (description !== undefined) {
        definition.header = { ...(definition.header ?? {}), descript: description };
    }
    if (headerPatch !== undefined) {
        definition.header = { ...(definition.header ?? {}), ...headerPatch };
    }
    // Eval 2026-10-02 finding 1: an unknown type code ("1") was saved.
    const type = String(definition.header?.type ?? '').trim();
    if (type && !['N', 'I', 'M'].includes(type)) {
        throw new McpError(ErrorCode.InvalidParams, ['S', 'J', 'W'].includes(type)
            ? `header.type "${type}" is a selection screen — those come from SELECTION-SCREEN statements; change the program source instead`
            : `header.type "${type}" is not valid — use N (normal), I (subscreen) or M (modal dialog box)`);
    }
    // Eval 2026-10-02 finding 2: requ_entry "N" means "no input" and SAP then
    // silently drops input_fld "X" (TEXT elements carry "N"; copying one to
    // build an input field produced a field nobody can type into).
    const conflicting = (Array.isArray(definition.fields_to_containers) ? definition.fields_to_containers : [])
        .filter((f: any) => f?.input_fld === 'X' && f?.requ_entry === 'N')
        .map((f: any) => f?.name || '(unnamed)');
    if (conflicting.length) {
        throw new McpError(ErrorCode.InvalidParams,
            `element(s) ${conflicting.join(', ')}: input_fld "X" with requ_entry "N" — "N" means input not possible, SAP would silently drop the input. ` +
            'Use requ_entry "" (input possible), "R" (recommended) or "O" (required) for an input field, or clear input_fld.');
    }
    // SAP cannot generate template screens ("Template dynpros cannot be
    // generated", live 2026-10-02) - refuse before the round trip.
    if (definition.header?.no_execute === 'X') {
        throw new McpError(ErrorCode.InvalidParams,
            'header.no_execute = "X" (SE51 "Template - non-executable") is not supported: SAP cannot generate template screens. Clear it to write the screen.');
    }

    const flow = Array.isArray(definition.flow_logic) ? definition.flow_logic : [];
    if (flow.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'flow_logic is empty — at least PROCESS BEFORE OUTPUT. / PROCESS AFTER INPUT. are required');
    }
    validateFlowLines(flow.map((l: any) => String(l?.line ?? '')));
    return definition;
}

function validateFlowLines(lines: string[]) {
    const tooLong = lines
        .map((l, i) => ({ n: i + 1, len: l.length }))
        .filter(x => x.len > FLOW_LINE_MAX);
    if (tooLong.length) {
        throw new McpError(ErrorCode.InvalidParams,
            `flow logic lines longer than ${FLOW_LINE_MAX} characters (SAP would cut them): ` +
            tooLong.slice(0, 10).map(x => `line ${x.n} (${x.len})`).join(', '));
    }
}

// Turns screen_attributes ({ type: "modal", hold_data: true, next_screen: "200" ... })
// into RPY_DYHEAD fields. Unknown names / bad values are rejected, never guessed.
function parseScreenAttributes(raw: any): Record<string, any> | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    let attrs = raw;
    if (typeof raw === 'string') {
        try { attrs = JSON.parse(raw); } catch (e: any) {
            throw new McpError(ErrorCode.InvalidParams, `screen_attributes is not valid JSON: ${e?.message || String(e)}`);
        }
    }
    if (typeof attrs !== 'object' || Array.isArray(attrs)) {
        throw new McpError(ErrorCode.InvalidParams, 'screen_attributes must be an object, e.g. {"type":"modal","hold_data":true}');
    }
    const unknown = Object.keys(attrs).filter(k => !ATTRIBUTE_NAMES.includes(k));
    if (unknown.length) {
        const hint = unknown.some(k => k === 'template' || k === 'no_execute')
            ? ' ("Template - non-executable" is not supported: SAP cannot generate template screens)' : '';
        throw new McpError(ErrorCode.InvalidParams,
            `unknown screen_attributes: ${unknown.join(', ')}${hint}. Allowed: ${ATTRIBUTE_NAMES.join(', ')}`);
    }

    const patch: Record<string, any> = {};
    const bad = (msg: string) => { throw new McpError(ErrorCode.InvalidParams, `screen_attributes.${msg}`); };
    for (const [key, value] of Object.entries(attrs)) {
        const text = value === null || value === undefined ? '' : String(value).trim();
        switch (key) {
            case 'type': {
                const code = SCREEN_TYPES[text.toLowerCase()];
                if (!code) bad(`type "${text}": use normal (N), subscreen (I) or modal (M) — selection screens come from SELECTION-SCREEN statements`);
                patch.type = code;
                break;
            }
            case 'next_screen':
                if (text !== '' && !/^\d{1,4}$/.test(text)) bad(`next_screen "${text}" must be 1-4 digits (or "" for none)`);
                patch.nextscreen = text === '' ? '' : text.padStart(4, '0');
                break;
            case 'cursor_position':
                if (text.length > 132) bad(`cursor_position is ${text.length} characters, max 132`);
                patch.cursor_pos = text.toUpperCase();
                break;
            case 'screen_group':
                if (text.length > 4) bad(`screen_group "${text}" is longer than 4 characters`);
                patch.screen_grp = text.toUpperCase();
                break;
            case 'lines':
            case 'columns':
                if (!/^\d{1,3}$/.test(text) || Number(text) < 1) bad(`${key} "${text}" must be a whole number 1-999`);
                patch[key] = Number(text);
                break;
            case 'context_menu': {
                // accepts "MYMENU" or "ON_CTMENU_MYMENU"; RPY_DYHEAD keeps the suffix only
                const name = text.toUpperCase().replace(/^ON_CTMENU_/, '');
                if (name.length > 20) bad(`context_menu "${name}" is longer than 20 characters (the part after ON_CTMENU_)`);
                patch.ctx_menon = name;
                break;
            }
            default: {
                if (typeof value !== 'boolean') bad(`${key} must be true or false`);
                patch[FLAG_ATTRIBUTES[key]] = value ? 'X' : '';
            }
        }
    }
    return patch;
}

function parseDefinition(text: string, label: string): any {
    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new McpError(ErrorCode.InvalidParams, `${label} is not valid JSON: ${e?.message || String(e)}`);
    }
}

async function readFlowLogic(args: any): Promise<string[] | undefined> {
    let text: string | undefined;
    if (args?.flow_logic_file) {
        const resolved = path.resolve(String(args.flow_logic_file));
        try {
            text = await fs.readFile(resolved, 'utf8');
        } catch (e: any) {
            throw new McpError(ErrorCode.InvalidParams, `Could not read flow_logic_file '${resolved}': ${e?.message || String(e)}`);
        }
    } else if (args?.flow_logic !== undefined && args.flow_logic !== null) {
        text = String(args.flow_logic);
    }
    if (text === undefined) return undefined;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines;
}
