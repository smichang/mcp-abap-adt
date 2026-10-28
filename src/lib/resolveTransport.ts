import { TransportCheck, CtsHeader, CtsLockHolder, fetchTransportCheck } from './transportCheck';

// "One CR per goal" — decides which change request a write belongs in, so the model never has to.
//
//   1. You already have an open CR          -> reuse it (sub-goals are tasks, not extra CRs).
//   2. You have none                        -> create one (CR + the task SAP adds itself).
//   3. An object, or its parent / related object, sits in someone else's CR
//                                           -> join THAT CR with a task of your own.
//
// The input is the transportchecks answer (transportCheck.ts) for the target object and for the
// objects it belongs to. That answer already carries both halves of the decision: the lock
// holders (rule 3) and, for a free object, the asking user's own open requests (rule 1).

export type CrRule = 1 | 2 | 3;

export type TransportDecision =
    | { kind: 'none'; reason: string }                       // local / non-transportable: no request needed
    | { kind: 'create'; rule: 2; reason: string }            // nothing to reuse: the caller creates one CR
    | { kind: 'use'; rule: 1 | 3; transportNumber: string; reason: string;
        needsOwnTask: boolean;                               // rule 3: the user has no task in that CR yet
        ambiguous?: string[] }                               // rule 1 picked one of several open CRs
    | { kind: 'conflict'; reason: string };                  // the goal spans CRs: only a human can pick

const norm = (s: string) => s.toUpperCase();

function mineIn(h: CtsLockHolder, me: string): boolean {
    return norm(h.request.owner) === me || h.tasks.some(t => norm(t.owner) === me);
}

const label = (h: CtsHeader) => `${h.number} (${h.owner}${h.text ? `, "${h.text}"` : ''})`;

/**
 * Pure decision over the transport checks of every object the change touches (target first,
 * then parents / related objects). `goalHint` (optional) picks between several open CRs of the
 * user by description; without a match the newest one wins and the others are reported.
 */
export function decideTransport(checks: TransportCheck[], currentUser: string, goalHint = ''): TransportDecision {
    const me = norm(currentUser);
    // An object already registered in a request answers RECORDING='' (nothing new to record) but lists its holder:
    // live 2026-10-27, a just-written report in ZBASIS. Holders therefore count as transportable.
    const recording = checks.filter(c => c.recording || c.holders.length);
    if (!recording.length) return { kind: 'none', reason: 'local object (no transport recorded)' };

    const holders = new Map<string, CtsLockHolder>();   // request number -> holder (first seen)
    for (const c of recording) for (const h of c.holders) if (!holders.has(h.request.number)) holders.set(h.request.number, h);
    const mine = [...holders.values()].filter(h => mineIn(h, me));
    const foreign = [...holders.values()].filter(h => !mineIn(h, me));

    if (foreign.length > 1) {
        return { kind: 'conflict', reason: `the objects of this change are held in ${foreign.length} different colleagues' change requests: ${foreign.map(h => label(h.request)).join('; ')}. One CR per goal is impossible here — decide with the owners which CR carries the change.` };
    }
    if (foreign.length === 1) {
        const f = foreign[0];
        if (mine.length) {
            return { kind: 'conflict', reason: `part of this change is held in your own CR ${mine.map(h => h.request.number).join(', ')} and part in ${label(f.request)}. An object cannot be moved between requests — pick the CR with the owners.` };
        }
        return {
            kind: 'use', rule: 3, transportNumber: f.request.number, needsOwnTask: true,   // a holder with a task of the user's counts as the user's own CR (rule 1)
            reason: `rule 3: an object of this change (or its parent) is held in ${label(f.request)} — joining that CR with an own task instead of opening a second one`,
        };
    }
    if (mine.length > 1) {
        return { kind: 'conflict', reason: `the objects of this change sit in several of your own CRs (${mine.map(h => h.request.number).join(', ')}). They cannot be merged by a write — use ManageTransport merge first.` };
    }
    if (mine.length === 1) {
        return { kind: 'use', rule: 1, transportNumber: mine[0].request.number, needsOwnTask: false,
            reason: `rule 1: the object is already in your own CR ${label(mine[0].request)}` };
    }

    // Everything free: reuse one of the user's open requests (transportchecks lists exactly those).
    const open = new Map<string, CtsHeader>();
    for (const c of recording) for (const r of c.candidates) {
        if (norm(r.owner) === me && (!r.status || r.status === 'D')) open.set(r.number, r);
    }
    if (!open.size) return { kind: 'create', rule: 2, reason: 'rule 2: you have no open CR' };
    const list = [...open.values()].sort((a, b) => b.number.localeCompare(a.number));   // newest first
    const hint = goalHint.trim().toLowerCase();
    const byHint = hint ? list.find(r => r.text.toLowerCase().includes(hint)) : undefined;
    const pick = byHint || list[0];
    return {
        kind: 'use', rule: 1, transportNumber: pick.number, needsOwnTask: false,
        reason: `rule 1: reusing your open CR ${label(pick)}${byHint ? ' (description matches the goal)' : list.length > 1 ? ' (newest of your open CRs)' : ''}`,
        ambiguous: list.length > 1 ? list.filter(r => r !== pick).map(r => label(r)) : undefined,
    };
}

/**
 * Fetches the transport check of each object URI (target first) and decides. A failed check is
 * not fatal: the caller falls back to its previous behaviour and says the check was skipped.
 */
export async function resolveTransport(
    baseUrl: string, objectUris: string[], currentUser: string, opts: { devclass?: string; goalHint?: string } = {}
): Promise<TransportDecision | { kind: 'unchecked'; reason: string }> {
    const checks: TransportCheck[] = [];
    for (let i = 0; i < objectUris.length; i++) {
        try {
            checks.push(await fetchTransportCheck(baseUrl, objectUris[i], opts.devclass || ''));
        } catch (e) {
            // The target must be checkable; a parent that cannot be (e.g. not created yet) is skipped.
            if (i === 0) return { kind: 'unchecked', reason: `transport check failed (${e instanceof Error ? e.message : String(e)})` };
        }
    }
    return decideTransport(checks, currentUser, opts.goalHint || '');
}

/** One-line statement for the tool response, so the choice is always auditable. */
export function describeDecision(d: TransportDecision | { kind: 'unchecked'; reason: string }): string {
    const extra = d.kind === 'use' && d.ambiguous?.length ? ` Other open CRs of yours: ${d.ambiguous.join('; ')}.` : '';
    return `CR choice — ${d.reason}.${extra}`;
}
