/**
 * Offline test (no SAP) of the transportchecks parser, verdicts and the request-or-task guard helper.
 * Sample bodies are trimmed copies of live S4D answers (2026-10-16). `./utils` is mocked because the real
 * one imports the server entry, which needs SAP credentials.
 */
let mockXml = '';
let mockQueue: string[] = [];   // consumed first, one body per request, for multi-call flows
jest.mock('./utils', () => ({ makeAdtRequest: jest.fn(async () => ({ data: mockQueue.length ? mockQueue.shift() : mockXml })) }));

import { parseTransportCheck, verdictOf, matchesHolder, isDifferentChange, fetchTransportCheck,
         parsePreviewRows, fmLockHolders, locksToHolders, groupLockRows } from './transportCheck';

const H = (n: string, u: string, t = 'txt') => `<TRKORR>${n}</TRKORR><TRSTATUS>D</TRSTATUS><TARSYSTEM>/ZS4Q/</TARSYSTEM><AS4USER>${u}</AS4USER><AS4TEXT>${t}</AS4TEXT>`;
const wrap = (rec: string, only: string, requests: string, locks: string) =>
    `<asx:abap><asx:values><DATA><PGMID>LIMU</PGMID><OBJECT>REPS</OBJECT><OBJECTNAME>ZX</OBJECTNAME><DEVCLASS>ZCO01</DEVCLASS>` +
    `<RESULT>S</RESULT><RECORDING>${rec}</RECORDING><EXISTING_REQ_ONLY>${only}</EXISTING_REQ_ONLY><MESSAGES/>` +
    `<REQUESTS>${requests}</REQUESTS><LOCKS>${locks}</LOCKS></DATA></asx:values></asx:abap>`;
const req = (n: string, u: string) => `<CTS_REQUEST><REQ_HEADER>${H(n, u)}</REQ_HEADER><REQ_ATTRS/><TASK_HEADERS/></CTS_REQUEST>`;
const heldByOther = wrap('X', 'X', req('DEVK916740', 'OTHERUSER'),
    `<CTS_OBJECT_LOCK><LOCK_HOLDER><REQ_HEADER>${H('DEVK916740', 'OTHERUSER', 'a &amp; b')}</REQ_HEADER><TASK_HEADERS><CTS_TASK_HEADER>${H('DEVK916741', 'OTHERUSER')}</CTS_TASK_HEADER></TASK_HEADERS></LOCK_HOLDER></CTS_OBJECT_LOCK>`);

describe('transportCheck', () => {
    test('held by another user', () => {
        const c = parseTransportCheck(heldByOther);
        expect(c.existingRequestOnly).toBe(true);
        expect(c.holders[0].request.number).toBe('DEVK916740');
        expect(c.holders[0].request.text).toBe('a & b');
        expect(c.holders[0].tasks.map(t => t.number)).toEqual(['DEVK916741']);
        expect(verdictOf(c, 'SSCR')).toBe('HELD_BY_OTHER');
        expect(verdictOf(c, 'otheruser')).toBe('HELD_BY_SELF');
    });
    test('free object lists own requests; local object needs none', () => {
        const free = parseTransportCheck(wrap('X', '', req('DEVK1', 'SSCR') + req('DEVK2', 'SSCR'), ''));
        expect(verdictOf(free, 'SSCR')).toBe('FREE');
        expect(free.candidates.map(c => c.number)).toEqual(['DEVK1', 'DEVK2']);
        expect(verdictOf(parseTransportCheck(wrap('', '', '', '')), 'SSCR')).toBe('LOCAL');
    });
    test('request or task of the holder both match, others do not', () => {
        const c = parseTransportCheck(heldByOther);
        expect(matchesHolder(c, 'devk916740')).toBe(true);
        expect(matchesHolder(c, 'DEVK916741')).toBe(true);
        expect(matchesHolder(c, 'DEVK999999')).toBe(false);
    });
    test('isDifferentChange: task-vs-request is the same change; a foreign request is different', async () => {
        mockXml = heldByOther;
        expect(await isDifferentChange('', '/x', 'DEVK916741', 'DEVK916740')).toBe(false);
        expect(await isDifferentChange('', '/x', 'DEVK916740', 'DEVK916740')).toBe(false);
        expect(await isDifferentChange('', '/x', 'DEVK916740', 'DEVK999999')).toBe(true);
    });

    // Function modules: transportchecks answers <LOCKS/> even when the FM sits in a colleague's task
    // (CTS keys the lock under the function group in TLOCK). Bodies trimmed from live S4D, 2026-10-19.
    const col = (name: string, values: string[]) =>
        `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C"/><dataPreview:dataSet>` +
        values.map(v => v ? `<dataPreview:data>${v}</dataPreview:data>` : '<dataPreview:data/>').join('') + `</dataPreview:dataSet></dataPreview:columns>`;
    const preview = (...cols: string[]) => `<dataPreview:tableData xmlns:dataPreview="x">${cols.join('')}</dataPreview:tableData>`;
    const fmFree = wrap('X', '', req('DEVK1', 'SSCR'), '').replace('<OBJECT>REPS</OBJECT><OBJECTNAME>ZX</OBJECTNAME>',
        '<OBJECT>FUNC</OBJECT><OBJECTNAME>Z_FI02_ACCTDOC_SIGNFILE</OBJECTNAME>');
    const tlock = preview(col('TRKORR', ['DEVK924875']), col('AUTHOR', ['OTHERUSER']),
        col('LOKEY', ['ZFIF02                    FUNCZ_FI02_ACCTDOC_SIGNFILE       ']));
    const task = preview(col('TRKORR', ['DEVK924875']), col('STRKORR', ['DEVK924874']), col('AS4USER', ['OTHERUSER']),
        col('TRSTATUS', ['D']), col('TARSYSTEM', ['']), col('AS4TEXT', ['PCC_FI_signfile RFC']));
    const request = preview(col('TRKORR', ['DEVK924874']), col('STRKORR', ['']), col('AS4USER', ['OTHERUSER']),
        col('TRSTATUS', ['D']), col('TARSYSTEM', ['/ZS4Q/']), col('AS4TEXT', ['PCC_FI_signfile RFC']));
    const fmUri = '/sap/bc/adt/functions/groups/zfif02/fmodules/z_fi02_acctdoc_signfile';

    test('preview rows: columns become records, empty cells stay empty', () => {
        expect(parsePreviewRows(task)).toEqual([{ TRKORR: 'DEVK924875', STRKORR: 'DEVK924874', AS4USER: 'OTHERUSER',
            TRSTATUS: 'D', TARSYSTEM: '', AS4TEXT: 'PCC_FI_signfile RFC' }]);
    });
    test('FM lock holder is built from TLOCK + E070, and a near-miss key is ignored', () => {
        const rows = [...parsePreviewRows(tlock), { TRKORR: 'DEVK000001', LOKEY: 'ZFIF02  FUNCZ_FI02_ACCTDOC_SIGNFILE_X' }];
        const h = fmLockHolders('ZFIF02', 'Z_FI02_ACCTDOC_SIGNFILE', rows, [...parsePreviewRows(task), ...parsePreviewRows(request)]);
        expect(h).toHaveLength(1);
        expect(h[0].request).toMatchObject({ number: 'DEVK924874', owner: 'OTHERUSER', target: '/ZS4Q/' });
        expect(h[0].tasks.map(t => t.number)).toEqual(['DEVK924875']);
    });
    test('an FM reported free by transportchecks but held in TLOCK is HELD_BY_OTHER', async () => {
        mockQueue = [fmFree, tlock, task, request];
        const c = await fetchTransportCheck('https://sap', fmUri);
        expect(verdictOf(c, 'SSCR')).toBe('HELD_BY_OTHER');
        expect(c.existingRequestOnly).toBe(true);
        expect(matchesHolder(c, 'DEVK924875')).toBe(true);
        expect(c.messages.join(' ')).toMatch(/TLOCK/);
    });
    test('an FM with no TLOCK entry stays FREE; a failed lookup says FREE is unverified', async () => {
        mockQueue = [fmFree, preview(col('TRKORR', []), col('AUTHOR', []), col('LOKEY', []))];
        expect(verdictOf(await fetchTransportCheck('https://sap', fmUri), 'SSCR')).toBe('FREE');
        const utils = require('./utils');
        mockQueue = [fmFree];
        utils.makeAdtRequest.mockImplementationOnce(async () => ({ data: fmFree }))
            .mockImplementationOnce(async () => { throw new Error('400'); });
        const c = await fetchTransportCheck('https://sap', fmUri);
        expect(verdictOf(c, 'SSCR')).toBe('FREE');
        expect(c.messages.join(' ')).toMatch(/unverified/);
        mockQueue = [];
    });
});

describe('function-group locks (live shape, ZBASIS 2026-10-27)', () => {
    const pad = (g: string) => g.padEnd(26);
    const locks = [
        { TRKORR: 'S4DK925117', LOKEY: `${pad('ZBASIS')}FUNCZBP_JOB_VALIDATE` },
        { TRKORR: 'S4DK925117', LOKEY: `${pad('ZBASIS')}FUNCZBP_JOB_CREATE` },
        { TRKORR: 'S4DK999999', LOKEY: `${pad('ZBASIS02')}FUNCZ_OTHER` },
    ];
    const reqRows = [
        { TRKORR: 'S4DK925117', STRKORR: 'S4DK925116', AS4USER: 'SSCR', TRSTATUS: 'D', TARSYSTEM: '', AS4TEXT: 'task' },
        { TRKORR: 'S4DK925116', STRKORR: '', AS4USER: 'SSCR', TRSTATUS: 'D', TARSYSTEM: '/ZS4Q/', AS4TEXT: 'work CR' },
    ];
    test('only the rows of that group count (ZBASIS is not ZBASIS02)', () => {
        expect(groupLockRows('ZBASIS', locks)).toHaveLength(2);
        expect(groupLockRows('ZBASIS02', locks)).toHaveLength(1);
    });
    test('all FMs of the group in one request give one holder with its task', () => {
        const h = locksToHolders(groupLockRows('ZBASIS', locks), reqRows);
        expect(h).toHaveLength(1);
        expect(h[0].request.number).toBe('S4DK925116');
        expect(h[0].tasks.map(t => t.number)).toEqual(['S4DK925117']);
    });
});
