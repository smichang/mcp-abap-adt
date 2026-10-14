// Pure old_string → new_string patching of ABAP source, used by WriteProgram(edits=[…]).
// No SAP, no I/O — everything here is unit-testable (sourcePatch.test.ts).
//
// Rules (same contract as an editor's exact-match replace):
//  - every edit's old_string must occur EXACTLY once, unless replace_all is set;
//  - edits apply in order, each to the result of the previous one;
//  - atomic: the first failing edit aborts the whole patch, nothing is returned as applied;
//  - matching is exact (case, indentation, trailing blanks). A failed match carries a hint when
//    the text exists with different whitespace/case, so one retry is enough instead of a re-read.
//  - line endings: the source's own style (LF or CRLF) is kept; old/new_string are matched and
//    inserted in that style regardless of which one the caller typed.

export interface PatchEdit {
    old_string: string;
    new_string: string;
    replace_all?: boolean;
}

export interface AppliedEdit {
    index: number;        // 0-based position in edits[]
    replacements: number;
    line: number;         // 1-based line of the first replacement, in the text as it was when this edit ran
}

export type PatchResult =
    | { ok: true; text: string; applied: AppliedEdit[] }
    | { ok: false; editIndex: number; error: string };

export const MAX_EDITS = 20;
const MAX_LISTED_LINES = 6;
const CONTEXT_LINES = 2;

/** Validates the shape of the `edits` argument. Throws Error with a caller-ready message. */
export function validateEdits(raw: unknown): PatchEdit[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('edits must be a non-empty array of { old_string, new_string, replace_all? }');
    }
    if (raw.length > MAX_EDITS) {
        throw new Error(`edits has ${raw.length} entries; the limit is ${MAX_EDITS} per call (split the change, or use source_code for a rewrite).`);
    }
    return raw.map((e: any, i: number) => {
        const where = `edits[${i}]`;
        if (!e || typeof e !== 'object') throw new Error(`${where} must be an object { old_string, new_string }`);
        if (typeof e.old_string !== 'string' || e.old_string.length === 0) throw new Error(`${where}.old_string must be a non-empty string`);
        if (typeof e.new_string !== 'string') throw new Error(`${where}.new_string must be a string (use "" to delete the text)`);
        if (e.replace_all !== undefined && typeof e.replace_all !== 'boolean') throw new Error(`${where}.replace_all must be a boolean`);
        if (toLf(e.old_string) === toLf(e.new_string)) throw new Error(`${where}: old_string and new_string are identical — nothing to change`);
        return { old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all === true };
    });
}

const toLf = (s: string) => s.replace(/\r\n/g, '\n');

export function applyEdits(source: string, edits: PatchEdit[]): PatchResult {
    const crlf = source.includes('\r\n');
    let text = toLf(source);
    const applied: AppliedEdit[] = [];

    for (let i = 0; i < edits.length; i++) {
        const oldS = toLf(edits[i].old_string);
        const newS = toLf(edits[i].new_string);
        const positions = findAll(text, oldS);

        if (positions.length === 0) {
            return { ok: false, editIndex: i, error: `edits[${i}]: old_string not found.${notFoundHint(text, oldS)}` };
        }
        if (positions.length > 1 && !edits[i].replace_all) {
            const shown = positions.slice(0, MAX_LISTED_LINES);
            const lines = shown.map(p => lineOf(text, p));
            const more = positions.length > MAX_LISTED_LINES ? ` … (+${positions.length - MAX_LISTED_LINES} more)` : '';
            const tLines = text.split('\n');
            const span = oldS.split('\n').length - (oldS.endsWith('\n') ? 1 : 0);
            // 2 lines of context either side of each match, so the caller can pick a unique anchor
            // (the neighbouring statements usually differ) without re-reading the whole source.
            const context = shown.map((p, k) => {
                const from = Math.max(0, lines[k] - 1 - CONTEXT_LINES);
                const to = Math.min(tLines.length, lines[k] - 1 + span + CONTEXT_LINES);
                return `  match ${k + 1} (line ${lines[k]}):\n` + tLines.slice(from, to).map((l, n) => `    ${from + n + 1}| ${l}`).join('\n');
            }).join('\n');
            return {
                ok: false, editIndex: i,
                error: `edits[${i}]: old_string matches ${positions.length} places (lines ${lines.join(', ')}${more}). ` +
                    `Include more surrounding text to make it unique, or set replace_all=true to change every occurrence.\n${context}`
            };
        }

        const firstLine = lineOf(text, positions[0]);
        if (edits[i].replace_all) {
            // slice-and-join, never String.replace — new_string may contain "$&" / "$1" literally
            let out = '';
            let last = 0;
            for (const p of positions) { out += text.slice(last, p) + newS; last = p + oldS.length; }
            text = out + text.slice(last);
        } else {
            text = text.slice(0, positions[0]) + newS + text.slice(positions[0] + oldS.length);
        }
        applied.push({ index: i, replacements: positions.length, line: firstLine });
    }

    return { ok: true, text: crlf ? text.replace(/\n/g, '\r\n') : text, applied };
}

function findAll(text: string, needle: string): number[] {
    const out: number[] = [];
    let from = 0;
    for (;;) {
        const p = text.indexOf(needle, from);
        if (p < 0) break;
        out.push(p);
        from = p + needle.length; // non-overlapping
    }
    return out;
}

function lineOf(text: string, pos: number): number {
    let n = 1;
    for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

const normWs = (s: string) => s.replace(/[ \t]+/g, ' ').trim();

function notFoundHint(text: string, oldS: string): string {
    const tLines = text.split('\n');
    const oLines = oldS.split('\n');
    // old_string often ends with "\n"; the empty tail must not be compared as a line
    while (oLines.length > 1 && oLines[oLines.length - 1] === '') oLines.pop();
    const n = oLines.length;
    const show = (i: number) => tLines.slice(i, i + n).slice(0, MAX_LISTED_LINES).map((l, k) => `  ${i + k + 1}| ${l}`).join('\n');

    const windowMatch = (cmp: (a: string) => string): number => {
        const want = oLines.map(cmp);
        for (let i = 0; i + n <= tLines.length; i++) {
            let same = true;
            for (let k = 0; k < n && same; k++) same = cmp(tLines[i + k]) === want[k];
            if (same) return i;
        }
        return -1;
    };

    // SAP stores source without a final line break: an old_string ending in "\n" then fails only
    // because its last line is the last line of the source.
    if (oldS.endsWith('\n') && text.includes(oldS.replace(/\n+$/, '')) && !text.includes(oldS)) {
        const at0 = lineOf(text, text.indexOf(oldS.replace(/\n+$/, '')));
        return ` The text exists at line ${at0} but is not followed by a line break (end of the source) — drop the trailing line break from old_string.`;
    }

    let at = windowMatch(normWs);
    if (at >= 0) {
        return ` The same text exists at line ${at + 1} but with different whitespace/indentation. Exact text there:\n${show(at)}`;
    }
    at = windowMatch(s => normWs(s).toLowerCase());
    if (at >= 0) {
        return ` The same text exists at line ${at + 1} but with different letter case. Exact text there:\n${show(at)}`;
    }
    const first = oLines.map(normWs).find(l => l.length > 0);
    if (first) {
        const idx = tLines.findIndex(l => normWs(l) === first);
        if (idx >= 0) {
            return ` Its first line was found at line ${idx + 1}, but the following lines differ from the source. Nearby text:\n${show(idx)}`;
        }
    }
    return ' None of its lines occur in the current source. Check the text against the source (GetCode) — e.g. a typo, or text that exists in another object or include.';
}
