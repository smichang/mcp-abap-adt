import * as crypto from 'crypto';
import type { PatchEdit } from './sourcePatch';

// A passed dry run (WriteProgram edits[] + check_only) can be applied later by id instead of
// re-sending the same edits — the lifecycle test re-sent ~12 KB of edits JSON for the real write.
//
// The id names the EDITS, not a result: applying re-reads the object's current source and applies
// them again through the normal patch path (fail-fast anchor check, re-read inside the lock), so a
// source that changed after the dry run is handled exactly as for a direct edits[] call.
// In memory, per server process: a restart or the TTL forgets the id, and the caller simply
// sends the edits again.

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 20;

interface Stored {
    programName: string;
    edits: PatchEdit[];
    expires: number;
}

const store = new Map<string, Stored>();

function sweep(now: number) {
    for (const [id, s] of store) if (s.expires <= now) store.delete(id);
    while (store.size >= MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
    }
}

export function rememberPatch(programName: string, edits: PatchEdit[]): string {
    const now = Date.now();
    sweep(now);
    const id = 'p-' + crypto.randomBytes(4).toString('hex');
    store.set(id, { programName: programName.toUpperCase(), edits, expires: now + TTL_MS });
    return id;
}

/** The edits behind an id, or an explanation of why there are none. A patch is bound to its object. */
export function recallPatch(id: string, programName: string): { edits: PatchEdit[] } | { error: string } {
    const now = Date.now();
    const s = store.get(id);
    if (!s || s.expires <= now) {
        store.delete(id);
        return { error: `apply_patch '${id}' is unknown or expired (ids live ${TTL_MS / 60000} minutes and are forgotten when the server restarts) — send the edits again.` };
    }
    if (s.programName !== programName.toUpperCase()) {
        return { error: `apply_patch '${id}' was made for ${s.programName}, not ${programName.toUpperCase()}. Nothing was locked or written.` };
    }
    return { edits: s.edits };
}

export const PENDING_PATCH_TTL_MINUTES = TTL_MS / 60000;
