import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from '../index';

// A lock held longer than this is assumed abandoned (process crashed/was killed
// before its finally-block release ran) and a new connection may take it over.
const STALE_MS = 2 * 60 * 1000;

interface LockPayload {
    pid: number;    // owning process = owning MCP connection (or overlapping call in that process)
    token: string;  // 'pending:<pid>' until the real SAP session cookie is known, then the literal
                    // 'sap-contextid=...' value captured from that connection's own LOCK response
    label: string;
    acquiredAt: number;
}

function lockFilePath(): string {
    const { url, client } = getConfig();
    // Scoped per SAP system (URL + client), not global — connections pointed at different
    // SAP systems must never block each other (this build is shared across many project dirs,
    // see the Secrets Keystore "one build, many callers" note in docs/TOOL_INTERNALS.md).
    //
    // os.tmpdir() is machine-wide on Linux/macOS (/tmp), but per-user on Windows (%TEMP%,
    // under that user's own profile) — verified against Node's documented platform behavior,
    // not live-tested on Windows. This lock therefore only sees connections that share both
    // the same machine AND the same OS login. Two Windows connections under different logins
    // never observe each other's lock file at all (this is a silent no-op between them, not a
    // slower path) — only SAP's own per-object enqueue lock still catches a real collision
    // between those. Confirmed acceptable for this deployment: all connections here run under
    // one shared Windows login.
    const key = crypto.createHash('sha1').update(`${url}|${client}`).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), `mcp-abap-adt-writelock-${key}.json`);
}

function readLock(lockPath: string): LockPayload | null {
    try {
        return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Same-host liveness probe — signal 0 only checks whether the pid exists, it never
 * actually signals the process. Lets a crash be detected immediately instead of only
 * after STALE_MS elapses. Returns true (assume alive) whenever this can't be determined
 * conclusively — EPERM means the pid exists but is owned by another user, and any other
 * unexpected error is treated the same way the "fail open on lock I/O" behavior does
 * elsewhere in this file: uncertain is not the same as dead, so fall back to the
 * time-based staleness check rather than take over on a guess.
 */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        return err?.code !== 'ESRCH'; // ESRCH = no such process = confirmed dead
    }
}

export type AcquireResult = { ok: true } | { ok: false; message: string };

/**
 * Cross-process stateful-operation gate. This server runs over stdio, so two MCP
 * connections are two separate OS processes with no shared memory — the only thing SAP
 * itself uses to identify "who holds this editing session" is the sap-contextid cookie
 * handed back by the LOCK call (see the stale-cookie note in utils.ts). This lock file
 * mirrors that: it records the owning pid and, as soon as it's known, that connection's
 * real sap-contextid as the token. Any second stateful operation, including one from
 * the same pid, is turned away immediately with a warning naming the current token,
 * instead of racing its own LOCK against SAP or silently queuing/waiting.
 */
export function acquireStatefulOperationLock(label: string): AcquireResult {
    const lockPath = lockFilePath();
    const payload: LockPayload = { pid: process.pid, token: `pending:${process.pid}`, label, acquiredAt: Date.now() };

    try {
        fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx' }); // atomic create-exclusive
        return { ok: true };
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            // Can't reliably lock (permissions, read-only tmp dir, ...) — fail open rather
            // than block every write over an unrelated infra problem.
            return { ok: true };
        }
    }

    const existing = readLock(lockPath);
    if (!existing) {
        try { fs.writeFileSync(lockPath, JSON.stringify(payload)); } catch { /* fail open */ }
        return { ok: true };
    }

    const ageMs = Date.now() - existing.acquiredAt;
    if (ageMs > STALE_MS || !isProcessAlive(existing.pid)) {
        // Abandoned lock — either aged out, or (the common crash case) the holder's own
        // process no longer exists. The dead-pid path takes over immediately rather than
        // waiting out STALE_MS, since there is nothing left that could still finish and
        // release it. Time-based staleness remains as the fallback for whatever the pid
        // check can't determine (EPERM, cross-container pid namespaces, etc.).
        try { fs.writeFileSync(lockPath, JSON.stringify(payload)); } catch { /* fail open */ }
        return { ok: true };
    }

    const ageSec = Math.round(ageMs / 1000);
    const holderToken = existing.token.startsWith('pending:')
        ? 'still establishing its SAP session'
        : existing.token;
    return {
        ok: false,
        message: `Blocked: a stateful SAP MCP operation (pid ${existing.pid}) is currently running '${existing.label}' against this SAP system, holding token ${holderToken} (started ${ageSec}s ago). ` +
                 `This operation will not proceed concurrently — wait for it to finish and retry.`
    };
}

/**
 * Called once the real sap-contextid is known (right after LOCK succeeds), so a connection
 * blocked in the meantime is shown the actual SAP session token instead of the
 * 'pending:<pid>' placeholder. No-op if this process no longer owns the lock file (e.g. it
 * was taken over as stale before the LOCK response came back).
 */
export function refreshStatefulOperationToken(sapContextId: string): void {
    const lockPath = lockFilePath();
    const existing = readLock(lockPath);
    if (existing?.pid !== process.pid) return;
    try {
        fs.writeFileSync(lockPath, JSON.stringify({ ...existing, token: sapContextId }));
    } catch { /* best-effort */ }
}

export function releaseStatefulOperationLock(): void {
    const lockPath = lockFilePath();
    const existing = readLock(lockPath);
    if (existing?.pid === process.pid) {
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
}
