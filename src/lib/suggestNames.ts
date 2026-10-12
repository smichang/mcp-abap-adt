import { makeAdtRequest, getBaseUrl } from './utils';

/**
 * "Did you mean" fallback for a failed object-name resolution.
 *
 * The miss this exists for is a *wrong word-split* in a standard SAP name —
 * guessing `BAPI_GLACC_GETDETAIL` from the shape of `BAPI_COMPANYCODE_GETDETAIL`
 * when the real FM is `BAPI_GL_ACC_GETDETAIL`. A trailing-wildcard search on the
 * full guessed name (what the callers already do) can never find it: the
 * difference is in the middle, not the tail.
 *
 * Two ideas make the suggestions trustworthy rather than noise:
 *   1. Underscore-insensitive comparison — a wrong word-split IS an underscore
 *      placement error, so stripping `_` from both sides turns this failure class
 *      into an exact match with no fuzzy scoring involved.
 *   2. A short, bounded prefix ladder (<= 3 quickSearches, failure path only) to
 *      get the real name into a result set at all, with the broadest rung
 *      accepting exact-normalized hits ONLY so `BAPI*` can't spray guesses.
 *
 * Returns [] rather than anything speculative when nothing scores well — callers
 * then emit their original "not found" message unchanged.
 */

export interface NameSuggestion {
    name: string;
    type: string;
    packageName: string;
    group: string;            // function group, only derivable for FUGR/FF (from the URI)
    exactNormalized: boolean; // true => same name modulo underscore placement
}

const MAX_SEARCHES = 3;
const MAX_SUGGESTIONS = 3;
const SEARCH_MAX_RESULTS = 200;

const normalize = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Build the prefix ladder, most selective first. Each entry says how permissive it may be. */
function prefixLadder(objectName: string): { prefix: string; exactOnly: boolean }[] {
    const name = objectName.toUpperCase();
    const segs = name.split('_').filter(s => s.length > 0);
    const out: { prefix: string; exactOnly: boolean }[] = [];

    if (segs.length >= 2) {
        // 1. First two segments — catches a wrong 3rd+ segment cheaply and selectively.
        out.push({ prefix: `${segs[0]}_${segs[1]}`, exactOnly: false });
        // 2. First segment + 2 chars of the second — the split-error catcher
        //    (BAPI_GLACC_GETDETAIL -> "BAPI_GL", which BAPI_GL_ACC_GETDETAIL starts with).
        if (segs[1].length > 2) out.push({ prefix: `${segs[0]}_${segs[1].slice(0, 2)}`, exactOnly: false });
        // 3. First segment alone — broadest; exact-normalized hits only, no fuzzy.
        if (segs[0].length >= 3) out.push({ prefix: segs[0], exactOnly: true });
    } else {
        // Single-segment name: halve it, floor at 4 chars.
        const cut = Math.max(4, Math.ceil(name.length / 2));
        if (cut < name.length) out.push({ prefix: name.slice(0, cut), exactOnly: false });
    }

    // Drop rungs that are the full name again (already searched by the caller) or too short to be selective.
    const seen = new Set<string>();
    return out.filter(r => {
        if (r.prefix.length < 3 || r.prefix === name) return false;
        if (seen.has(r.prefix)) return false;
        seen.add(r.prefix);
        return true;
    }).slice(0, MAX_SEARCHES);
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length || !b.length) return Math.max(a.length, b.length);
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[b.length];
}

function getAttr(attrs: any, localName: string): string {
    const k = Object.keys(attrs).find((x: string) => x === localName || x.endsWith(':' + localName));
    return k ? String(attrs[k] || '') : '';
}

async function quickSearch(query: string): Promise<any[]> {
    try {
        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/sap/bc/adt/repository/informationsystem/search`
            + `?operation=quickSearch&query=${encodeURIComponent(query)}&maxResults=${SEARCH_MAX_RESULTS}`;
        const response = await makeAdtRequest(url, 'GET', 15000);
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) return [];
        const root = parsed[rootKey];
        const refKey = Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
        if (!refKey) return [];
        const raw = root[refKey];
        return (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
    } catch {
        return [];
    }
}

function toSuggestion(ref: any, exactNormalized: boolean): NameSuggestion {
    const attrs = ref._attributes || {};
    const uri = getAttr(attrs, 'uri');
    const groupMatch = uri.match(/\/functions\/groups\/([^/]+)\/fmodules\//i);
    return {
        name: getAttr(attrs, 'name').toUpperCase(),
        type: getAttr(attrs, 'type').toUpperCase(),
        packageName: getAttr(attrs, 'packageName'),
        group: groupMatch ? groupMatch[1].toUpperCase() : '',
        exactNormalized
    };
}

/**
 * Runs only after a name has already failed to resolve. At most MAX_SEARCHES extra
 * quickSearches; returns at most MAX_SUGGESTIONS candidates, exact-normalized first.
 */
export async function suggestObjectNames(objectName: string): Promise<NameSuggestion[]> {
    const target = normalize(objectName);
    if (target.length < 4) return [];

    // Fuzzy tolerance scales with name length, but stays tight: a 20-char name allows 3 edits.
    const tolerance = Math.max(1, Math.floor(target.length * 0.15));

    const exact: NameSuggestion[] = [];
    const near: { s: NameSuggestion; d: number }[] = [];
    const seenNames = new Set<string>([objectName.toUpperCase()]);

    for (const rung of prefixLadder(objectName)) {
        for (const ref of await quickSearch(rung.prefix + '*')) {
            const name = getAttr(ref._attributes || {}, 'name').toUpperCase();
            if (!name || seenNames.has(name)) continue;
            const cand = normalize(name);
            if (cand === target) {
                seenNames.add(name);
                exact.push(toSuggestion(ref, true));
                continue;
            }
            if (rung.exactOnly) continue;
            // Guard against absurd pairings before paying for the edit distance.
            if (Math.abs(cand.length - target.length) > tolerance) continue;
            const d = levenshtein(cand, target);
            if (d <= tolerance) {
                seenNames.add(name);
                near.push({ s: toSuggestion(ref, false), d });
            }
        }
        if (exact.length) break;   // an underscore-only difference is conclusive; stop searching
    }

    if (exact.length) return exact.slice(0, MAX_SUGGESTIONS);
    return near.sort((a, b) => a.d - b.d).slice(0, MAX_SUGGESTIONS).map(n => n.s);
}

/** Renders suggestions as extra lines for a "not found" message. Empty string when there are none. */
export function formatSuggestions(suggestions: NameSuggestion[]): string {
    if (!suggestions.length) return '';
    const describe = (s: NameSuggestion): string => {
        const bits = [s.type, s.group ? `group ${s.group}` : '', s.packageName ? `pkg ${s.packageName}` : '']
            .filter(Boolean).join(', ');
        return bits ? `${s.name} (${bits})` : s.name;
    };
    if (suggestions.length === 1 && suggestions[0].exactNormalized) {
        return `\nDid you mean: ${describe(suggestions[0])}? (same name, different word split)`;
    }
    const header = suggestions[0].exactNormalized
        ? 'Same name with a different word split:'
        : 'Closest names in SAP (verify before using):';
    return `\n${header}\n` + suggestions.map(s => `  ${describe(s)}`).join('\n');
}
