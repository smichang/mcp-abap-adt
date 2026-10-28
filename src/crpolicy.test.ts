/**
 * Live tests for the "one CR per goal" policy (lib/resolveTransport.ts): rule 1/2 on the transportable
 * anchor class, the ManageTransport create guard, and rule 3 (join a colleague's CR with an own task).
 *
 * Needs a live SAP system (.env or keystore). Writes nothing by default.
 * Rule 3 needs an object that a COLLEAGUE currently holds in an open CR (do not pick one you would
 * not want a task added to):
 *   MCP_TEST_FOREIGN_URI=/sap/bc/adt/oo/classes/zcl_x   -> read-only: expects the decision "join their CR"
 *   MCP_TEST_FOREIGN_JOIN=1                              -> also adds YOUR task to that CR (add_task)
 *                                                           and re-reads the check; the task stays (a
 *                                                           task of yours in a foreign CR is harmless
 *                                                           and is what rule 3 asks for).
 *
 * WRITE suite (opt-in, MCP_TEST_CR_WRITE=1) — creates disposable objects in a TRANSPORTABLE package, so it
 * leaves CTS entries behind (cleanup is best effort and reported):
 *   MCP_TEST_CR_PACKAGE=ZBASIS  MCP_TEST_CR_FUGR=ZBASIS     package / existing function group to write into
 *   MCP_TEST_FOREIGN_CR=S4DK925128  MCP_TEST_FOREIGN_TASK=S4DK925129
 *       an EMPTY, throwaway CR of ANOTHER user and that user's task: the test moves one of its own objects
 *       into that task (so it looks held by a colleague) and then expects rule 3 to join the CR.
 *   Objects: ZMCP_CR_T1..T3 (reports), ZMCP_CR_FM (function module, only with MCP_TEST_CR_FM=1), a test CR "MCP CR policy test".
 * Run: SECRETS_KEYSTORE=… SECRETS_KEYSTORE_PASSWORD_FILE=… npm test -- --testPathPattern=crpolicy < /dev/null
 */

import { getBaseUrl } from './lib/utils';
import { getConfig } from './index';
import { fetchTransportCheck } from './lib/transportCheck';
import { resolveTransport } from './lib/resolveTransport';
import { handleManageTransport, addTaskToTransport, getExistingTasks } from './handlers/handleManageTransport';
import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleDeleteObject } from './handlers/handleDeleteObject';
import { handleSearchObject } from './handlers/handleSearchObject';

const ANCHOR_URI = '/sap/bc/adt/oo/classes/zcl_mcp_transport_e2e';
const FOREIGN_URI = process.env.MCP_TEST_FOREIGN_URI || '';
const text = (r: any) => String(r?.content?.[0]?.text ?? '');

let base = '';
let me = '';
beforeAll(async () => { base = String(await getBaseUrl()); me = getConfig().username.toUpperCase(); });

describe('one CR per goal — live', () => {
    test('anchor class: the decision is one of use / create, never an exception', async () => {
        const d = await resolveTransport(base, [ANCHOR_URI], me);
        expect(['use', 'create', 'conflict']).toContain(d.kind);
    });

    test('ManageTransport create is refused while a CR could be reused, and nothing is created', async () => {
        const d = await resolveTransport(base, [ANCHOR_URI], me, { devclass: 'ZAIMCP', goalHint: 'MCP CR policy (disposable)' });
        const r = await handleManageTransport({ action: 'create', description: 'MCP CR policy (disposable)', dev_class: 'ZAIMCP', object_url: ANCHOR_URI });
        if (d.kind === 'use' || d.kind === 'conflict') {
            expect(r.isError).toBe(true);
            expect(text(r)).toContain('Nothing was created');
            if (d.kind === 'use') expect(text(r)).toContain(d.transportNumber);
        } else {
            // no CR to reuse: the create goes through — remove the request again
            expect(r.isError).toBeFalsy();
            const nr = text(r).match(/Transport (\w+) created/)?.[1];
            if (nr) await handleManageTransport({ action: 'delete', transport_number: nr });
        }
    });

    test('a new function module in ZBASIS resolves to the request that holds the group\'s other modules', async () => {
        const group = '/sap/bc/adt/functions/groups/zbasis';
        const g = await fetchTransportCheck(base, group, 'ZBASIS');
        if (!g.holders.length) return;   // no FM of the group is in an open request right now: nothing to assert
        const d = await resolveTransport(base, [`${group}/fmodules/zmcp_cr_probe_fm`, group], me, { devclass: 'ZBASIS' });
        expect(['use', 'conflict']).toContain(d.kind);
        if (d.kind === 'use') expect(g.holders.map(h => h.request.number)).toContain(d.transportNumber);
    });

    const foreign = FOREIGN_URI ? test : test.skip;
    foreign('rule 3: an object held by a colleague resolves to THEIR CR', async () => {
        const d = await resolveTransport(base, [FOREIGN_URI], me);
        expect(d).toMatchObject({ kind: 'use' });
        const check = await fetchTransportCheck(base, FOREIGN_URI);
        const owners = check.holders.map(h => h.request.owner.toUpperCase());
        if (owners.every(o => o !== me)) expect(d).toMatchObject({ rule: 3, transportNumber: check.holders[0].request.number });
    });

    const join = FOREIGN_URI && process.env.MCP_TEST_FOREIGN_JOIN === '1' ? test : test.skip;
    join('rule 3: add_task on a colleague\'s CR works and the check then sees the own task', async () => {
        const before = await fetchTransportCheck(base, FOREIGN_URI);
        const crNo = before.holders[0].request.number;
        const hadTask = before.holders[0].tasks.some(t => t.owner.toUpperCase() === me);
        if (!hadTask) {
            const t = await addTaskToTransport(base, crNo, me);
            expect(t.error).toBeUndefined();     // a refusal here is the finding: rule 3 needs authorization on the foreign CR
            expect(t.taskNumber).toBeTruthy();
        }
        const after = await fetchTransportCheck(base, FOREIGN_URI);
        const h = after.holders.find(x => x.request.number === crNo)!;
        // the object is still held by the colleague's task, and our task now exists in the same request
        expect(h).toBeDefined();
        const d = await resolveTransport(base, [FOREIGN_URI], me);
        expect(d).toMatchObject({ kind: 'use', transportNumber: crNo });
    });
});

// ───────────────────────────── WRITE suite ─────────────────────────────
const WRITE = process.env.MCP_TEST_CR_WRITE === '1';
const PKG = process.env.MCP_TEST_CR_PACKAGE || 'ZBASIS';
const FUGR = process.env.MCP_TEST_CR_FUGR || 'ZBASIS';
const FOREIGN_CR = process.env.MCP_TEST_FOREIGN_CR || '';
const FOREIGN_TASK = process.env.MCP_TEST_FOREIGN_TASK || '';
const T1 = 'ZMCP_CR_T1', T2 = 'ZMCP_CR_T2', T3 = 'ZMCP_CR_T3', FM = 'ZMCP_CR_FM';
const WITH_FM = process.env.MCP_TEST_CR_FM === '1';   // an FM leaves a CTS lock on its function group that only the group's holder CR can delete
const CR_TEXT = 'MCP CR policy test (disposable)';
const prog = (n: string, extra = '') => `REPORT ${n.toLowerCase()}.\nWRITE / 'cr policy test'.${extra}\n`;
const fmSrc = (v: string) => ['FUNCTION ' + FM.toLowerCase(), '  IMPORTING iv_a TYPE i', '  EXPORTING ev_b TYPE i.', `  ev_b = iv_a + ${v}.`, 'ENDFUNCTION.', ''].join('\n');
const uriOf = (n: string) => `/sap/bc/adt/programs/programs/${n.toLowerCase()}`;
const leftovers: string[] = [];
// ADT's quick search is eventually consistent: a just-created object can be missing from it for a few seconds
const untilSearchable = async (name: string) => {
    for (let i = 0; i < 15; i++) {
        if (!/No objects found/i.test(text(await handleSearchObject({ query: name, maxResults: 5 })))) return;
        await new Promise(r => setTimeout(r, 1000));
    }
};

(WRITE ? describe : describe.skip)('one CR per goal — writes in ' + PKG, () => {
    let testCr = '';
    let addedTask = '';   // our own task in the foreign CR (rule-3 test)
    let openBefore = 0;

    const openCrs = async () => (await fetchTransportCheck(base, uriOf('zmcp_cr_probe_none'), PKG)).candidates
        .filter(c => c.owner.toUpperCase() === me && c.status === 'D').map(c => c.number);

    beforeAll(async () => {
        for (const n of [T1, T2, T3, ...(WITH_FM ? [FM] : [])]) {
            const r = text(await handleSearchObject({ query: n, maxResults: 3 }));
            if (!/No objects found/i.test(r) && new RegExp(`\\b${n}\\b`, 'i').test(r)) throw new Error(`${n} already exists — refusing to touch it`);
        }
        openBefore = (await openCrs()).length;
    }, 60000);

    afterAll(async () => {
        if (!testCr) return;   // nothing was written (a name was taken, or the create failed)
        // delete the objects first (FM and reports), then clear their CTS entries and the test CR
        for (const [name, type, extra] of [...(WITH_FM ? [[FM, 'FUNC', { function_group: FUGR }] as const] : []), [T1, 'PROG', {}] as const, [T2, 'PROG', {}] as const, [T3, 'PROG', {}] as const]) {
            try {
                const chk = await fetchTransportCheck(base, name === FM ? `/sap/bc/adt/functions/groups/${FUGR.toLowerCase()}/fmodules/${FM.toLowerCase()}` : uriOf(name), PKG);
                const cr = chk.holders[0]?.request.number || testCr;
                const r = await handleDeleteObject({ object_name: name, object_type: type, transport_number: cr, ...extra });
                if (r.isError) leftovers.push(`${name}: ${text(r).split('\n')[0]}`);
            } catch (e: any) { leftovers.push(`${name}: ${e?.message || e}`); }
        }
        // CTS keeps a deletion entry per deleted object: clear it from every task of the CRs, then drop the test CR
        for (const cr of [testCr, FOREIGN_CR].filter(Boolean)) {
            for (const task of await getExistingTasks(base, cr)) {
                for (const [pgmid, type, name] of [['R3TR', 'PROG', T1], ['R3TR', 'PROG', T2], ['R3TR', 'PROG', T3], ['LIMU', 'FUNC', FM], ['R3TR', 'FUGR', FUGR]] as const) {
                    if (type === 'FUGR') continue;   // the group itself is never ours to touch
                    try { await handleManageTransport({ action: 'remove_object', pgmid, object_type: type, object_name: name, transport_number: task }); } catch { /* not in this task */ }
                }
            }
        }
        if (addedTask) {   // an empty task of ours in the colleague's CR: remove it again
            const r = await handleManageTransport({ action: 'delete', transport_number: addedTask });
            if (!r.isError) leftovers.splice(leftovers.findIndex(l => l.startsWith('task ')), 1);
        }
        if (testCr) {
            const r = await handleManageTransport({ action: 'delete', transport_number: testCr });
            if (!r.isError) leftovers.splice(leftovers.findIndex(l => l.startsWith('test CR')), 1);
            else leftovers.push(`delete ${testCr}: ${text(r).split('\n').slice(0, 2).join(' ')}`);
        }
        if (leftovers.length) console.warn('CR policy test leftovers — clean up by hand (ManageTransport remove_object / delete):\n' + leftovers.join('\n'));
    }, 180000);

    test('0. a test CR is created on purpose (force_new) — it becomes the newest open CR', async () => {
        const r = await handleManageTransport({ action: 'create', force_new: true, description: CR_TEXT, dev_class: PKG, object_type: 'PROG', object_name: T1 });
        expect(r.isError).toBeFalsy();
        testCr = text(r).match(/Transport (\w+) created/)![1];
        leftovers.push(`test CR ${testCr} (${CR_TEXT}) — delete after its objects are removed`);
        expect((await openCrs()).length).toBe(openBefore + 1);
    }, 60000);

    test('1. rule 1: a NEW object with transport_description reuses the open CR instead of creating one', async () => {
        const r = await handleWriteProgram({ program_name: T1, description: 'MCP CR policy test 1', package_name: PKG, source_code: prog(T1), transport_description: CR_TEXT });
        expect(r.isError ? text(r).slice(0, 1500) : 'ok').toBe('ok');
        expect(text(r)).toContain(`Transport: ${testCr}`);
        expect(text(r)).toMatch(/CR choice — rule 1/);
        expect(text(r)).not.toContain('(auto-created)');
        expect((await openCrs()).length).toBe(openBefore + 1);   // no extra CR
    }, 120000);

    test('2. rule 1: a second new object lands in the same CR', async () => {
        const r = await handleWriteProgram({ program_name: T2, description: 'MCP CR policy test 2', package_name: PKG, source_code: prog(T2), transport_description: CR_TEXT });
        expect(r.isError ? text(r).slice(0, 1500) : 'ok').toBe('ok');
        expect(text(r)).toContain(`Transport: ${testCr}`);
        expect((await openCrs()).length).toBe(openBefore + 1);
    }, 120000);

    (WITH_FM ? test : test.skip)('3. rule 1 on a function module of an existing function group', async () => {
        const r = await handleWriteProgram({ program_name: FM, object_type: 'FUNC', function_group: FUGR, description: 'MCP CR policy test FM', package_name: PKG, source_code: fmSrc('1'), transport_description: CR_TEXT });
        expect(text(r)).toContain(`Transport: ${testCr}`);
        expect(r.isError).toBeFalsy();
        expect((await openCrs()).length).toBe(openBefore + 1);
    }, 180000);

    test('4. an existing object, no transport_number: the write keeps its CR (rule 1)', async () => {
        await untilSearchable(T1);
        const r = await handleWriteProgram({ program_name: T1, edits: [{ old_string: "'cr policy test'", new_string: "'cr policy test 4'" }] });
        expect(r.isError ? text(r).slice(0, 1500) : 'ok').toBe('ok');
        expect(text(r)).toContain(`Transport: ${testCr}`);
    }, 120000);

    test('5. ManageTransport create for a new object is refused while a CR can be reused', async () => {
        const r = await handleManageTransport({ action: 'create', description: 'MCP CR policy dup', dev_class: PKG, object_type: 'PROG', object_name: 'ZMCP_CR_T9' });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain('Nothing was created');
        expect(text(r)).toContain(testCr);
        expect((await openCrs()).length).toBe(openBefore + 1);
    }, 60000);

    // A colleague's task cannot be fabricated with one SAP user: CTS_WBO_API_INSERT_OBJECTS refuses
    // "Task S4DK925129 not usable due to incorrect status, type, or owner" when move_object targets another
    // user's task (found live 2026-10-27). So the join mechanics are tested against a CR OWNED BY ANOTHER USER:
    // add_task for ourselves, then a write into that CR. Detection of a foreign holder is the read-only test above.
    const rule3 = FOREIGN_CR ? test : test.skip;
    rule3('6. rule 3 mechanics: own task in another user\'s CR, and a write recorded there', async () => {
        const before = await getExistingTasks(base, FOREIGN_CR);
        const t = await addTaskToTransport(base, FOREIGN_CR, me);
        expect(t.error).toBeUndefined();             // a refusal here = rule 3 needs authorization on the foreign CR
        expect(t.taskNumber).toBeTruthy();
        addedTask = t.taskNumber!;
        leftovers.push(`task ${t.taskNumber} of ${me} in foreign CR ${FOREIGN_CR} (it had ${before.join(',') || 'no task'} before)`);
        expect((await getExistingTasks(base, FOREIGN_CR))).toContain(t.taskNumber);

        // a NEW object written with that CR as transport_number lands there (in our task)
        const w = await handleWriteProgram({ program_name: T3, description: 'MCP CR policy test 3', package_name: PKG, source_code: prog(T3), transport_number: FOREIGN_CR });
        expect(w.isError).toBeFalsy();
        expect(text(w)).toContain(`Transport: ${FOREIGN_CR}`);
        // ...and a later write without transport_number keeps that CR (our task is in it: rule 1), no new CR
        await untilSearchable(T3);
        const again = await handleWriteProgram({ program_name: T3, edits: [{ old_string: "'cr policy test'", new_string: "'cr policy test 6'" }] });
        expect(again.isError ? text(again).slice(0, 1500) : 'ok').toBe('ok');
        expect(text(again)).toContain(`Transport: ${FOREIGN_CR}`);
        expect((await openCrs()).length).toBe(openBefore + 1);
    }, 180000);
});
