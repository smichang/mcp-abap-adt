/**
 * Live cross-type lifecycle tests: one create → read → modify → check → activate → read-back → delete
 * pass per object kind the gateway handles, plus a read matrix over standard SAP objects.
 *
 *   interface + implementing class + classrun    ZIF_MCP_OT_DEMO / ZCL_MCP_OT_IMPL
 *   function group + function module + caller    ZMCP_OT_FG / ZMCP_OT_FM_ADD / ZCL_MCP_OT_FMCALL
 *   DDIC chain (domain → data element → structure → table type → CDS view)   ZMCP_OT_*
 *   message class                                ZMCP_OT_MSG
 *   classic screen (Dynpro) in a report          ZMCP_OT_DYN
 *   text pool in a second language               ZMCP_OT_REP
 *   transport request                            created in ZMCP, deleted again
 *   read matrix                                  standard objects only, nothing written
 *
 * Needs a live SAP system (.env or keystore). Writes ONLY disposable $TMP objects named ZMCP_OT_* /
 * ZIF_MCP_OT_* / ZCL_MCP_OT_*, deleted in afterAll (a leftover is printed). The transport test makes and
 * deletes one empty request. Not covered, on purpose: SU21 authorization objects (no delete action → not
 * disposable), SICF nodes (need a transport package).
 * Run: SECRETS_KEYSTORE=… SECRETS_KEYSTORE_PASSWORD_FILE=… npm test -- --testPathPattern=objecttypes < /dev/null
 */

import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleDeleteObject } from './handlers/handleDeleteObject';
import { handleActivateObjects } from './handlers/handleActivateObjects';
import { handleGetCode } from './handlers/handleGetCode';
import { handleGetMeta } from './handlers/handleGetMeta';
import { handleGetDiagnostics } from './handlers/handleGetDiagnostics';
import { handleRunABAP } from './handlers/handleRunABAP';
import { handleRunUnitTest } from './handlers/handleRunUnitTest';
import { handleManageDDIC } from './handlers/handleManageDDIC';
import { handleManageDynpro } from './handlers/handleManageDynpro';
import { handleManageMessageClass } from './handlers/handleManageMessageClass';
import { handleManageTransport } from './handlers/handleManageTransport';
import { handleTextPoolLang } from './handlers/handleTextPoolLang';
import { handleSearchObject } from './handlers/handleSearchObject';
import { handleDataPreview } from './handlers/handleDataPreview';
import * as utils from './lib/utils';

const text = (r: any): string => r?.content?.[0]?.text ?? '';
function mustOk(r: any, what = ''): string {
    if (r?.isError) throw new Error(`${what ? what + ': ' : ''}unexpected isError result: ${text(r)}`);
    return text(r);
}
const exists = async (name: string) => /Found \d+ object/.test(text(await handleSearchObject({ query: name })));
const read = (name: string, kind: string, extra: any = {}) => handleGetCode({ resource: 'OBJECT', object_name: name, kind, text_elements: false, ...extra });

// everything this file may create, in a safe deletion order (users of an object before the object)
const ALL: { name: string; type?: string }[] = [
    { name: 'ZMCP_OT_CDS', type: 'DDLS' }, { name: 'ZMCP_OT_TTYP', type: 'TTYP' }, { name: 'ZMCP_OT_STRU', type: 'TABL/DS' },
    { name: 'ZMCP_OT_DTEL', type: 'DTEL' }, { name: 'ZMCP_OT_DOM', type: 'DOMA' },
    { name: 'ZCL_MCP_OT_FMCALL' }, { name: 'ZMCP_OT_FM_ADD', type: 'FUGR/FF' }, { name: 'ZMCP_OT_FG', type: 'FUGR' },
    { name: 'ZCL_MCP_OT_IMPL' }, { name: 'ZIF_MCP_OT_DEMO' },
    { name: 'ZMCP_OT_DYN', type: 'PROG/P' }, { name: 'ZMCP_OT_REP', type: 'PROG/P' },
];

afterAll(async () => {
    jest.restoreAllMocks();
    for (const o of ALL) {
        if (!(await exists(o.name))) continue;
        try {
            const r = await handleDeleteObject({ object_name: o.name, ...(o.type ? { object_type: o.type } : {}) });
            if (r.isError) console.warn(`cleanup: could not delete ${o.name}: ${text(r).split('\n').slice(0, 2).join(' ')}`);
        } catch (e: any) { console.warn(`cleanup: could not delete ${o.name}: ${e?.message || e}`); }
    }
    try { await handleManageMessageClass({ action: 'delete', message_class: 'ZMCP_OT_MSG' }); } catch { /* best effort */ }
    utils.cleanup();
    await new Promise(res => setTimeout(res, 100));
});

describe('interface + implementing class', () => {
    const INTF = 'ZIF_MCP_OT_DEMO', CLS = 'ZCL_MCP_OT_IMPL';
    const intfSrc = (extra = '') => [
        `INTERFACE ${INTF.toLowerCase()} PUBLIC.`, '  METHODS add IMPORTING a TYPE i b TYPE i RETURNING VALUE(r) TYPE i.', extra, 'ENDINTERFACE.', '',
    ].join('\n');
    const clsSrc = [
        `CLASS ${CLS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`, '  PUBLIC SECTION.',
        `    INTERFACES ${INTF.toLowerCase()}.`, '    INTERFACES if_oo_adt_classrun.', 'ENDCLASS.', '',
        `CLASS ${CLS.toLowerCase()} IMPLEMENTATION.`,
        `  METHOD ${INTF.toLowerCase()}~add.`, '    r = a + b.', '  ENDMETHOD.',
        '  METHOD if_oo_adt_classrun~main.',
        `    out->write( |2+3={ ${INTF.toLowerCase()}~add( a = 2 b = 3 ) }| ).`, '  ENDMETHOD.', 'ENDCLASS.', '',
    ].join('\n');

    it('O1. creates an interface (new: INTF is creatable), reads it back, an implementing class runs', async () => {
        mustOk(await handleWriteProgram({ program_name: INTF, object_type: 'INTF', description: 'MCP cross-type e2e interface', package_name: '$TMP', source_code: intfSrc() }), 'create interface');
        expect(text(await read(INTF, 'INTF'))).toMatch(/METHODS add/i);
        mustOk(await handleWriteProgram({ program_name: CLS, object_type: 'CLAS', description: 'MCP cross-type e2e class', package_name: '$TMP', source_code: clsSrc }), 'create class');
        expect(mustOk(await handleRunABAP({ object_name: CLS }))).toContain('2+3=5');
    });

    it('O2. adding a method to the interface is reported on its implementer (warning); implementing it clears the warning', async () => {
        const broke = await handleWriteProgram({ program_name: INTF, edits: [{ old_string: 'ENDINTERFACE.', new_string: '  METHODS sub IMPORTING a TYPE i b TYPE i RETURNING VALUE(r) TYPE i.\nENDINTERFACE.' }] });
        expect(broke.isError).toBe(false); // the interface itself is fine
        // SAP's activation of the (unchanged) class says "nothing to activate"; the missing implementation
        // shows only when the class is CHECKED — and SAP rates it a WARNING on this release (the class still
        // runs), so the check reports it without failing
        const broken = await handleGetCode({ resource: 'SYNTAX', object_name: CLS });
        expect(broken.isError).toBe(false);
        expect(text(broken)).toMatch(/Implementation missing for method "ZIF_MCP_OT_DEMO~SUB"/i);
        mustOk(await handleWriteProgram({ program_name: CLS, edits: [{ old_string: `  METHOD if_oo_adt_classrun~main.`, new_string: `  METHOD ${INTF.toLowerCase()}~sub.\n    r = a - b.\n  ENDMETHOD.\n  METHOD if_oo_adt_classrun~main.` }] }), 'repair');
        expect(mustOk(await handleRunABAP({ object_name: CLS }))).toContain('2+3=5');
        expect(text(await handleGetCode({ resource: 'SYNTAX', object_name: CLS }))).not.toMatch(/Implementation missing/);
    });

    it('O3. where-used and the version list work on the interface', async () => {
        const wu = await handleGetCode({ resource: 'WHEREUSED', object_name: INTF, object_type: 'INTF', max_results: 10 });
        expect(wu.isError).toBe(false);
        const ver = text(await handleGetCode({ resource: 'VERSION', object_name: INTF, object_type: 'INTF' }));
        expect(ver).toMatch(/Version History|snapshot:/);
    });
});

describe('function group + function module', () => {
    const FG = 'ZMCP_OT_FG', FM = 'ZMCP_OT_FM_ADD', CALLER = 'ZCL_MCP_OT_FMCALL';
    const fmSrc = (op: string) => [
        `FUNCTION ${FM.toLowerCase()}`, '  IMPORTING iv_a TYPE i iv_b TYPE i', '  EXPORTING ev_sum TYPE i.', `  ev_sum = iv_a ${op} iv_b.`, 'ENDFUNCTION.', '',
    ].join('\n');
    const callerSrc = [
        `CLASS ${CALLER.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`, '  PUBLIC SECTION.', '    INTERFACES if_oo_adt_classrun.', 'ENDCLASS.', '',
        `CLASS ${CALLER.toLowerCase()} IMPLEMENTATION.`, '  METHOD if_oo_adt_classrun~main.', '    DATA lv TYPE i.',
        `    CALL FUNCTION '${FM}' EXPORTING iv_a = 7 iv_b = 5 IMPORTING ev_sum = lv.`, '    out->write( |fm={ lv }| ).', '  ENDMETHOD.', 'ENDCLASS.', '',
    ].join('\n');

    it('F1. creates the group and the module, a class calls it, a patch changes the result', async () => {
        mustOk(await handleWriteProgram({ program_name: FG, object_type: 'FUGR', description: 'MCP cross-type e2e function group', package_name: '$TMP' }), 'create FUGR');
        mustOk(await handleWriteProgram({ program_name: FM, object_type: 'FUNC', function_group: FG, description: 'MCP cross-type e2e FM', package_name: '$TMP', source_code: fmSrc('+') }), 'create FUNC');
        expect(text(await read(FM, 'FUNC', { function_group: FG }))).toMatch(/ev_sum = iv_a \+ iv_b/i);
        mustOk(await handleWriteProgram({ program_name: CALLER, object_type: 'CLAS', description: 'MCP cross-type e2e FM caller', package_name: '$TMP', source_code: callerSrc }), 'create caller');
        expect(mustOk(await handleRunABAP({ object_name: CALLER }))).toContain('fm=12');

        mustOk(await handleWriteProgram({ program_name: FM, edits: [{ old_string: 'iv_a + iv_b', new_string: 'iv_a * iv_b' }] }), 'patch FM');
        expect(mustOk(await handleRunABAP({ object_name: CALLER }))).toContain('fm=35');
    });

    it('F2. a syntax error in the module is refused before the write, and the FM is checked in its context', async () => {
        const r = await handleWriteProgram({ program_name: FM, check_only: true, source_code: fmSrc('+').replace('ev_sum =', 'ev_nothing =') });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/EV_NOTHING|unknown/i);
    });
});

describe('DDIC chain (ManageDDIC)', () => {
    const DOM = 'ZMCP_OT_DOM', DTEL = 'ZMCP_OT_DTEL', STRU = 'ZMCP_OT_STRU', TTYP = 'ZMCP_OT_TTYP', CDS = 'ZMCP_OT_CDS';

    it('D1. domain → data element → structure → table type are created and read back', async () => {
        mustOk(await handleManageDDIC({ object_type: 'DOMAIN', action: 'create', name: DOM, description: 'MCP e2e domain', package_name: '$TMP', data_type: 'CHAR', length: 10 }), 'domain');
        expect(text(await handleGetMeta({ resource: 'DDIC', object_type: 'DOMAIN', name: DOM }))).toMatch(/CHAR/i);
        mustOk(await handleManageDDIC({ object_type: 'DATA_ELEMENT', action: 'create', name: DTEL, description: 'MCP e2e data element', package_name: '$TMP', domain_name: DOM, short_label: 'OT', medium_label: 'OT medium', long_label: 'OT long label', heading_label: 'OT heading' }), 'data element');
        expect(text(await handleGetMeta({ resource: 'DDIC', object_type: 'DATA_ELEMENT', name: DTEL }))).toContain(DOM);
        mustOk(await handleManageDDIC({
            object_type: 'STRUCTURE', action: 'create', name: STRU, description: 'MCP e2e structure', package_name: '$TMP',
            source_code: `@EndUserText.label : 'MCP e2e structure'\n@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\ndefine structure ${STRU.toLowerCase()} {\n  key field1 : ${DTEL.toLowerCase()};\n  field2 : abap.int4;\n}\n`,
        }), 'structure');
        expect(text(await read(STRU, 'STRU'))).toMatch(/field1/i);
        mustOk(await handleManageDDIC({ object_type: 'TABLE_TYPE', action: 'create', name: TTYP, description: 'MCP e2e table type', package_name: '$TMP', row_type_name: STRU }), 'table type');
        expect(await exists(TTYP)).toBe(true);
    });

    it('D2. updates: domain length, data element labels, structure field', async () => {
        mustOk(await handleManageDDIC({ object_type: 'DOMAIN', action: 'update', name: DOM, data_type: 'CHAR', length: 12 }), 'domain update');
        expect(text(await handleGetMeta({ resource: 'DDIC', object_type: 'DOMAIN', name: DOM }))).toMatch(/12/);
        mustOk(await handleManageDDIC({ object_type: 'DATA_ELEMENT', action: 'update', name: DTEL, domain_name: DOM, long_label: 'OT long label v2' }), 'dtel update');
        expect(text(await handleGetMeta({ resource: 'DDIC', object_type: 'DATA_ELEMENT', name: DTEL }))).toContain('v2');
        mustOk(await handleManageDDIC({
            object_type: 'STRUCTURE', action: 'update', name: STRU,
            source_code: `@EndUserText.label : 'MCP e2e structure'\n@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\ndefine structure ${STRU.toLowerCase()} {\n  key field1 : ${DTEL.toLowerCase()};\n  field2 : abap.int4;\n  field3 : abap.char(5);\n}\n`,
        }), 'structure update');
        expect(text(await read(STRU, 'STRU'))).toMatch(/field3/i);
    });

    it('D3. a CDS view reads the system table T000; DataPreview can select from it', async () => {
        mustOk(await handleManageDDIC({
            object_type: 'CDS_VIEW', action: 'create', name: CDS, description: 'MCP e2e CDS view', package_name: '$TMP',
            source_code: `@AbapCatalog.sqlViewName: 'ZMCPOTCDSV'\n@AccessControl.authorizationCheck: #NOT_REQUIRED\n@EndUserText.label: 'MCP e2e CDS view'\ndefine view ${CDS} as select from t000 {\n  key mandt,\n  mtext\n}\n`,
        }), 'cds view');
        expect(text(await read(CDS, 'CDS'))).toMatch(/define view/i);
        const rows = await handleDataPreview({ table_name: 'ZMCPOTCDSV', max_rows: 2 });
        expect(rows.isError).toBe(false);
    });

    it('D4. batch delete takes the whole chain down, users before what they use', async () => {
        const r = await handleDeleteObject({ object_names: [
            { object_name: CDS, object_type: 'DDLS' }, { object_name: TTYP, object_type: 'TTYP' }, { object_name: STRU, object_type: 'TABL/DS' },
            { object_name: DTEL, object_type: 'DTEL' }, { object_name: DOM, object_type: 'DOMA' },
        ] });
        expect(text(r)).toMatch(/Deleted \d of 5/);
        for (const n of [CDS, TTYP, STRU, DTEL, DOM]) expect(`${n}:${await exists(n)}`).toBe(`${n}:false`);
        expect(r.isError).toBe(false);
    });
});

describe('message class (ManageMessageClass)', () => {
    const MSG = 'ZMCP_OT_MSG';
    it('M1. create with two messages, read back, update one, delete one, delete the class', async () => {
        mustOk(await handleManageMessageClass({ action: 'create', message_class: MSG, description: 'MCP e2e messages', package_name: '$TMP', messages: [{ number: '001', text: 'Hello &1' }, { number: '002', text: 'Second message' }] }), 'create');
        const first = text(await handleGetMeta({ resource: 'MESSAGE_CLASS', message_class: MSG }));
        expect(first).toContain('Hello &1');
        expect(first).toContain('Second message');
        mustOk(await handleManageMessageClass({ action: 'update', message_class: MSG, messages: [{ number: '001', text: 'Hello again &1' }] }), 'update');
        mustOk(await handleManageMessageClass({ action: 'update', message_class: MSG, delete_messages: ['002'] }), 'delete message');
        const after = text(await handleGetMeta({ resource: 'MESSAGE_CLASS', message_class: MSG }));
        expect(after).toContain('Hello again &1');
        expect(after).not.toContain('Second message');
        mustOk(await handleManageMessageClass({ action: 'delete', message_class: MSG }), 'delete');
        expect(await exists(MSG)).toBe(false);
    });
});

describe('classic screen (Dynpro)', () => {
    const PROG = 'ZMCP_OT_DYN';
    const prog = [
        `REPORT ${PROG.toLowerCase()}.`, 'DATA ok_code TYPE sy-ucomm.', 'START-OF-SELECTION.', "  WRITE / 'dyn ran'.",
        'MODULE status_0100 OUTPUT.', '  SET PF-STATUS space.', 'ENDMODULE.',
        'MODULE user_command_0100 INPUT.', '  CLEAR ok_code.', 'ENDMODULE.', '',
    ].join('\n');
    const FLOW = 'PROCESS BEFORE OUTPUT.\n  MODULE status_0100.\nPROCESS AFTER INPUT.\n  MODULE user_command_0100.';
    const def = (desc: string, flow = FLOW) => ({
        header: { program: PROG, screen: '0100', language: 'E', descript: desc, type: 'N', nextscreen: '0100', lines: 20, columns: 80 },
        containers: [{ type: 'SCREEN', name: 'SCREEN', element_of: '', line: 0, column: 0, length: 0, height: 0 }],
        fields_to_containers: [{ cont_type: 'SCREEN', cont_name: 'SCREEN', type: 'OKCODE', name: 'OK_CODE', text: '____________________', line: 0, column: 0, length: 20, vislength: 20, height: 1, format: 'CHAR', input_fld: 'X' }],
        flow_logic: flow.split('\n').map(line => ({ line })),
        params: [],
    });

    it('Y1. creates a screen, reads it back, checks it, changes flow logic and description, deletes it', async () => {
        mustOk(await handleWriteProgram({ program_name: PROG, source_code: prog, description: 'MCP dynpro e2e', package_name: '$TMP' }), 'program');
        mustOk(await handleManageDynpro({ action: 'create', program_name: PROG, dynnr: '0100', definition: def('MCP e2e screen') }), 'create screen');
        const list = text(await handleGetCode({ resource: 'DYNPRO', object_name: PROG }));
        expect(list).toContain('0100');
        const one = text(await handleGetCode({ resource: 'DYNPRO', object_name: PROG, dynnr: '0100' }));
        expect(one).toMatch(/MODULE status_0100/i);
        expect(one).toContain('MCP e2e screen');
        const chk = await handleManageDynpro({ action: 'check', program_name: PROG, dynnr: '0100' });
        expect(chk.isError).toBe(false);

        mustOk(await handleManageDynpro({ action: 'update', program_name: PROG, dynnr: '0100', description: 'MCP e2e screen v2', flow_logic: FLOW + '\n' }), 'update');
        expect(text(await handleGetCode({ resource: 'DYNPRO', object_name: PROG, dynnr: '0100' }))).toContain('v2');
    });

    it('Y2. a flow-logic line over 72 characters and a MODULE that does not exist are caught', async () => {
        const long = await handleManageDynpro({ action: 'update', program_name: PROG, dynnr: '0100', flow_logic: 'PROCESS BEFORE OUTPUT.\n  MODULE ' + 'x'.repeat(70) + '.\nPROCESS AFTER INPUT.' });
        expect(long.isError).toBe(true);
        const missing = await handleManageDynpro({ action: 'update', program_name: PROG, dynnr: '0100', flow_logic: 'PROCESS BEFORE OUTPUT.\n  MODULE no_such_module_0100.\nPROCESS AFTER INPUT.' });
        // the screen is saved (generation does not check MODULEs), but the consistency check flags it
        expect(JSON.stringify(missing)).toMatch(/NO_SUCH_MODULE|not exist|errors|102/i);
        mustOk(await handleManageDynpro({ action: 'update', program_name: PROG, dynnr: '0100', flow_logic: FLOW }), 'restore');
    });

    it('Y3. refuses a non-customer program and deletes the screen again', async () => {
        const std = await handleManageDynpro({ action: 'create', program_name: 'SAPMSSY0', dynnr: '0999', definition: def('x') });
        expect(std.isError).toBe(true);
        mustOk(await handleManageDynpro({ action: 'delete', program_name: PROG, dynnr: '0100' }), 'delete screen');
        expect(text(await handleGetCode({ resource: 'DYNPRO', object_name: PROG }))).not.toMatch(/\b0100\b.*MCP/);
    });
});

describe('text pool in another language (TextPoolLang)', () => {
    const REP = 'ZMCP_OT_REP';
    it('X1. writes a symbol in a second language, reads it back, other symbols untouched, deletes the key', async () => {
        mustOk(await handleWriteProgram({
            program_name: REP, source_code: `REPORT ${REP.toLowerCase()}.\nWRITE: / TEXT-001, / TEXT-002.\n`, description: 'MCP text pool e2e', package_name: '$TMP',
            text_symbols: '@MaxLength:20\n001=Hello\n\n@MaxLength:20\n002=World',
        }), 'program');
        mustOk(await handleTextPoolLang({ action: 'write', program_name: REP, language: 'DE', category: 'symbols', content: '@MaxLength:20\n001=Hallo', package_name: '$TMP' }), 'write DE');
        const de = text(await handleTextPoolLang({ action: 'get', program_name: REP, language: 'DE', category: 'symbols' }));
        expect(de).toContain('001=Hallo');
        const master = text(await handleGetCode({ resource: 'OBJECT', object_name: REP, text_elements: 'only' }));
        expect(master).toContain('001=Hello');
        expect(master).toContain('002=World');
        mustOk(await handleTextPoolLang({ action: 'write', program_name: REP, language: 'DE', category: 'symbols', delete_keys: ['001'], package_name: '$TMP' }), 'delete key');
        expect(text(await handleTextPoolLang({ action: 'get', program_name: REP, language: 'DE', category: 'symbols' }))).not.toContain('001=Hallo');
    });
});

describe('transport request (ManageTransport)', () => {
    it('R1. creates an empty request, renames it, finds it in the list, deletes it', async () => {
        const created = mustOk(await handleManageTransport({ action: 'create', force_new: true, description: 'MCP OT e2e (disposable)', dev_class: 'ZMCP', object_url: '/sap/bc/adt/packages/zmcp_ot_none' }), 'create');
        const trkorr = created.match(/Transport ([A-Z0-9]{3}K\d+) created/)?.[1];
        expect(trkorr).toBeTruthy();
        try {
            mustOk(await handleManageTransport({ action: 'set_text', transport_number: trkorr, description: 'MCP OT e2e renamed' }), 'rename');
            const one = text(await handleGetMeta({ resource: 'TRANSPORT', transport_number: trkorr }));
            expect(one).toContain('MCP OT e2e renamed');
        } finally {
            const del = await handleManageTransport({ action: 'delete', transport_number: trkorr });
            if (del.isError) console.warn(`cleanup: transport ${trkorr} not deleted: ${text(del).split('\n')[0]}`);
        }
    });
});

describe('paging of a very large message class', () => {
    it('P1. class 00 (927 messages) is returned in a window with a next-page hint, not whole', async () => {
        const first = text(await handleGetMeta({ resource: 'MESSAGE_CLASS', message_class: '00', max_results: 5 }));
        expect(first).toMatch(/Messages \(\d+ total, showing 5 from offset 0\)/);
        expect(first).toMatch(/more — next page: offset=5/);
        expect(first.length).toBeLessThan(2000);
        const next = text(await handleGetMeta({ resource: 'MESSAGE_CLASS', message_class: '00', max_results: 5, offset: 5 }));
        expect(next).toMatch(/showing 5 from offset 5/);
        expect(next).not.toBe(first);
        const dflt = text(await handleGetMeta({ resource: 'MESSAGE_CLASS', message_class: '00' }));
        expect(dflt).toMatch(/showing 200 from offset 0/);
    });
});

describe('read matrix over standard objects (nothing written)', () => {
    const cases: [string, () => Promise<any>, RegExp][] = [
        ['report source',        () => read('RSUSR002', 'PROG'),                                  /REPORT/i],
        ['class source',         () => read('CL_ABAP_TYPEDESCR', 'CLAS'),                         /CLASS cl_abap_typedescr/i],
        ['interface source',     () => read('IF_MESSAGE', 'INTF'),                                /INTERFACE if_message/i],
        ['transparent table',    () => read('T000', 'TABL'),                                      /MANDT/i],
        ['structure',            () => read('BAPIRET2', 'STRU'),                                  /MESSAGE/i],
        ['data element',         () => read('MATNR', 'DTEL'),                                     /MATNR/i],
        ['domain',               () => read('MATNR', 'DOMA'),                                     /MATNR|CHAR/i],
        ['function module',      () => read('RFC_READ_TABLE', 'FUNC'),                            /FUNCTION/i],
        ['function group',       () => read('SYST', 'FUGR'),                                      /./],
        ['CDS view (system)',    () => read('I_COUNTRY', 'CDS'),                                  /define/i],
        ['meta: package',        () => handleGetMeta({ resource: 'PACKAGE', package_name: 'ZMCP', max_results: 5 }), /ZMCP|object/i],
        ['meta: type info',      () => handleGetMeta({ resource: 'TYPEINFO', type_name: 'BAPIRET2' }), /BAPIRET2/i],
        ['meta: transaction',    () => handleGetMeta({ resource: 'TRANSACTION', transaction_name: 'SE38' }), /SE38/i],
        ['meta: message class',  () => handleGetMeta({ resource: 'MESSAGE_CLASS', message_class: '00' }), /./],
        ['meta: DDIC dtel',      () => handleGetMeta({ resource: 'DDIC', object_type: 'DATA_ELEMENT', name: 'MATNR' }), /MATNR/i],
        ['meta: DDIC domain',    () => handleGetMeta({ resource: 'DDIC', object_type: 'DOMAIN', name: 'MATNR' }), /./],
        ['where-used',           () => handleGetCode({ resource: 'WHEREUSED', object_name: 'ZCL_MCP_AUTH_OBJECT', object_type: 'CLAS', max_results: 3 }), /./],
        ['version list',         () => handleGetCode({ resource: 'VERSION', object_name: 'ZCL_MCP_TRANSPORT_E2E', object_type: 'CLAS' }), /./],
        ['search',               () => handleSearchObject({ query: 'CL_ABAP_TYPEDESCR' }),         /CL_ABAP_TYPEDESCR/],
        ['data preview',         () => handleDataPreview({ table_name: 'T000', max_rows: 2 }),     /MANDT/i],
        ['runtime dumps list',   () => handleGetDiagnostics({ resource: 'DUMP', maxResults: 3 }),  /./],
        ['inactive objects',     () => handleGetMeta({ resource: 'INACTIVE_OBJECTS' }),            /./],
    ];
    it.each(cases)('G. %s', async (_name, call, expected) => {
        const r = await call();
        expect(r.isError).toBeFalsy(); // some readers leave isError undefined on success
        expect(text(r)).toMatch(expected);
    });
});
