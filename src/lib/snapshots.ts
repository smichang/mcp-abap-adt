import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// Local pre-write snapshots. A local ($TMP) object has exactly one version in SAP — no history —
// so `GetCode VERSION compare_to` had nothing to diff after a patch (lifecycle test 2026-10-15).
// Before WriteProgram replaces an existing object's source it keeps the text it is replacing here,
// so the change can be diffed or rolled back. Reference copies only: never synced back, never
// authoritative (SAP is), lost when the temp dir is cleaned.
//
//   <dir>/<NAME>/<YYYYMMDD-HHMMSS-mmm>.abap     newest = latest write's predecessor
//
// dir: env WRITE_SNAPSHOT_DIR, else <os tmpdir>/mcp-abap-adt-snapshots/<sha1(SAP_URL|SAP_CLIENT)[:10]>
// (systems/clients never mix). WRITE_SNAPSHOTS=0 disables; WRITE_SNAPSHOT_KEEP (default 15) caps
// the copies per object. Every function is best-effort: a snapshot problem never blocks a write.

const keepCount = (): number => {
    const n = Number(process.env.WRITE_SNAPSHOT_KEEP);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
};

export const snapshotsEnabled = (): boolean => process.env.WRITE_SNAPSHOTS !== '0';

function baseDir(): string {
    if (process.env.WRITE_SNAPSHOT_DIR) return path.resolve(process.env.WRITE_SNAPSHOT_DIR);
    // the RESOLVED connection (process env / keystore / .env), same keying idea as writeLock.ts.
    // Required lazily: importing ../index constructs the server, which needs SAP credentials — a
    // pure helper (and its offline tests with WRITE_SNAPSHOT_DIR set) must not.
    const { getConfig } = require('../index') as typeof import('../index');
    const cfg = getConfig();
    const key = crypto.createHash('sha1').update(`${cfg.url}|${cfg.client}`).digest('hex').slice(0, 10);
    return path.join(os.tmpdir(), 'mcp-abap-adt-snapshots', key);
}

const safeName = (n: string) => n.toUpperCase().replace(/[^A-Z0-9_$/~-]/g, '_').replace(/\//g, '#');
const objDir = (name: string) => path.join(baseDir(), safeName(name));

export interface SnapshotInfo {
    id: string;
    bytes: number;
    lines: number;
}

function stamp(d = new Date()): string {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export function listSnapshots(name: string): SnapshotInfo[] {
    try {
        const dir = objDir(name);
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.abap'))
            .sort()
            .reverse()
            .map(f => {
                const text = fs.readFileSync(path.join(dir, f), 'utf8');
                return { id: f.slice(0, -5), bytes: Buffer.byteLength(text, 'utf8'), lines: text.length === 0 ? 0 : text.split('\n').length };
            });
    } catch {
        return [];
    }
}

/** Saves `source` (the text a write is about to replace). Returns the new id, or null when skipped/failed. */
export function saveSnapshot(name: string, source: string): string | null {
    if (!snapshotsEnabled()) return null;
    try {
        const dir = objDir(name);
        fs.mkdirSync(dir, { recursive: true });
        const existing = fs.readdirSync(dir).filter(f => f.endsWith('.abap')).sort();
        // same text as the newest copy → nothing new to keep
        if (existing.length) {
            const newest = fs.readFileSync(path.join(dir, existing[existing.length - 1]), 'utf8');
            if (newest === source) return existing[existing.length - 1].slice(0, -5);
        }
        const id = stamp();
        fs.writeFileSync(path.join(dir, `${id}.abap`), source, 'utf8');
        const all = fs.readdirSync(dir).filter(f => f.endsWith('.abap')).sort();
        for (const old of all.slice(0, Math.max(0, all.length - keepCount()))) fs.unlinkSync(path.join(dir, old));
        return id;
    } catch {
        return null;
    }
}

/** idOrLatest: a snapshot id, or 'latest'. null when there is no such snapshot. */
export function readSnapshot(name: string, idOrLatest: string): string | null {
    try {
        const id = idOrLatest.toLowerCase() === 'latest' ? listSnapshots(name)[0]?.id : idOrLatest;
        if (!id || !/^[0-9-]+$/.test(id)) return null;
        return fs.readFileSync(path.join(objDir(name), `${id}.abap`), 'utf8');
    } catch {
        return null;
    }
}
