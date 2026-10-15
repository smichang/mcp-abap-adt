/**
 * Live integration tests for the 3.10.0 additions: RunABAP, ManagePackage, GetCode SYNTAX (+ include
 * master context, INCL alias), RunATCCheck on objects / worklists / verdict, WriteProgram apply_patch
 * and local snapshots, GetCode OBJECT text_elements.
 *
 * Needs a live SAP system (.env or keystore). Writes ONLY disposable $TMP objects, all named
 * ZMCP_NT_* / $ZMCP_NT_*, created in beforeAll and deleted in afterAll:
 *   ZMCP_NT_E2E (report) + ZMCP_NT_E2EF01 (its include), ZCL_MCP_NT_RUN (classrun),
 *   ZCL_MCP_NT_NOIF (no classrun interface), package $ZMCP_NT_PKG (created inside its own test).
 * Run: SECRETS_KEYSTORE=… SECRETS_KEYSTORE_PASSWORD_FILE=… npm test -- --testPathPattern=newtools < /dev/null
 * (stdin must be closed in a non-interactive shell or jest never exits).
 */

import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleDeleteObject } from './handlers/handleDeleteObject';
import { handleActivateObjects } from './handlers/handleActivateObjects';
import { handleGetCode } from './handlers/handleGetCode';
import { handleRunABAP } from './handlers/handleRunABAP';
import { handleRunATCCheck } from './handlers/handleRunATCCheck';
import { handleManagePackage } from './handlers/handleManagePackage';
import { handleDataPreview } from './handlers/handleDataPreview';
import { handleSearchObject } from './handlers/handleSearchObject';
import { handleRunUnitTest } from './handlers/handleRunUnitTest';
import { runSyntaxCheck } from './lib/syntaxCheck';
import * as utils from './lib/utils';

const MAIN = 'ZMCP_NT_E2E';
const INC = 'ZMCP_NT_E2EF01';
const CLS_RUN = 'ZCL_MCP_NT_RUN';
const CLS_NOIF = 'ZCL_MCP_NT_NOIF';
const PKG = '$ZMCP_NT_PKG';
const CLS_CI = 'ZCL_MCP_NT_CI';
const CLS_SHELL = 'ZCL_MCP_NT_SHELL';
const CLS_FIRST = 'ZCL_MCP_NT_FIRST';

const MAIN_SRC = [
    `REPORT ${MAIN.toLowerCase()}.`,
    `INCLUDE ${INC.toLowerCase()}.`,
    'START-OF-SELECTION.',
    "  WRITE / 'nt ran'.",
    '  PERFORM nt_form USING 2.',
    '',
].join('\n');
const INC_SRC = [
    'FORM nt_form USING p TYPE i.',
    "  WRITE: / 'form got', p.",
    'ENDFORM.',
    '',
].join('\n');

const text = (r: any): string => r?.content?.[0]?.text ?? '';
function mustOk(r: any) {
    if (r?.isError) throw new Error('unexpected isError result: ' + text(r));
    return text(r);
}
const lines = (s: string) => s.replace(/\r\n/g, '\n');

// Best effort, but never silent: a leftover disposable object is printed so it can be removed by hand.
const del = async (name: string, type?: string) => {
    try {
        const r = await handleDeleteObject({ object_name: name, ...(type ? { object_type: type } : {}) });
        if (r.isError && !/not found/i.test(text(r))) console.warn(`cleanup: could not delete ${name}: ${text(r).split('\n').slice(0, 2).join(' ')}`);
    } catch (e: any) {
        console.warn(`cleanup: could not delete ${name}: ${e?.message || e}`);
    }
};

beforeAll(async () => {
    // main first (it gives the include its master program), both inactive, then one mass activation
    mustOk(await handleWriteProgram({
        program_name: MAIN, source_code: MAIN_SRC, description: 'MCP 3.7 tools e2e (disposable)', package_name: '$TMP', activate: false,
        text_symbols: '@MaxLength:20\n001=Hello nt',
    }));
    mustOk(await handleWriteProgram({
        program_name: INC, object_type: 'INCL', source_code: INC_SRC, description: 'MCP 3.7 tools e2e include', package_name: '$TMP', activate: false,
    }));
    mustOk(await handleActivateObjects({ names: [MAIN, INC] }));
    mustOk(await handleWriteProgram({
        program_name: CLS_RUN, object_type: 'CLAS', description: 'MCP RunABAP e2e', package_name: '$TMP',
        source_code: [
            `CLASS ${CLS_RUN.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
            '  PUBLIC SECTION.', '    INTERFACES if_oo_adt_classrun.', 'ENDCLASS.', '',
            `CLASS ${CLS_RUN.toLowerCase()} IMPLEMENTATION.`,
            '  METHOD if_oo_adt_classrun~main.',
            "    out->write( |nt class ran in client { sy-mandt }| ).",
            '  ENDMETHOD.', 'ENDCLASS.', '',
        ].join('\n'),
    }));
    mustOk(await handleWriteProgram({
        program_name: CLS_NOIF, object_type: 'CLAS', description: 'MCP RunABAP e2e no interface', package_name: '$TMP',
        source_code: [
            `CLASS ${CLS_NOIF.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`, 'ENDCLASS.', '',
            `CLASS ${CLS_NOIF.toLowerCase()} IMPLEMENTATION.`, 'ENDCLASS.', '',
        ].join('\n'),
    }));
});

afterAll(async () => {
    jest.restoreAllMocks();
    await del(CLS_RUN);
    await del(CLS_NOIF);
    await del(CLS_CI);
    // objects of the batch-delete test, in case it failed half way (program before its include)
    await del('ZMCP_NT_DEL1', 'PROG/P');
    await del('ZMCP_NT_DEL1F', 'PROG/I');
    await del('ZCL_MCP_NT_DEL');
    await del(CLS_SHELL);
    await del(CLS_FIRST);
    // the program first: SAP keeps an include that a program still includes
    await del(MAIN, 'PROG/P');
    await del(INC, 'PROG/I');
    await del(PKG, 'DEVC');
    utils.cleanup();
    await new Promise(res => setTimeout(res, 100));
});

describe('RunABAP', () => {
    it('R1. runs a classrun class and returns its output', async () => {
        const out = mustOk(await handleRunABAP({ object_name: CLS_RUN }));
        expect(out).toMatch(/nt class ran in client \d+/);
    });

    it('R2. a class without IF_OO_ADT_CLASSRUN is an error (SAP answers 200 + "Error:")', async () => {
        const r = await handleRunABAP({ object_name: CLS_NOIF });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/does not implement if_oo_adt_classrun/i);
    });

    it('R3. a report needs confirm_side_effects; with it the list output comes back', async () => {
        const refused = await handleRunABAP({ object_name: MAIN });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain('confirm_side_effects');
        const out = mustOk(await handleRunABAP({ object_name: MAIN, confirm_side_effects: true }));
        expect(out).toContain('nt ran');
        expect(out).toMatch(/form got\s+2/);
    });

    it('R4. an unknown object and an include are refused', async () => {
        const missing = await handleRunABAP({ object_name: 'ZMCP_NT_NO_SUCH_THING' });
        expect(missing.isError).toBe(true);
        expect(text(missing)).toMatch(/not found/i);
        const inc = await handleRunABAP({ object_name: INC, object_type: 'PROG/I', confirm_side_effects: true });
        expect(inc.isError).toBe(true);
        expect(text(inc)).toMatch(/include/i);
    });
});

describe('RunABAP confirmation for classes outside a local package', () => {
    it('R5. a standard class and a transportable class are refused WITHOUT confirm_side_effects, before anything runs', async () => {
        const std = await handleRunABAP({ object_name: 'CL_ABAP_TYPEDESCR' });
        expect(std.isError).toBe(true);
        expect(text(std)).toMatch(/not a local \(\$\) package/);
        expect(text(std)).toContain('confirm_side_effects=true');
        const transportable = await handleRunABAP({ object_name: 'ZCL_MCP_TRANSPORT_E2E' });
        expect(transportable.isError).toBe(true);
        expect(text(transportable)).toMatch(/package ZMCP/);
    });

    it('R6. with confirm_side_effects=true the call goes through (the anchor class has no classrun interface, so SAP answers that); a $TMP class still needs none', async () => {
        const r = await handleRunABAP({ object_name: 'ZCL_MCP_TRANSPORT_E2E', confirm_side_effects: true });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/does not implement if_oo_adt_classrun/i);
        expect(text(r)).not.toMatch(/not a local/);
        expect(mustOk(await handleRunABAP({ object_name: CLS_RUN }))).toMatch(/nt class ran/);
    });
});

describe('GetCode SYNTAX + include master context', () => {
    it('S1. a clean program has no errors, and object_type INCL resolves (alias)', async () => {
        const main = await handleGetCode({ resource: 'SYNTAX', object_name: MAIN });
        expect(main.isError).toBe(false);
        const inc = await handleGetCode({ resource: 'SYNTAX', object_name: INC, object_type: 'INCL' });
        expect(inc.isError).toBe(false);
        expect(text(inc)).toContain(`master program ${MAIN}`);
    });

    it('S2. a saved-inactive error is found with its real line:col', async () => {
        mustOk(await handleWriteProgram({ program_name: MAIN, activate: false, edits: [{ old_string: 'WRITE / \'nt ran\'.', new_string: 'WRITE / lv_undefined.' }] }));
        try {
            const r = await handleGetCode({ resource: 'SYNTAX', object_name: MAIN });
            expect(r.isError).toBe(true);
            expect(text(r)).toMatch(/E line 4:\d+ — .*LV_UNDEFINED/i);
        } finally {
            mustOk(await handleWriteProgram({ program_name: MAIN, source_code: MAIN_SRC }));
        }
    });

    it('S3. an object without /source/main and an unknown name are clear errors', async () => {
        const dtel = await handleGetCode({ resource: 'SYNTAX', object_name: 'MANDT', object_type: 'DTEL' });
        expect(dtel.isError).toBe(true);
        expect(text(dtel)).toMatch(/no source\/main/i);
        const none = await handleGetCode({ resource: 'SYNTAX', object_name: 'ZMCP_NT_NO_SUCH_THING' });
        expect(none.isError).toBe(true);
    });

    it('S4. a type error against the MASTER is caught when the include is checked in context (and missed alone)', async () => {
        const broken = INC_SRC.replace('p TYPE i', 'p TYPE string');
        const r = await handleWriteProgram({ program_name: INC, check_only: true, source_code: broken });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain(`master program ${MAIN}`);
        expect(text(r)).toMatch(/not type-compatible|type-compatible/i);
        // the contrast that motivated the fix: the same text checked ALONE has no error
        const base = String(await utils.getBaseUrl());
        const alone = await runSyntaxCheck(base, `/sap/bc/adt/programs/includes/${INC.toLowerCase()}`, broken);
        expect(alone.errors).toBe(0);
    });
});

describe('WriteProgram apply_patch and local snapshots', () => {
    const edit = [{ old_string: "'form got', p", new_string: "'form saw', p" }];

    it('P1. a passed dry run returns an id; applying it writes, snapshots, and the id binds to its object', async () => {
        const dry = mustOk(await handleWriteProgram({ program_name: INC, check_only: true, edits: edit }));
        const id = dry.match(/apply_patch="(p-[0-9a-f]{8})"/)?.[1];
        expect(id).toBeTruthy();

        const wrong = await handleWriteProgram({ program_name: MAIN, apply_patch: id });
        expect(wrong.isError).toBe(true);
        expect(text(wrong)).toContain(`was made for ${INC}`);
        const both = await handleWriteProgram({ program_name: INC, apply_patch: id, edits: edit });
        expect(both.isError).toBe(true);
        const unknown = await handleWriteProgram({ program_name: INC, apply_patch: 'p-00000000' });
        expect(unknown.isError).toBe(true);

        const applied = mustOk(await handleWriteProgram({ program_name: INC, apply_patch: id }));
        expect(applied).toMatch(/Previous source kept as local snapshot \d{8}-\d{6}-\d{3}/);
        expect(applied).toContain('Patched with 1 edit');
        const now = lines(text(await handleGetCode({ resource: 'OBJECT', object_name: INC, kind: 'INCL' })));
        expect(now).toContain("'form saw', p");
    });

    it('P2. GetCode VERSION lists the snapshots and diffs against them', async () => {
        const list = text(await handleGetCode({ resource: 'VERSION', object_name: INC, object_type: 'INCL' }));
        expect(list).toMatch(/Local pre-write snapshots \(\d+/);
        const id = list.match(/snapshot:(\d{8}-\d{6}-\d{3})/)?.[1];
        expect(id).toBeTruthy();
        const diff = mustOk(await handleGetCode({ resource: 'VERSION', object_name: INC, object_type: 'INCL', compare_to: `snapshot:${id}` }));
        expect(diff).toContain("-  WRITE: / 'form got', p.");
        expect(diff).toContain("+  WRITE: / 'form saw', p.");
        const latest = mustOk(await handleGetCode({ resource: 'VERSION', object_name: INC, object_type: 'INCL', version: 'snapshot:latest' }));
        expect(latest).toContain("'form got', p");
        const bad = await handleGetCode({ resource: 'VERSION', object_name: INC, object_type: 'INCL', version: 'snapshot:19990101-000000-000' });
        expect(bad.isError).toBe(true);
        expect(text(bad)).toContain('Available: snapshot:');
    });
});

describe('RunATCCheck objects / worklist / verdict', () => {
    let worklist = '';

    it('A1. checks an object, states a verdict, and a finding does not make the CALL an error', async () => {
        const r = await handleRunATCCheck({ objects: [MAIN] });
        const t = text(r);
        expect(r.isError).toBe(false);
        expect(t).toMatch(/worklist: [0-9A-F]{32}/);
        expect(t).toMatch(/Verdict: (PASS|FAIL)/);
        worklist = t.match(/worklist: ([0-9A-F]{32})/)![1];
    });

    it('A2. the worklist can be re-read without a new run; an unknown id is refused', async () => {
        const again = await handleRunATCCheck({ worklist_id: worklist });
        expect(again.isError).toBe(false);
        expect(text(again)).toContain('re-read, no new run');
        const bogus = await handleRunATCCheck({ worklist_id: 'NOT-A-REAL-WORKLIST' });
        expect(bogus.isError).toBe(true);
        expect(text(bogus)).toMatch(/not found|not an ATC worklist/i);
    });

    it('A4. fail_on_error: a run that FINDS errors is a successful call by default, an error on request; a clean run is never an error', async () => {
        // ZBMM0001 is read-only here (nothing is written): its ATC result has priority-1 findings
        const dflt = await handleRunATCCheck({ objects: ['ZBMM0001'] });
        expect(dflt.isError).toBe(false);
        expect(text(dflt)).toMatch(/Verdict: FAIL/);
        expect(text(dflt)).toContain('The tool call itself succeeded.');
        const strict = await handleRunATCCheck({ objects: ['ZBMM0001'], fail_on_error: true });
        expect(strict.isError).toBe(true);
        expect(text(strict)).toMatch(/Verdict: FAIL/);
        expect(text(strict)).toContain('Returned as an error because fail_on_error=true.');
        expect(text(strict)).not.toContain('The tool call itself succeeded.');
        const clean = await handleRunATCCheck({ objects: ['ZCL_MCP_TRANSPORT_E2E'], fail_on_error: true });
        expect(clean.isError).toBe(false);
        expect(text(clean)).toMatch(/Verdict: PASS/);
    });

    it('A3. exactly one target; an unresolvable name is reported, not silently clean', async () => {
        const none = await handleRunATCCheck({});
        expect(none.isError).toBe(true);
        const two = await handleRunATCCheck({ objects: [MAIN], transport_numbers: ['S4DK000000'] });
        expect(two.isError).toBe(true);
        const mixed = await handleRunATCCheck({ objects: [MAIN, 'ZMCP_NT_NO_SUCH_THING'] });
        expect(text(mixed)).toContain('NOT RESOLVED');
        const allBad = await handleRunATCCheck({ objects: ['ZMCP_NT_NO_SUCH_THING'] });
        expect(allBad.isError).toBe(true);
    });
});

describe('GetCode OBJECT text_elements', () => {
    it('T1. true appends the text symbols, false returns the source only, "only" the bare blocks', async () => {
        const withEl = text(await handleGetCode({ resource: 'OBJECT', object_name: MAIN }));
        expect(withEl).toContain('Text Symbols');
        expect(withEl).toContain('001=Hello nt');
        const none = text(await handleGetCode({ resource: 'OBJECT', object_name: MAIN, text_elements: false }));
        expect(none).not.toContain('Text Symbols');
        expect(none).toMatch(/INCLUDE/i);
        const only = text(await handleGetCode({ resource: 'OBJECT', object_name: MAIN, text_elements: 'only' }));
        expect(only).toContain('--- text_symbols ---');
        expect(only).toContain('001=Hello nt');
        expect(only).not.toMatch(/START-OF-SELECTION/i);
    });
});

describe('ManagePackage', () => {
    it('K1. creates a $ package, updates its description (read back from TDEVCT), deletes it', async () => {
        mustOk(await handleManagePackage({ action: 'create', package_name: PKG, description: 'MCP 3.7 e2e package' }));
        const read = async () => text(await handleDataPreview({ query: `SELECT tdevct~ctext FROM tdevct WHERE tdevct~devclass = '${PKG}'` }));
        expect(await read()).toContain('MCP 3.7 e2e package');
        mustOk(await handleManagePackage({ action: 'update', package_name: PKG, description: 'MCP 3.7 e2e package v2' }));
        expect(await read()).toContain('MCP 3.7 e2e package v2');
        const noop = mustOk(await handleManagePackage({ action: 'update', package_name: PKG, description: 'MCP 3.7 e2e package v2' }));
        expect(noop).toMatch(/already has the requested values/);
        mustOk(await handleDeleteObject({ object_name: PKG, object_type: 'DEVC' }));
        expect(await read()).toContain('(no data)');
    });

    it('K2. refuses bad input before any call', async () => {
        const noAction = await handleManagePackage({ package_name: PKG });
        expect(noAction.isError).toBe(true);
        const badName = await handleManagePackage({ action: 'create', package_name: 'NOT_CUSTOMER_PKG', description: 'x' });
        expect(badName.isError).toBe(true);
        const noTransport = await handleManagePackage({ action: 'create', package_name: 'ZMCP_NT_NOTRANSPORT', description: 'x', software_component: 'HOME' });
        expect(noTransport.isError).toBe(true);
        expect(text(noTransport)).toMatch(/transport_number is required/);
        const nothing = await handleManagePackage({ action: 'update', package_name: PKG });
        expect(nothing.isError).toBe(true);
    });
});

describe('class_include (local test classes), shell cleanup, check positions', () => {
    const GLOBAL = [
        `CLASS ${CLS_CI.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
        '  PUBLIC SECTION.',
        '    CLASS-METHODS double IMPORTING iv TYPE i RETURNING VALUE(rv) TYPE i.',
        'ENDCLASS.', '',
        `CLASS ${CLS_CI.toLowerCase()} IMPLEMENTATION.`,
        '  METHOD double.', '    rv = iv * 2.', '  ENDMETHOD.', 'ENDCLASS.', '',
    ].join('\n');
    const TESTS = (exp: number) => [
        'CLASS ltc_double DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.',
        '  PRIVATE SECTION.', '    METHODS twice FOR TESTING.', 'ENDCLASS.', '',
        'CLASS ltc_double IMPLEMENTATION.', '  METHOD twice.',
        `    cl_abap_unit_assert=>assert_equals( act = ${CLS_CI.toLowerCase()}=>double( 21 ) exp = ${exp} ).`,
        '  ENDMETHOD.', 'ENDCLASS.', '',
    ].join('\n');
    const exists = async (name: string) => /Found \d+ object/.test(text(await handleSearchObject({ query: name })));

    it('C1. creates the testclasses include, runs green, patches it red, fixes it green', async () => {
        mustOk(await handleWriteProgram({ program_name: CLS_CI, object_type: 'CLAS', description: 'MCP class_include e2e', package_name: '$TMP', source_code: GLOBAL }));
        const created = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', source_code: TESTS(42) }));
        // "Created and wrote" normally; "Wrote" when SAP already provides the include on a just-created class
        // (seen once, not reproducible) — the behaviour is right either way
        expect(created).toMatch(/(Created and wrote|Wrote) the 'testclasses' include/);
        expect(created).toMatch(/Mass activation \[OK\]/);
        expect(text(await handleRunUnitTest({ object_name: CLS_CI }))).toMatch(/1 passed, 0 failed/);

        const red = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', edits: [{ old_string: 'exp = 42', new_string: 'exp = 43' }] }));
        expect(red).toContain('Patched with 1 edit');
        expect(red).toMatch(/Previous 'testclasses' include kept as local snapshot/);
        const failed = await handleRunUnitTest({ object_name: CLS_CI });
        expect(failed.isError).toBe(true);
        expect(text(failed)).toMatch(/Expected \[43\] Actual \[42\]/);

        mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', source_code: TESTS(42) }));
        expect(text(await handleRunUnitTest({ object_name: CLS_CI }))).toMatch(/1 passed, 0 failed/);
    });

    it('C2. the include (and its snapshots) read back; the class overview lists snapshots too', async () => {
        const back = text(await handleGetCode({ resource: 'VERSION', object_name: CLS_CI, object_type: 'CLAS', class_include: 'testclasses', version: 'active' }));
        expect(back).toContain('CLASS ltc_double DEFINITION');
        const list = text(await handleGetCode({ resource: 'VERSION', object_name: CLS_CI, object_type: 'CLAS', class_include: 'testclasses' }));
        expect(list).toMatch(/Local pre-write snapshots.*\(\d+/);
        const id = list.match(/snapshot:(\d{8}-\d{6}-\d{3})/)?.[1];
        expect(id).toBeTruthy();
        const diff = mustOk(await handleGetCode({ resource: 'VERSION', object_name: CLS_CI, object_type: 'CLAS', class_include: 'testclasses', compare_to: `snapshot:${id}` }));
        expect(diff).toMatch(/exp = 4[23]/);
        const overview = text(await handleGetCode({ resource: 'VERSION', object_name: CLS_CI, object_type: 'CLAS' }));
        expect(overview).toContain('include testclasses');
    });

    const include = async () => lines(text(await handleGetCode({ resource: 'VERSION', object_name: CLS_CI, object_type: 'CLAS', class_include: 'testclasses', version: 'active' })));
    const broken = () => TESTS(42).replace(`act = ${CLS_CI.toLowerCase()}=>double( 21 )`, 'act = lv_undefined');

    it('C6. the class is syntax-checked with the new include text BEFORE the lock: a broken include is reported by unit, nothing is written', async () => {
        const before = await include();
        const dry = await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', check_only: true, source_code: broken() });
        expect(dry.isError).toBe(true);
        expect(text(dry)).toContain(`${CLS_CI} (testclasses)`);
        expect(text(dry)).toMatch(/LV_UNDEFINED/i);
        expect(text(dry)).toMatch(/nothing was locked or written/i);
        const real = await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', source_code: broken() });
        expect(real.isError).toBe(true);
        expect(text(real)).toMatch(/Nothing was locked or written/);
        expect(await include()).toBe(before);
        const clean = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', check_only: true, source_code: TESTS(42) }));
        expect(clean).toMatch(/Check only — nothing was locked or written/);
    });

    it('C7. syntax_check=false opts out (the broken include is saved; activation then reports it); a clean write reports the check', async () => {
        const r = await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', syntax_check: false, activate: false, source_code: broken() });
        expect(r.isError).toBe(false);
        expect(text(r)).toContain("Wrote the 'testclasses' include");
        expect(await include()).toContain('lv_undefined');
        const fixed = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', source_code: TESTS(42) }));
        expect(fixed).toMatch(/Syntax check: no messages|0 error/i);
        expect(text(await handleRunUnitTest({ object_name: CLS_CI }))).toMatch(/1 passed, 0 failed/);
    });

    it('C8. GetCode OBJECT class_include reads a local include as stored (the read twin of the write); main/other errors are clear', async () => {
        const inc = text(await handleGetCode({ resource: 'OBJECT', object_name: CLS_CI, kind: 'CLAS', class_include: 'testclasses' }));
        expect(inc).toContain('CLASS ltc_double DEFINITION');
        expect(inc).not.toMatch(/CLASS-METHODS double/i); // not the global class
        const main = text(await handleGetCode({ resource: 'OBJECT', object_name: CLS_CI, kind: 'CLAS', class_include: 'main' }));
        expect(main).toMatch(/CLASS-METHODS double/i);
        const macros = await handleGetCode({ resource: 'OBJECT', object_name: CLS_CI, kind: 'CLAS', class_include: 'macros' });
        expect(macros.isError).toBe(false); // SAP's standard (boilerplate) macros include exists
        const nonsense = await handleGetCode({ resource: 'OBJECT', object_name: CLS_CI, kind: 'CLAS', class_include: 'nonsense' });
        expect(nonsense.isError).toBe(true);
        const notClass = await handleGetCode({ resource: 'OBJECT', object_name: MAIN, kind: 'PROG', class_include: 'testclasses' });
        expect(notClass.isError).toBe(true);
        expect(text(notClass)).toMatch(/only valid for a class/);
        // round trip: what is read can be written back unchanged (no snapshot is made for identical text)
        const back = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', source_code: inc, activate: false }));
        expect(back).not.toMatch(/kept as local snapshot/);
    });

    it('C9. a passed dry run of a local-include patch is applied by id; ids are bound to their own include and class', async () => {
        const cls = CLS_CI.toLowerCase();
        const edits = [
            { old_string: '    METHODS twice FOR TESTING.', new_string: '    METHODS twice FOR TESTING.\n    METHODS thrice FOR TESTING.' },
            { old_string: '  ENDMETHOD.\nENDCLASS.', new_string: `  ENDMETHOD.\n  METHOD thrice.\n    cl_abap_unit_assert=>assert_equals( act = ${cls}=>double( 3 ) exp = 6 ).\n  ENDMETHOD.\nENDCLASS.` },
        ];
        const dry = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', check_only: true, edits }));
        const id = dry.match(/apply_patch="(p-[0-9a-f]{8})"/)?.[1];
        expect(id).toBeTruthy();
        expect(dry).toContain('class_include="testclasses"');

        // bound to this include of this class: not another include, not the class's main source, not combined with edits
        const otherInclude = await handleWriteProgram({ program_name: CLS_CI, class_include: 'definitions', apply_patch: id });
        expect(otherInclude.isError).toBe(true);
        expect(text(otherInclude)).toContain(`was made for ${CLS_CI}.TESTCLASSES`);
        const mainSource = await handleWriteProgram({ program_name: CLS_CI, apply_patch: id });
        expect(mainSource.isError).toBe(true);
        const both = await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', apply_patch: id, edits });
        expect(both.isError).toBe(true);
        expect(text(both)).toMatch(/cannot be combined/);

        const applied = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', apply_patch: id }));
        expect(applied).toContain('Patched with 2 edit');
        expect(text(await handleRunUnitTest({ object_name: CLS_CI }))).toMatch(/2 passed, 0 failed/);
        // no id from a dry run that is not a patch (source_code)
        const plain = mustOk(await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', check_only: true, source_code: TESTS(42) }));
        expect(plain).not.toContain('apply_patch=');
    });

    it('C10. the FIRST write of a testclasses include cannot be pre-checked (SAP cannot compile an include that does not exist) — and says so; afterwards the pre-check works', async () => {
        const first = CLS_FIRST.toLowerCase();
        mustOk(await handleWriteProgram({
            program_name: CLS_FIRST, object_type: 'CLAS', description: 'MCP first include e2e', package_name: '$TMP',
            source_code: `CLASS ${first} DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS ${first} IMPLEMENTATION.\nENDCLASS.\n`,
        }));
        const bad = TESTS(42).replace(CLS_CI.toLowerCase(), first).replace(`act = ${first}=>double( 21 )`, 'act = lv_undefined');
        const good = TESTS(42).replace(`${CLS_CI.toLowerCase()}=>double( 21 )`, '21').replace('exp = 42', 'exp = 21');

        // a dry run must not claim "0 errors" for a text it could not compile
        const dry = await handleWriteProgram({ program_name: CLS_FIRST, class_include: 'testclasses', check_only: true, source_code: bad });
        expect(dry.isError).toBe(false);
        expect(text(dry)).toMatch(/NOT CHECKED/);
        expect(text(dry)).not.toMatch(/0 error/);

        // the real first write goes through (nothing to check against); the activation then reports the error
        const first_ = await handleWriteProgram({ program_name: CLS_FIRST, class_include: 'testclasses', source_code: bad });
        expect(text(first_)).toMatch(/NOT CHECKED/);
        expect(first_.isError).toBe(true);
        expect(text(first_)).toMatch(/LV_UNDEFINED/i);

        // the include exists now, so the pre-check is real: the same broken text is refused before the lock
        const again = await handleWriteProgram({ program_name: CLS_FIRST, class_include: 'testclasses', source_code: bad });
        expect(again.isError).toBe(true);
        expect(text(again)).toMatch(/Nothing was locked or written/);
        expect(text(again)).not.toMatch(/NOT CHECKED/);

        // and a fix is accepted and activates
        mustOk(await handleWriteProgram({ program_name: CLS_FIRST, class_include: 'testclasses', source_code: good }));
        expect(text(await handleRunUnitTest({ object_name: CLS_FIRST }))).toMatch(/1 passed, 0 failed/);
    });

    it('C3. bad input is refused before any SAP write', async () => {
        const bad = await handleWriteProgram({ program_name: CLS_CI, class_include: 'nonsense', source_code: 'x' });
        expect(bad.isError).toBe(true);
        const two = await handleWriteProgram({ program_name: CLS_CI, class_include: 'testclasses', source_code: 'x', edits: [{ old_string: 'a', new_string: 'b' }] });
        expect(two.isError).toBe(true);
        const noClass = await handleWriteProgram({ program_name: 'ZCL_MCP_NT_NO_SUCH_CLASS', class_include: 'testclasses', source_code: 'x' });
        expect(noClass.isError).toBe(true);
        expect(text(noClass)).toMatch(/not found/i);
    });

    it('C4. a local class in the main source is refused with the real cause, and no shell is left behind', async () => {
        const r = await handleWriteProgram({
            program_name: CLS_SHELL, object_type: 'CLAS', description: 'MCP shell cleanup e2e', package_name: '$TMP',
            source_code: GLOBAL.replace(new RegExp(CLS_CI, 'gi'), CLS_SHELL) + TESTS(42).replace(new RegExp(CLS_CI, 'gi'), CLS_SHELL),
        });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/more than the one global class|FOR TESTING/);
        expect(text(r)).toContain('class_include=testclasses');
        expect(text(r)).toMatch(/removed again|nothing is left behind/);
        expect(await exists(CLS_SHELL)).toBe(false);
    });

    it('C5. a finding that sits in the master program names its unit', async () => {
        const broken = INC_SRC.replace('p TYPE i', 'p TYPE string');
        const r = await handleWriteProgram({ program_name: INC, check_only: true, source_code: broken });
        expect(r.isError).toBe(true);
        // the error is at the PERFORM call in the main program, not in the 3-line include
        expect(text(r)).toMatch(new RegExp(`${MAIN} line \\d+`));
    });
});

describe('DeleteObject object_names (batch) and the transport note', () => {
    const P = 'ZMCP_NT_DEL1', I = 'ZMCP_NT_DEL1F', C = 'ZCL_MCP_NT_DEL';
    const exists = async (name: string) => /Found \d+ object/.test(text(await handleSearchObject({ query: name })));

    it('D1. deletes a program, its include and a class in one call, in order, with no transport noise for $TMP', async () => {
        mustOk(await handleWriteProgram({ program_name: P, source_code: `REPORT ${P.toLowerCase()}.\nINCLUDE ${I.toLowerCase()}.\n`, description: 'MCP batch delete e2e', package_name: '$TMP', activate: false }));
        mustOk(await handleWriteProgram({ program_name: I, object_type: 'INCL', source_code: 'WRITE 1.\n', description: 'MCP batch delete e2e inc', package_name: '$TMP', activate: false }));
        mustOk(await handleActivateObjects({ names: [P, I] }));
        mustOk(await handleWriteProgram({
            program_name: C, object_type: 'CLAS', description: 'MCP batch delete e2e class', package_name: '$TMP',
            source_code: `CLASS ${C.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS ${C.toLowerCase()} IMPLEMENTATION.\nENDCLASS.\n`,
        }));
        expect(await exists(P)).toBe(true);
        expect(await exists(I)).toBe(true);
        expect(await exists(C)).toBe(true);

        const r = await handleDeleteObject({ object_names: [{ object_name: P, object_type: 'PROG/P' }, { object_name: I, object_type: 'PROG/I' }, C] });
        const t = text(r);
        expect(r.isError).toBe(false);
        expect(t).toMatch(/Deleted 3 of 3 object/);
        expect((t.match(/✓/g) || []).length).toBe(3);
        expect(t).not.toMatch(/transport's object list/);
        expect(await exists(P)).toBe(false);
        expect(await exists(I)).toBe(false);
        expect(await exists(C)).toBe(false);
    });

    it('D2. reports each failure and carries on; refuses bad shapes', async () => {
        const r = await handleDeleteObject({ object_names: ['ZMCP_NT_NO_SUCH_THING'] });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/Deleted 0 of 1.*1 failed/);
        expect(text(r)).toContain('✗ ZMCP_NT_NO_SUCH_THING');
        const empty = await handleDeleteObject({ object_names: [] });
        expect(empty.isError).toBe(true);
        const both = await handleDeleteObject({ object_name: 'X', object_names: ['Y'] });
        expect(both.isError).toBe(true);
        const none = await handleDeleteObject({});
        expect(none.isError).toBe(true);
    });
});

describe('stateful-operation gate under parallel calls', () => {
    const edit = (tag: string) => [{ old_string: 'ENDFORM.', new_string: `" gate-${tag}\nENDFORM.` }];
    const body = async () => lines(text(await handleGetCode({ resource: 'OBJECT', object_name: INC, kind: 'INCL' })));

    it('G1. two WriteProgram calls fired together: exactly one runs, the other is refused at once, nothing is corrupted', async () => {
        const [a, b] = await Promise.all([
            handleWriteProgram({ program_name: INC, activate: false, edits: edit('A') }),
            handleWriteProgram({ program_name: INC, activate: false, edits: edit('B') }),
        ]);
        const ok = [a, b].filter(r => !r.isError);
        const refused = [a, b].filter(r => r.isError);
        expect(ok).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(text(refused[0])).toMatch(/Blocked: a stateful SAP MCP operation/);
        const now = await body();
        expect(now.match(/" gate-/g)).toHaveLength(1); // exactly one marker: no lost update, no double write
        // restore
        mustOk(await handleWriteProgram({ program_name: INC, activate: false, edits: [{ old_string: /" gate-[AB]\n/.exec(now)![0], new_string: '' }] }));
        expect(await body()).not.toContain('gate-');
    });

    it('G2. a WriteProgram and a DeleteObject fired together: the second is refused, no lock is left behind', async () => {
        const [w, d] = await Promise.all([
            handleWriteProgram({ program_name: INC, activate: false, edits: edit('C') }),
            handleDeleteObject({ object_name: 'ZMCP_NT_NO_SUCH_THING' }),
        ]);
        expect(w.isError).toBe(false);
        expect(d.isError).toBe(true);
        expect(text(d)).toMatch(/Blocked: a stateful SAP MCP operation/);
        // the lock of the write was released: a follow-up write goes straight through
        const now = await body();
        mustOk(await handleWriteProgram({ program_name: INC, activate: false, edits: [{ old_string: /" gate-C\n/.exec(now)![0], new_string: '' }] }));
        expect(await body()).not.toContain('gate-');
    });
});
