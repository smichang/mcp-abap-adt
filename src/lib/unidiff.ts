// Minimal dependency-free unified-diff for two text blobs (line-based, LCS).
// Tuned for ABAP source version comparison: typical files are hundreds–low-thousands
// of lines, so the O(n*m) LCS table is fine, with a guard against pathological sizes.

export interface DiffResult {
    added: number;
    removed: number;
    identical: boolean;
    /** Unified-diff hunks (empty when identical or skipped). May be truncated — see truncatedLines. */
    body: string;
    /** Set when the diff was skipped because the inputs were too large. */
    skipped?: string;
    /** Number of diff lines omitted from `body` because it hit maxLines (0 = full diff). */
    truncatedLines: number;
}

interface Op { t: ' ' | '-' | '+'; line: string; aNo: number; bNo: number; }

const MAX_CELLS = 9_000_000; // ~3000×3000 lines; Int32Array table ≈ 36 MB transient

/**
 * @param context  unchanged context lines around each change (default 3)
 * @param maxLines  cap on emitted diff-body lines; excess hunks are dropped and reported
 *                  via truncatedLines (default 1500, so a huge rewrite can't blow up output)
 */
export function unifiedDiff(aText: string, bText: string, context = 3, maxLines = 1500): DiffResult {
    const a = aText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const b = bText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const n = a.length, m = b.length;

    if (n * m > MAX_CELLS) {
        return { added: 0, removed: 0, identical: false, body: '', truncatedLines: 0, skipped: `inputs too large for inline diff (${n} vs ${m} lines)` };
    }

    // LCS length table (filled from the bottom-right).
    const W = m + 1;
    const dp = new Int32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * W + j] = a[i] === b[j]
                ? dp[(i + 1) * W + (j + 1)] + 1
                : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
        }
    }

    // Backtrack into an edit script, tracking 1-based line numbers in each file.
    const ops: Op[] = [];
    let i = 0, j = 0, an = 0, bn = 0;
    const push = (t: Op['t'], line: string) => {
        if (t !== '+') an++;
        if (t !== '-') bn++;
        ops.push({ t, line, aNo: an, bNo: bn });
    };
    while (i < n && j < m) {
        if (a[i] === b[j]) { push(' ', a[i]); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { push('-', a[i]); i++; }
        else { push('+', b[j]); j++; }
    }
    while (i < n) { push('-', a[i]); i++; }
    while (j < m) { push('+', b[j]); j++; }

    const added = ops.reduce((s, o) => s + (o.t === '+' ? 1 : 0), 0);
    const removed = ops.reduce((s, o) => s + (o.t === '-' ? 1 : 0), 0);
    if (added === 0 && removed === 0) return { added: 0, removed: 0, identical: true, body: '', truncatedLines: 0 };

    // Select op indices within `context` of any change, then merge into hunks.
    const changed = ops.map(o => o.t !== ' ');
    const keep = new Array(ops.length).fill(false);
    for (let k = 0; k < ops.length; k++) {
        if (changed[k]) {
            for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
        }
    }

    const hunks: string[] = [];
    let k = 0, truncatedLines = 0;
    while (k < ops.length) {
        if (!keep[k]) { k++; continue; }
        let end = k;
        while (end < ops.length && keep[end]) end++;
        const slice = ops.slice(k, end);
        k = end;

        const aLines = slice.filter(o => o.t !== '+');
        const bLines = slice.filter(o => o.t !== '-');
        const aStart = aLines.length ? aLines[0].aNo : (slice[0].aNo);
        const bStart = bLines.length ? bLines[0].bNo : (slice[0].bNo);

        // Stop emitting once we hit the line budget; count the rest as truncated.
        if (hunks.length + slice.length + 1 > maxLines) {
            truncatedLines += slice.length + 1;
            continue;
        }
        hunks.push(`@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`);
        for (const o of slice) hunks.push(`${o.t}${o.line}`);
    }

    return { added, removed, identical: false, body: hunks.join('\n'), truncatedLines };
}
