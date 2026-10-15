/**
 * Offline unit tests (no SAP) for the 3.10.0 helpers: output_file inline limit, apply_patch ids,
 * local pre-write snapshots. The tools that use them are covered live in src/newtools.test.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmp: string;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-newtools-'));
    process.env.WRITE_SNAPSHOT_DIR = path.join(tmp, 'snaps'); // set before the module reads it
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.WRITE_SNAPSHOT_DIR;
    delete process.env.WRITE_SNAPSHOT_KEEP;
    delete process.env.WRITE_SNAPSHOTS;
});

describe('maybeBackground output_file inline limit', () => {
    // required lazily so each test sees the env it sets
    const load = () => { jest.resetModules(); return require('./background') as typeof import('./background'); };
    const core = (t: string) => async () => ({ isError: false, content: [{ type: 'text', text: t }] });

    it('keeps a small result inline and writes the file', async () => {
        const { maybeBackground } = load();
        const out = path.join(tmp, 'small.txt');
        const r = await maybeBackground({ output_file: out }, 'x', 'x', core('hello\nworld'));
        expect(r.content[0].text).toContain('hello\nworld');
        expect(fs.readFileSync(out, 'utf8')).toBe('hello\nworld');
    });

    it('returns only a head + path/size for a result over the limit, file complete', async () => {
        const { maybeBackground } = load();
        const big = Array.from({ length: 3000 }, (_v, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
        expect(big.length).toBeGreaterThan(20000);
        const out = path.join(tmp, 'big.txt');
        const r = await maybeBackground({ output_file: out }, 'x', 'x', core(big));
        const shown = r.content[0].text;
        expect(shown.length).toBeLessThan(3000);
        expect(shown).toContain('line 0 ');
        expect(shown).not.toContain('line 2999');
        expect(shown).toContain(out);
        expect(shown).toMatch(/3000 lines/);
        expect(fs.readFileSync(out, 'utf8')).toBe(big);
    });

    it('does not touch the result when no output_file is given', async () => {
        const { maybeBackground } = load();
        const big = 'y'.repeat(50000);
        const r = await maybeBackground({}, 'x', 'x', core(big));
        expect(r.content[0].text).toBe(big);
    });

    it('preserves isError', async () => {
        const { maybeBackground } = load();
        const r = await maybeBackground({ output_file: path.join(tmp, 'err.txt') }, 'x', 'x', async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }));
        expect(r.isError).toBe(true);
    });
});

describe('pendingPatch (apply_patch ids)', () => {
    const edits = [{ old_string: 'a', new_string: 'b' }];

    it('recalls the edits for the same object, case-insensitively', () => {
        jest.resetModules();
        const p = require('./pendingPatch') as typeof import('./pendingPatch');
        const id = p.rememberPatch('zfoo', edits);
        expect(id).toMatch(/^p-[0-9a-f]{8}$/);
        expect(p.recallPatch(id, 'ZFOO')).toEqual({ edits });
        expect(p.recallPatch(id, 'zfoo')).toEqual({ edits }); // reusable until it expires
    });

    it('refuses another object and unknown ids', () => {
        jest.resetModules();
        const p = require('./pendingPatch') as typeof import('./pendingPatch');
        const id = p.rememberPatch('ZFOO', edits);
        expect(p.recallPatch(id, 'ZBAR')).toEqual({ error: expect.stringContaining('was made for ZFOO') });
        expect(p.recallPatch('p-00000000', 'ZFOO')).toEqual({ error: expect.stringContaining('unknown or expired') });
    });

    it('expires after the TTL', () => {
        jest.resetModules();
        const p = require('./pendingPatch') as typeof import('./pendingPatch');
        const real = Date.now;
        try {
            const id = p.rememberPatch('ZFOO', edits);
            Date.now = () => real() + (p.PENDING_PATCH_TTL_MINUTES + 1) * 60000;
            expect(p.recallPatch(id, 'ZFOO')).toEqual({ error: expect.stringContaining('unknown or expired') });
        } finally { Date.now = real; }
    });

    it('keeps at most 20 patches (oldest dropped)', () => {
        jest.resetModules();
        const p = require('./pendingPatch') as typeof import('./pendingPatch');
        const ids = Array.from({ length: 25 }, (_v, i) => p.rememberPatch('ZFOO', [{ old_string: String(i), new_string: 'x' }]));
        expect('error' in p.recallPatch(ids[0], 'ZFOO')).toBe(true);
        expect('edits' in p.recallPatch(ids[24], 'ZFOO')).toBe(true);
    });
});

describe('local pre-write snapshots', () => {
    const load = () => { jest.resetModules(); return require('./snapshots') as typeof import('./snapshots'); };
    const tick = () => new Promise(r => setTimeout(r, 5)); // ids carry milliseconds

    it('saves, lists newest first, reads by id and by "latest"', async () => {
        const s = load();
        const a = s.saveSnapshot('ZSNAP1', 'one\n');
        await tick();
        const b = s.saveSnapshot('ZSNAP1', 'two\nthree');
        expect(a && b && a !== b).toBeTruthy();
        const list = s.listSnapshots('ZSNAP1');
        expect(list.map(x => x.id)).toEqual([b, a]);
        expect(list[0]).toMatchObject({ lines: 2, bytes: 9 });
        expect(s.readSnapshot('ZSNAP1', a!)).toBe('one\n');
        expect(s.readSnapshot('ZSNAP1', 'latest')).toBe('two\nthree');
        expect(s.readSnapshot('zsnap1', 'LATEST')).toBe('two\nthree'); // name is case-insensitive
    });

    it('skips a copy identical to the newest', async () => {
        const s = load();
        const a = s.saveSnapshot('ZSNAP2', 'same');
        await tick();
        const b = s.saveSnapshot('ZSNAP2', 'same');
        expect(b).toBe(a);
        expect(s.listSnapshots('ZSNAP2')).toHaveLength(1);
    });

    it('prunes to WRITE_SNAPSHOT_KEEP', async () => {
        process.env.WRITE_SNAPSHOT_KEEP = '3';
        const s = load();
        for (let i = 0; i < 6; i++) { s.saveSnapshot('ZSNAP3', `v${i}`); await tick(); }
        const list = s.listSnapshots('ZSNAP3');
        expect(list).toHaveLength(3);
        expect(s.readSnapshot('ZSNAP3', 'latest')).toBe('v5');
        delete process.env.WRITE_SNAPSHOT_KEEP;
    });

    it('is a no-op when disabled, and rejects path tricks in the id', () => {
        const s = load();
        process.env.WRITE_SNAPSHOTS = '0';
        expect(s.saveSnapshot('ZSNAP4', 'x')).toBeNull();
        delete process.env.WRITE_SNAPSHOTS;
        expect(s.listSnapshots('ZSNAP4')).toEqual([]);
        expect(s.readSnapshot('ZSNAP1', '../../etc/passwd')).toBeNull();
        expect(s.readSnapshot('NO_SUCH_OBJECT', 'latest')).toBeNull();
    });

    it('keeps objects apart (namespaced names are sanitised)', () => {
        const s = load();
        s.saveSnapshot('/ABC/CL_X', 'ns');
        expect(s.readSnapshot('/ABC/CL_X', 'latest')).toBe('ns');
        expect(s.listSnapshots('CL_X')).toEqual([]);
    });
});

describe('queryCache clearing (lists must not be stale right after a write)', () => {
    it('clearQueryCache forgets every cached list', () => {
        jest.resetModules();
        const q = require('./queryCache') as typeof import('./queryCache');
        const k1 = q.cacheKey('A', { x: 1 }), k2 = q.cacheKey('B', { y: 2 });
        q.setCachedList(k1, [1, 2, 3]);
        q.setCachedList(k2, ['a']);
        expect(q.getCachedList(k1)).toEqual([1, 2, 3]);
        q.clearQueryCache();
        expect(q.getCachedList(k1)).toBeUndefined();
        expect(q.getCachedList(k2)).toBeUndefined();
    });
});
