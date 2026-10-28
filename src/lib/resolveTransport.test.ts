/**
 * Offline test (no SAP) of the "one CR per goal" decision. Check bodies are built the way the live
 * transportchecks answers look (see transportCheck.test.ts); `./utils` is mocked because the real one
 * imports the server entry, which needs SAP credentials.
 */
jest.mock('./utils', () => ({ makeAdtRequest: jest.fn() }));

import { parseTransportCheck } from './transportCheck';
import { decideTransport, describeDecision } from './resolveTransport';

const H = (n: string, u: string, t = 'txt', st = 'D') => `<TRKORR>${n}</TRKORR><TRSTATUS>${st}</TRSTATUS><TARSYSTEM>/ZS4Q/</TARSYSTEM><AS4USER>${u}</AS4USER><AS4TEXT>${t}</AS4TEXT>`;
const req = (n: string, u: string, t = 'txt', st = 'D') => `<CTS_REQUEST><REQ_HEADER>${H(n, u, t, st)}</REQ_HEADER><REQ_ATTRS/><TASK_HEADERS/></CTS_REQUEST>`;
const lock = (r: string, ru: string, tasks: [string, string][]) =>
    `<CTS_OBJECT_LOCK><LOCK_HOLDER><REQ_HEADER>${H(r, ru)}</REQ_HEADER><TASK_HEADERS>${tasks.map(([n, u]) => `<CTS_TASK_HEADER>${H(n, u)}</CTS_TASK_HEADER>`).join('')}</TASK_HEADERS></LOCK_HOLDER></CTS_OBJECT_LOCK>`;
const check = (opts: { rec?: string; requests?: string; locks?: string }) =>
    parseTransportCheck(`<asx:abap><asx:values><DATA><PGMID>LIMU</PGMID><OBJECT>REPS</OBJECT><OBJECTNAME>ZX</OBJECTNAME><DEVCLASS>ZCO01</DEVCLASS>` +
        `<RECORDING>${opts.rec ?? 'X'}</RECORDING><EXISTING_REQ_ONLY>${opts.locks ? 'X' : ''}</EXISTING_REQ_ONLY><MESSAGES/>` +
        `<REQUESTS>${opts.requests || ''}</REQUESTS><LOCKS>${opts.locks || ''}</LOCKS></DATA></asx:values></asx:abap>`);

const ME = 'SSCR';

describe('decideTransport — one CR per goal', () => {
    test('local object needs no request', () => {
        expect(decideTransport([check({ rec: '' })], ME).kind).toBe('none');
    });

    test('an object already in a request answers RECORDING empty but still counts (live 2026-10-27)', () => {
        const held = check({ rec: '', locks: lock('S4DK5', ME, [['S4DK6', ME]]) });
        expect(decideTransport([held], ME)).toMatchObject({ kind: 'use', rule: 1, transportNumber: 'S4DK5' });
        const foreign = check({ rec: '', locks: lock('S4DK7', 'GILL.LI', [['S4DK8', 'GILL.LI']]) });
        expect(decideTransport([foreign], ME)).toMatchObject({ kind: 'use', rule: 3, transportNumber: 'S4DK7' });
    });

    test('rule 2: no open CR and nothing holds the object -> create', () => {
        const d = decideTransport([check({})], ME);
        expect(d.kind).toBe('create');
    });

    test('rule 1: reuses the only open CR of the user', () => {
        const d = decideTransport([check({ requests: req('S4DK1', ME) })], ME);
        expect(d).toMatchObject({ kind: 'use', rule: 1, transportNumber: 'S4DK1', needsOwnTask: false });
    });

    test('rule 1: several open CRs -> description match wins, else the newest; the rest are reported', () => {
        const reqs = req('S4DK1', ME, 'PCC_SD_old') + req('S4DK3', ME, 'PCC_SD_new') + req('S4DK2', ME, 'PCC_SD_zrsd0038 perf');
        const newest = decideTransport([check({ requests: reqs })], ME);
        expect(newest).toMatchObject({ kind: 'use', transportNumber: 'S4DK3' });
        expect((newest as any).ambiguous).toHaveLength(2);
        const hinted = decideTransport([check({ requests: reqs })], ME, 'ZRSD0038');
        expect(hinted).toMatchObject({ kind: 'use', transportNumber: 'S4DK2' });
    });

    test('rule 1: ignores released CRs and CRs of other users in the candidate list', () => {
        const reqs = req('S4DK9', ME, 'released', 'R') + req('S4DK8', 'OTHER');
        expect(decideTransport([check({ requests: reqs })], ME).kind).toBe('create');
    });

    test('rule 1: an object already in the user\'s own CR keeps it', () => {
        const d = decideTransport([check({ requests: req('S4DK1', ME), locks: lock('S4DK5', ME, [['S4DK6', ME]]) })], ME);
        expect(d).toMatchObject({ kind: 'use', rule: 1, transportNumber: 'S4DK5' });
    });

    test('rule 3: object held in a colleague\'s CR -> join it, needs an own task', () => {
        const d = decideTransport([check({ requests: req('S4DK1', ME), locks: lock('S4DK7', 'IJUI.HUANG', [['S4DK8', 'IJUI.HUANG']]) })], ME);
        expect(d).toMatchObject({ kind: 'use', rule: 3, transportNumber: 'S4DK7', needsOwnTask: true });
        expect(describeDecision(d)).toContain('S4DK7');
    });

    test('a colleague\'s CR that already has a task of the user counts as the user\'s own: no second task', () => {
        const d = decideTransport([check({ locks: lock('S4DK7', 'IJUI.HUANG', [['S4DK8', 'IJUI.HUANG'], ['S4DK9', ME]]) })], ME);
        expect(d).toMatchObject({ kind: 'use', rule: 1, transportNumber: 'S4DK7', needsOwnTask: false });
    });

    test('rule 3 via a parent: the include is free but its function group / program sits in a colleague\'s CR', () => {
        const target = check({ requests: req('S4DK1', ME) });
        const parent = check({ locks: lock('S4DK7', 'GILL.LI', [['S4DK8', 'GILL.LI']]) });
        expect(decideTransport([target, parent], ME)).toMatchObject({ kind: 'use', rule: 3, transportNumber: 'S4DK7' });
    });

    test('conflict: two different colleagues\' CRs, or a colleague\'s CR plus an own CR', () => {
        const a = check({ locks: lock('S4DK7', 'A', [['S4DK8', 'A']]) });
        const b = check({ locks: lock('S4DK17', 'B', [['S4DK18', 'B']]) });
        const mine = check({ locks: lock('S4DK5', ME, [['S4DK6', ME]]) });
        expect(decideTransport([a, b], ME).kind).toBe('conflict');
        expect(decideTransport([a, mine], ME).kind).toBe('conflict');
    });

    test('conflict: objects spread over two own CRs', () => {
        const x = check({ locks: lock('S4DK5', ME, [['S4DK6', ME]]) });
        const y = check({ locks: lock('S4DK15', ME, [['S4DK16', ME]]) });
        expect(decideTransport([x, y], ME).kind).toBe('conflict');
    });

    test('user name is compared case-insensitively', () => {
        expect(decideTransport([check({ requests: req('S4DK1', 'sscr') })], 'SSCR').kind).toBe('use');
    });
});
