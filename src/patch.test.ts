/**
 * Live integration tests for WriteProgram patch mode (edits[]).
 * Needs a live SAP system (.env or keystore). Writes ONLY to the disposable $TMP program
 * ZMCP_PATCH_E2E, which is created in beforeAll and deleted in afterAll.
 * Run with: npm test -- --testPathPattern=patch
 * Non-interactive shells (CI, agent tools) must close stdin — `npm test -- patch < /dev/null` — or jest
 * does not exit after the run (an open stdin pipe, not an open SAP connection).
 */

import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleDeleteObject } from './handlers/handleDeleteObject';
import { handleUnlockObject } from './handlers/handleUnlockObject';
import * as utils from './lib/utils';

const PROG = 'ZMCP_PATCH_E2E';
const URL_PATH = `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}/source/main`;

const BASE_SOURCE = [
    `REPORT ${PROG.toLowerCase()}.`,
    '',
    'DATA: lv_a TYPE i,',
    '      lv_b TYPE i.',
    '',
    'START-OF-SELECTION.',
    '  lv_a = 1.',
    '  lv_b = 2.',
    '  WRITE: / lv_a, lv_b.',
    '',
].join('\n');

const text = (r: any): string => r?.content?.[0]?.text ?? '';
// Fails with SAP's own message instead of a bare "expected false, received true"
function mustOk(r: any) {
    if (r?.isError) throw new Error('unexpected isError result: ' + text(r));
}
const write = (args: any) => handleWriteProgram({ program_name: PROG, ...args });

async function readSource(): Promise<string> {
    const base = String(await utils.getBaseUrl());
    const r = await utils.makeAdtRequest(`${base}${URL_PATH}`, 'GET', 30000, undefined, undefined, { Accept: 'text/plain' });
    return typeof r.data === 'string' ? r.data : String(r.data);
}

// Puts the program back to a known state (full write, no activation needed for most tests).
async function reset(): Promise<void> {
    const r = await write({ source_code: BASE_SOURCE });
    if (r.isError) throw new Error('reset failed: ' + text(r));
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();

beforeAll(async () => {
    const r = await handleWriteProgram({
        program_name: PROG, source_code: BASE_SOURCE,
        description: 'MCP patch-mode e2e (disposable)', package_name: '$TMP',
    });
    if (r.isError) throw new Error('fixture create failed: ' + text(r));
});

afterAll(async () => {
    jest.restoreAllMocks();
    try { await handleDeleteObject({ object_name: PROG, object_type: 'PROG' }); } catch { /* best effort */ }
    utils.cleanup();
    await new Promise(res => setTimeout(res, 100));
});

describe('patch mode — happy paths', () => {
    beforeEach(reset);

    it('P1. a single edit changes only the targeted text and activates', async () => {
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 10.' }] });
        mustOk(r);
        expect(text(r)).toMatch(/Patched with 1 edit\(s\): \+1 −1 lines \(line 7\)/);
        expect(text(r)).toMatch(/activated successfully/);
        expect(norm(await readSource())).toBe(norm(BASE_SOURCE.replace('lv_a = 1.', 'lv_a = 10.')));
    });

    it('P2. the response is terse — it never echoes the source', async () => {
        const r = await write({ edits: [{ old_string: 'lv_b = 2.', new_string: 'lv_b = 3.' }] });
        mustOk(r);
        expect(text(r)).not.toContain('START-OF-SELECTION');
        expect(text(r).length).toBeLessThan(600);
    });

    it('P3. several edits in one call land together and activate once', async () => {
        const r = await write({
            edits: [
                { old_string: 'lv_a = 1.', new_string: 'lv_a = 11.' },
                { old_string: 'lv_b = 2.', new_string: 'lv_b = 22.' },
                { old_string: 'WRITE: / lv_a, lv_b.', new_string: 'WRITE: / lv_a, lv_b.\n  WRITE: / \'done\'.' },
            ],
        });
        mustOk(r);
        expect(text(r)).toMatch(/Patched with 3 edit\(s\)/);
        const src = norm(await readSource());
        expect(src).toContain('lv_a = 11.');
        expect(src).toContain('lv_b = 22.');
        expect(src).toContain("WRITE: / 'done'.");
    });

    it('P4. replace_all changes every occurrence', async () => {
        const r = await write({ edits: [{ old_string: 'TYPE i', new_string: 'TYPE p', replace_all: true }] });
        mustOk(r);
        expect(text(r)).toMatch(/2x from line 3/);
        const src = await readSource();
        expect(src.match(/TYPE p/g)?.length).toBe(2);
        expect(src).not.toContain('TYPE i');
    });

    it('P5. deleting text with new_string "" works', async () => {
        const r = await write({ edits: [{ old_string: '  lv_b = 2.\n', new_string: '' }] });
        mustOk(r);
        expect(await readSource()).not.toContain('lv_b = 2.');
    });

    it('P6. an unchanged remainder survives byte-for-byte (line endings included)', async () => {
        const before = await readSource();
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 5.' }] });
        mustOk(r);
        const after = await readSource();
        expect(after.replace('lv_a = 5.', 'lv_a = 1.')).toBe(before);
    });

    it('P1b. the summary counts only changed lines, not anchor context', async () => {
        const r = await write({ edits: [{ old_string: 'lv_a = 1.\n  lv_b = 2.', new_string: 'lv_a = 1.\n  lv_b = 3.' }] });
        mustOk(r);
        expect(text(r)).toMatch(/\+1 −1 lines \(line 7\)/);
        const ins = await write({ edits: [{ old_string: '  lv_a = 1.\n', new_string: '  lv_a = 1.\n  lv_c = 0.\n' }] });
        expect(text(ins)).toMatch(/\+1 −0 lines/);
    });

    it('P7. activate=false patches chain on the inactive working version', async () => {
        const a = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 100.' }], activate: false });
        mustOk(a);
        expect(text(a)).not.toMatch(/activated successfully/);
        expect(text(a)).toMatch(/Not activated \(activate=false\)/);
        // second patch anchors on text only present in the INACTIVE version
        const b = await write({ edits: [{ old_string: 'lv_a = 100.', new_string: 'lv_a = 200.' }] });
        mustOk(b);
        expect(text(b)).toMatch(/activated successfully/);
        expect(await readSource()).toContain('lv_a = 200.');
    });
});

describe('patch mode — refusals leave SAP untouched', () => {
    beforeEach(reset);

    const expectUnchanged = async () => expect(norm(await readSource())).toBe(norm(BASE_SOURCE));

    it('N1. an ambiguous anchor is refused before any lock', async () => {
        const r = await write({ edits: [{ old_string: 'TYPE i', new_string: 'TYPE p' }] });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/matches 2 places \(lines 3, 4\)/);
        expect(text(r)).toMatch(/Nothing was locked or written/);
        await expectUnchanged();
    });

    it('N2. a missing anchor with different indentation shows the exact lines', async () => {
        const r = await write({ edits: [{ old_string: 'lv_a   =   1.', new_string: 'lv_a = 2.' }] });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/different whitespace\/indentation/);
        expect(text(r)).toContain('7|   lv_a = 1.');
        await expectUnchanged();
    });

    it('N3. one bad edit among good ones applies none of them (atomic)', async () => {
        const r = await write({
            edits: [
                { old_string: 'lv_a = 1.', new_string: 'lv_a = 99.' },
                { old_string: 'NOT IN THE SOURCE', new_string: 'x' },
            ],
        });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/edits\[1\]: old_string not found/);
        await expectUnchanged();
    });

    it('N4. edits combined with source_code is rejected', async () => {
        const r = await write({ source_code: BASE_SOURCE, edits: [{ old_string: 'a', new_string: 'b' }] });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/cannot be combined with source_code or source_file/);
        await expectUnchanged();
    });

    it('N5. edits on a nonexistent object is refused and does not create it', async () => {
        const r = await handleWriteProgram({
            program_name: 'ZMCP_PATCH_NOPE', edits: [{ old_string: 'a', new_string: 'b' }],
            description: 'x', package_name: '$TMP',
        });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/needs an existing object/);
        const probe = await handleWriteProgram({ program_name: 'ZMCP_PATCH_NOPE', edits: [{ old_string: 'a', new_string: 'b' }] });
        expect(text(probe)).toMatch(/needs an existing object/); // still absent
    });

    it('N6. malformed edits are rejected with an InvalidParams-style message', async () => {
        for (const bad of [[], 'oops', [{ old_string: '', new_string: 'x' }], [{ old_string: 'a' }], [{ old_string: 'a', new_string: 'a' }]]) {
            const r = await write({ edits: bad });
            expect(r.isError).toBe(true);
        }
        await expectUnchanged();
    });

    it('N7. more than 20 edits is refused', async () => {
        const many = Array.from({ length: 21 }, (_, i) => ({ old_string: `x${i}`, new_string: `y${i}` }));
        const r = await write({ edits: many });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/limit is 20/);
    });

    it('N8. a patch that creates a >255-char line is refused', async () => {
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: `lv_a = 1. " ${'x'.repeat(300)}` }] });
        expect(r.isError).toBe(true);
        await expectUnchanged();
    });

    it('N9. edits with object_type=FUGR is rejected', async () => {
        const r = await handleWriteProgram({ program_name: 'ZMCP_PATCH_FG', object_type: 'FUGR', edits: [{ old_string: 'a', new_string: 'b' }] });
        expect(r.isError).toBe(true);
    });
});

describe('patch mode — syntax check integration', () => {
    beforeEach(reset);

    it('S1. check_only + good edits is a dry run: reports, writes nothing', async () => {
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 5.' }], check_only: true });
        mustOk(r);
        expect(text(r)).toMatch(/Patched with 1 edit/);
        expect(text(r)).toMatch(/Check only/);
        expect(norm(await readSource())).toBe(norm(BASE_SOURCE));
    });

    it('S2. check_only + a patch that breaks the syntax reports line:col and writes nothing', async () => {
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = undefined_var.' }], check_only: true });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/UNDEFINED_VAR/i);
        expect(text(r)).toMatch(/line 7/);
        expect(norm(await readSource())).toBe(norm(BASE_SOURCE));
    });

    it('S3. syntax_check refuses a bad patch before the lock; the next patch still works (no stale lock)', async () => {
        const bad = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = undefined_var.' }], syntax_check: true });
        expect(bad.isError).toBe(true);
        expect(text(bad)).toMatch(/Nothing was locked or written/);
        expect(norm(await readSource())).toBe(norm(BASE_SOURCE));
        const good = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 2.' }], syntax_check: true });
        mustOk(good);
        expect(text(good)).toMatch(/Syntax check: no messages/);
    });

    it('S4. without syntax_check a breaking patch is saved but activation FAILS; a repair patch recovers', async () => {
        const bad = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = undefined_var.' }] });
        expect(bad.isError).toBe(true);
        expect(text(bad)).toMatch(/Patched with 1 edit/);
        expect(text(bad)).toMatch(/FAILED/i);
        expect(text(bad)).toMatch(/IS saved, but 'ZMCP_PATCH_E2E' is INACTIVE/);
        expect(text(bad)).toMatch(/syntax_check=true/);
        expect(await readSource()).toContain('undefined_var'); // saved (inactive), just not active
        const fix = await write({ edits: [{ old_string: 'lv_a = undefined_var.', new_string: 'lv_a = 1.' }] });
        mustOk(fix);
        expect(text(fix)).toMatch(/activated successfully/);
    });
});

describe('patch mode — concurrent change between first read and lock', () => {
    beforeEach(reset);

    // Intercept the SECOND source GET (the re-read taken inside the lock) and hand back a
    // different text, as if another developer had saved in between. The PUT is real.
    function interceptSecondRead(mutate: (src: string) => string) {
        const real = utils.makeAdtRequest;
        let sourceGets = 0;
        const spy = jest.spyOn(utils, 'makeAdtRequest').mockImplementation(async (url: string, method: string, ...rest: any[]) => {
            const res = await (real as any)(url, method, ...rest);
            if (method === 'GET' && url.endsWith('/source/main')) {
                sourceGets++;
                if (sourceGets === 2) return { ...res, data: mutate(String(res.data)) };
            }
            return res;
        });
        return { spy, reads: () => sourceGets };
    }

    it('C1. an unrelated concurrent change is merged: edits re-applied to the newer text', async () => {
        const { spy } = interceptSecondRead(src => src + '\n* concurrent edit by someone else\n');
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 7.' }] });
        spy.mockRestore();
        mustOk(r);
        expect(text(r)).toMatch(/had changed since it was first read/);
        const src = await readSource();
        expect(src).toContain('lv_a = 7.');
        expect(src).toContain('* concurrent edit by someone else');
    });

    it('C2. a concurrent change that removes the anchor aborts: nothing written, lock released', async () => {
        const { spy } = interceptSecondRead(src => src.replace('lv_a = 1.', 'lv_a = 1000.'));
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 7.' }] });
        spy.mockRestore();
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/changed in SAP after it was first read/);
        expect(text(r)).toMatch(/Nothing was written/);
        // SAP still holds the ORIGINAL text (the intercept only altered what the handler saw)…
        expect(norm(await readSource())).toBe(norm(BASE_SOURCE));
        // …and the lock was released: a normal patch goes through and UnlockObject reports clear
        const ok = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 3.' }] });
        mustOk(ok);
        const u = await handleUnlockObject({ object_name: PROG });
        mustOk(u);
    });

    it('C3. an unchanged source takes the fast path (exactly two source reads, no re-apply note)', async () => {
        const { spy, reads } = interceptSecondRead(src => src);
        const r = await write({ edits: [{ old_string: 'lv_a = 1.', new_string: 'lv_a = 8.' }] });
        spy.mockRestore();
        mustOk(r);
        expect(text(r)).not.toMatch(/had changed/);
        expect(reads()).toBe(2);
    });
});

describe('patch mode — locking hygiene', () => {
    beforeEach(reset);

    it('L1. repeated patches in a row never leave the object locked', async () => {
        for (let i = 0; i < 3; i++) {
            const r = await write({ edits: [{ old_string: `lv_a = ${i + 1}.`, new_string: `lv_a = ${i + 2}.` }] });
            mustOk(r);
        }
        const u = await handleUnlockObject({ object_name: PROG });
        mustOk(u);
        expect(text(u)).not.toMatch(/currently editing/i);
    });

    it('L2. a refused patch (bad anchor) takes no lock at all', async () => {
        const spy = jest.spyOn(utils, 'makeAdtRequest');
        const r = await write({ edits: [{ old_string: 'NOT HERE', new_string: 'x' }] });
        const posts = spy.mock.calls.filter(c => c[1] === 'POST' && String(c[0]).includes(PROG.toLowerCase()));
        spy.mockRestore();
        expect(r.isError).toBe(true);
        expect(posts.length).toBe(0);
    });
});

// ─── benchmark ─────────────────────────────────────────────────────────────
// Not a pass/fail speed test (SAP timing is noisy) — it measures what patch mode is FOR: the size of
// what the caller (an LLM) must send, and wall time, for the same one-line change to a large
// program. Prints a table; asserts only that both paths work and the payload ratio is sane.

describe('patch mode — benchmark (large program, one-line change)', () => {
    const BENCH = 'ZMCP_PATCH_BENCH';
    const LINES = 1500;
    const RUNS = 3;
    const body = Array.from({ length: LINES }, (_, i) => `  lv_v${i} = ${i}. " filler line ${i}`).join('\n');
    const bigSource = (marker: string) =>
        `REPORT ${BENCH.toLowerCase()}.\nDATA: lv_x TYPE i.\nSTART-OF-SELECTION.\n  lv_x = ${marker}.\n${body.replace(/lv_v(\d+) = /g, 'lv_x = ')}\n`;

    beforeAll(async () => {
        const r = await handleWriteProgram({
            program_name: BENCH, source_code: bigSource('0'), activate: false,
            description: 'MCP patch benchmark (disposable)', package_name: '$TMP',
        });
        mustOk(r);
    });

    afterAll(async () => {
        try { await handleDeleteObject({ object_name: BENCH, object_type: 'PROG' }); } catch { /* best effort */ }
    });

    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

    it('B1. same one-line change: full rewrite vs patch', async () => {
        const fullMs: number[] = [], patchMs: number[] = [];
        let fullBytes = 0, patchBytes = 0;
        let current = '0';
        for (let i = 1; i <= RUNS; i++) {
            const next = String(i);
            // full rewrite
            const src = bigSource(next);
            fullBytes = Buffer.byteLength(src, 'utf8');
            let t = Date.now();
            mustOk(await handleWriteProgram({ program_name: BENCH, source_code: src, activate: false }));
            fullMs.push(Date.now() - t);
            current = next;

            // patch back to a new value
            const nextP = String(100 + i);
            const edits = [{ old_string: `lv_x = ${current}.\n`, new_string: `lv_x = ${nextP}.\n` }];
            patchBytes = Buffer.byteLength(JSON.stringify(edits), 'utf8');
            t = Date.now();
            mustOk(await handleWriteProgram({ program_name: BENCH, edits, activate: false }));
            patchMs.push(Date.now() - t);
            current = nextP;
        }
        const src = await readSourceOf(BENCH);
        expect(src).toContain(`lv_x = ${current}.`);

        const ratio = (patchBytes / fullBytes) * 100;
        console.log(
            `\n  Benchmark: ${LINES}-line program, one-line change, activate=false, median of ${RUNS}\n` +
            `  ┌────────────┬──────────────────┬───────────┐\n` +
            `  │ mode       │ argument bytes   │ wall (ms) │\n` +
            `  ├────────────┼──────────────────┼───────────┤\n` +
            `  │ full write │ ${String(fullBytes).padStart(16)} │ ${String(median(fullMs)).padStart(9)} │\n` +
            `  │ patch      │ ${String(patchBytes).padStart(16)} │ ${String(median(patchMs)).padStart(9)} │\n` +
            `  └────────────┴──────────────────┴───────────┘\n` +
            `  patch sends ${ratio.toFixed(2)} % of the full-write payload\n`
        );
        expect(ratio).toBeLessThan(2);
    });
});

async function readSourceOf(name: string): Promise<string> {
    const base = String(await utils.getBaseUrl());
    const r = await utils.makeAdtRequest(`${base}/sap/bc/adt/programs/programs/${name.toLowerCase()}/source/main`, 'GET', 30000, undefined, undefined, { Accept: 'text/plain' });
    return typeof r.data === 'string' ? r.data : String(r.data);
}
