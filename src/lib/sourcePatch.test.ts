import { applyEdits, validateEdits, MAX_EDITS, PatchEdit } from './sourcePatch';

// Pure unit tests — no SAP connection needed.

const SRC = [
    'REPORT zdemo.',
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

const e = (old_string: string, new_string: string, replace_all?: boolean): PatchEdit => ({ old_string, new_string, replace_all });

function okText(src: string, edits: PatchEdit[]): string {
    const r = applyEdits(src, edits);
    if (!r.ok) throw new Error('expected ok, got: ' + r.error);
    return r.text;
}

function failure(src: string, edits: PatchEdit[]) {
    const r = applyEdits(src, edits);
    if (r.ok) throw new Error('expected failure');
    return r;
}

describe('validateEdits', () => {
    it('accepts a well-formed list and defaults replace_all to false', () => {
        const v = validateEdits([{ old_string: 'a', new_string: 'b' }]);
        expect(v).toEqual([{ old_string: 'a', new_string: 'b', replace_all: false }]);
    });
    it('allows new_string "" (delete)', () => {
        expect(() => validateEdits([{ old_string: 'a', new_string: '' }])).not.toThrow();
    });
    it.each([
        ['not an array', 'x'],
        ['undefined', undefined],
        ['empty array', []],
    ])('rejects %s', (_n, v) => {
        expect(() => validateEdits(v as any)).toThrow(/non-empty array/);
    });
    it(`rejects more than ${MAX_EDITS} edits`, () => {
        const many = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({ old_string: 'a' + i, new_string: 'b' }));
        expect(() => validateEdits(many)).toThrow(/limit is 20/);
        expect(() => validateEdits(many.slice(0, MAX_EDITS))).not.toThrow();
    });
    it('rejects a non-object entry, naming its index', () => {
        expect(() => validateEdits([{ old_string: 'a', new_string: 'b' }, 'oops'])).toThrow(/edits\[1\] must be an object/);
    });
    it('rejects empty or non-string old_string', () => {
        expect(() => validateEdits([{ old_string: '', new_string: 'b' }])).toThrow(/old_string must be a non-empty string/);
        expect(() => validateEdits([{ old_string: 5, new_string: 'b' }])).toThrow(/old_string/);
        expect(() => validateEdits([{ new_string: 'b' }])).toThrow(/old_string/);
    });
    it('rejects missing or non-string new_string', () => {
        expect(() => validateEdits([{ old_string: 'a' }])).toThrow(/new_string must be a string/);
        expect(() => validateEdits([{ old_string: 'a', new_string: null }])).toThrow(/new_string/);
    });
    it('rejects a non-boolean replace_all', () => {
        expect(() => validateEdits([{ old_string: 'a', new_string: 'b', replace_all: 'yes' }])).toThrow(/replace_all must be a boolean/);
    });
    it('rejects a no-op edit, also when only the line endings differ', () => {
        expect(() => validateEdits([{ old_string: 'a', new_string: 'a' }])).toThrow(/identical/);
        expect(() => validateEdits([{ old_string: 'a\r\nb', new_string: 'a\nb' }])).toThrow(/identical/);
    });
});

describe('applyEdits — happy paths', () => {
    it('replaces a unique single-line string', () => {
        const t = okText(SRC, [e('lv_a = 1.', 'lv_a = 10.')]);
        expect(t).toContain('  lv_a = 10.');
        expect(t).not.toContain('lv_a = 1.');
        expect(t.split('\n').length).toBe(SRC.split('\n').length);
    });
    it('reports the 1-based line of the replacement', () => {
        const r = applyEdits(SRC, [e('lv_b = 2.', 'lv_b = 3.')]);
        expect(r.ok && r.applied).toEqual([{ index: 0, replacements: 1, line: 8 }]);
    });
    it('deletes text with new_string ""', () => {
        const t = okText(SRC, [e('  lv_b = 2.\n', '')]);
        expect(t).not.toContain('lv_b = 2');
        expect(t.split('\n').length).toBe(SRC.split('\n').length - 1);
    });
    it('inserts lines after an anchor (multi-line old/new)', () => {
        const t = okText(SRC, [e('  lv_a = 1.\n', '  lv_a = 1.\n  lv_c = 3.\n')]);
        expect(t.split('\n')[7]).toBe('  lv_c = 3.');
    });
    it('keeps the final newline and everything outside the edit byte-identical', () => {
        const t = okText(SRC, [e('lv_a = 1.', 'lv_a = 9.')]);
        expect(t.endsWith('\n')).toBe(true);
        expect(t.replace('lv_a = 9.', 'lv_a = 1.')).toBe(SRC);
    });
    it('applies edits sequentially — a later edit may anchor on an earlier one\'s output', () => {
        const t = okText(SRC, [e('lv_a = 1.', 'lv_a = 1. " first'), e('" first', '" second')]);
        expect(t).toContain('lv_a = 1. " second');
    });
    it('treats $ patterns in new_string literally (no regex replacement semantics)', () => {
        const t = okText(SRC, [e('lv_a = 1.', 'lv_a = $& + $1 + $$.')]);
        expect(t).toContain('lv_a = $& + $1 + $$.');
    });
    it('treats regex metacharacters in old_string literally', () => {
        const src = 'x = a.b(c)*d+e.\n';
        expect(okText(src, [e('a.b(c)*d+e', 'z')])).toBe('x = z.\n');
        expect(applyEdits(src, [e('a.b(c)*d+X', 'z')]).ok).toBe(false);
    });
    it('handles unicode text', () => {
        const src = "WRITE 'Größe ✓ 你好'.\n";
        expect(okText(src, [e('你好', '世界')])).toBe("WRITE 'Größe ✓ 世界'.\n");
    });
    it('does not mutate its input', () => {
        const copy = SRC.slice();
        const edits = [e('lv_a = 1.', 'lv_a = 5.')];
        const before = JSON.stringify(edits);
        applyEdits(SRC, edits);
        expect(SRC).toBe(copy);
        expect(JSON.stringify(edits)).toBe(before);
    });
});

describe('applyEdits — uniqueness and replace_all', () => {
    it('refuses an ambiguous old_string and lists the line numbers', () => {
        const f = failure(SRC, [e('TYPE i', 'TYPE p')]);
        expect(f.editIndex).toBe(0);
        expect(f.error).toMatch(/matches 2 places \(lines 3, 4\)/);
        expect(f.error).toMatch(/replace_all=true/);
    });
    it('shows surrounding lines for every match so a unique anchor can be chosen without a re-read', () => {
        const src = [
            'METHOD add.', '  LOOP AT it INTO ls.', '    t = t + 1.', '  ENDLOOP.', '  r = t.', 'ENDMETHOD.',
            'METHOD mul.', '  LOOP AT it INTO ls.', '    t = t + 1.', '  ENDLOOP.', '  r = t * 2.', 'ENDMETHOD.',
        ].join('\n');
        const f = failure(src, [e('t = t + 1.', 't = t + 2.')]);
        expect(f.error).toMatch(/matches 2 places \(lines 3, 9\)/);
        expect(f.error).toContain('match 1 (line 3):');
        expect(f.error).toContain('match 2 (line 9):');
        expect(f.error).toContain('  11| ' + '  r = t * 2.'); // the distinguishing neighbour of match 2
        expect(f.error).toContain('   5| ' + '  r = t.');      // …and of match 1
        // and that context really is enough: the longer anchor is unique
        expect(applyEdits(src, [e('t = t + 1.\n  ENDLOOP.\n  r = t * 2.', 'X')]).ok).toBe(true);
    });
    it('context is clipped at the source boundaries', () => {
        const f = failure('a\na', [e('a', 'b')]);
        expect(f.error).toContain('1| a');
        expect(f.error).toContain('2| a');
    });
    it('caps the listed lines and says how many more', () => {
        const src = Array.from({ length: 10 }, () => 'x = x + 1.').join('\n');
        const f = failure(src, [e('x = x + 1.', 'x = x + 2.')]);
        expect(f.error).toMatch(/matches 10 places/);
        expect(f.error).toMatch(/\+4 more/);
    });
    it('replace_all changes every occurrence and counts them', () => {
        const r = applyEdits(SRC, [e('TYPE i', 'TYPE p', true)]);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.text.match(/TYPE p/g)?.length).toBe(2);
            expect(r.text).not.toContain('TYPE i');
            expect(r.applied[0].replacements).toBe(2);
            expect(r.applied[0].line).toBe(3);
        }
    });
    it('replace_all with a single occurrence is fine', () => {
        expect(okText(SRC, [e('START-OF-SELECTION.', 'INITIALIZATION.', true)])).toContain('INITIALIZATION.');
    });
    it('counts non-overlapping matches only', () => {
        const r = applyEdits('aaa', [e('aa', 'b', true)]);
        expect(r.ok && r.text).toBe('ba');
        expect(r.ok && r.applied[0].replacements).toBe(1);
    });
    it('replace_all where new_string contains old_string does not loop or re-replace', () => {
        expect(okText('a a a', [e('a', 'aa', true)])).toBe('aa aa aa');
    });
    it('a unique anchor is accepted even when its prefix occurs elsewhere', () => {
        // "lv_a" occurs many times, "lv_a = 1." exactly once
        expect(applyEdits(SRC, [e('lv_a', 'lv_x')]).ok).toBe(false);
        expect(applyEdits(SRC, [e('lv_a = 1.', 'lv_x = 1.')]).ok).toBe(true);
    });
});

describe('applyEdits — atomicity', () => {
    it('a failing later edit fails the whole patch and names its index', () => {
        const f = failure(SRC, [e('lv_a = 1.', 'lv_a = 2.'), e('NOT THERE', 'x'), e('lv_b = 2.', 'lv_b = 3.')]);
        expect(f.editIndex).toBe(1);
        expect(f.error).toMatch(/^edits\[1\]: old_string not found/);
    });
    it('the failure result carries no text (nothing partially applied)', () => {
        const r = applyEdits(SRC, [e('lv_a = 1.', 'lv_a = 2.'), e('NOT THERE', 'x')]);
        expect(r.ok).toBe(false);
        expect((r as any).text).toBeUndefined();
    });
    it('an edit that anchors on text removed by an earlier edit fails', () => {
        const f = failure(SRC, [e('lv_a = 1.\n', ''), e('lv_a = 1.', 'lv_a = 2.')]);
        expect(f.editIndex).toBe(1);
    });
});

describe('applyEdits — not-found hints', () => {
    it('hints at different indentation and shows the exact lines', () => {
        const f = failure(SRC, [e('lv_a   =   1.', 'lv_a = 2.')]);
        expect(f.error).toMatch(/line 7 but with different whitespace\/indentation/);
        expect(f.error).toContain('  7|   lv_a = 1.');
    });
    it('hints at wrong indentation on a multi-line anchor', () => {
        const f = failure(SRC, [e('lv_a = 1.\nlv_b = 2.', 'x')]);
        expect(f.error).toMatch(/line 7 but with different whitespace/);
        expect(f.error).toContain('  8|   lv_b = 2.');
    });
    it('hints at different letter case (ABAP is case-insensitive, the match is not)', () => {
        const f = failure(SRC, [e('start-of-selection.', 'INITIALIZATION.')]);
        expect(f.error).toMatch(/line 6 but with different letter case/);
        expect(f.error).toContain('START-OF-SELECTION.');
    });
    it('hints when only the first line is found', () => {
        const f = failure(SRC, [e('lv_a = 1.\n  lv_b = 99.', 'x')]);
        expect(f.error).toMatch(/first line was found at line 7/);
    });
    it('hints when old_string ends in a line break but the source ends right after the text', () => {
        const noFinalNewline = 'REPORT z.\nWRITE 1.';
        const f = failure(noFinalNewline, [e('WRITE 1.\n', 'WRITE 2.\n')]);
        expect(f.error).toMatch(/exists at line 2 but is not followed by a line break/);
        expect(applyEdits(noFinalNewline, [e('WRITE 1.', 'WRITE 2.')]).ok).toBe(true);
    });
    it('says the source may have changed when nothing matches', () => {
        const f = failure(SRC, [e('COMPLETELY ABSENT TEXT', 'x')]);
        expect(f.error).toMatch(/None of its lines occur in the current source/);
        expect(f.error).not.toMatch(/may have changed/); // plain absence is not drift
    });
    it('a trailing newline in old_string does not break the hint matching', () => {
        const f = failure(SRC, [e('lv_a   =  1.\n', 'x')]);
        expect(f.error).toMatch(/line 7 but with different whitespace/);
    });
});

describe('applyEdits — line endings', () => {
    const CRLF = SRC.replace(/\n/g, '\r\n');
    it('keeps CRLF in a CRLF source and inserts new lines as CRLF', () => {
        const t = okText(CRLF, [e('  lv_a = 1.\n', '  lv_a = 1.\n  lv_c = 3.\n')]);
        expect(t).toContain('  lv_c = 3.\r\n');
        expect(t.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
        expect(t.split('\r\n').length).toBe(CRLF.split('\r\n').length + 1);
    });
    it('matches a multi-line old_string typed with LF against a CRLF source', () => {
        expect(applyEdits(CRLF, [e('DATA: lv_a TYPE i,\n      lv_b TYPE i.', 'DATA lv_a TYPE i.')]).ok).toBe(true);
    });
    it('matches an old_string typed with CRLF against an LF source and stays LF', () => {
        const r = applyEdits(SRC, [e('DATA: lv_a TYPE i,\r\n      lv_b TYPE i.', 'DATA lv_a TYPE i.')]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.text).not.toContain('\r');
    });
    it('an LF source stays free of CR after any edit', () => {
        expect(okText(SRC, [e('lv_a = 1.', 'lv_a = 2.\n  lv_z = 0.')])).not.toContain('\r');
    });
});

describe('applyEdits — size and speed', () => {
    it('patches a 20k-line source in well under a second', () => {
        const big = Array.from({ length: 20000 }, (_, i) => `  lv_v${i} = ${i}.`).join('\n') + '\n';
        const t0 = Date.now();
        const r = applyEdits(big, [e('lv_v12345 = 12345.', 'lv_v12345 = 0.'), e('lv_v19999 = 19999.', 'lv_v19999 = 1.')]);
        const ms = Date.now() - t0;
        expect(r.ok).toBe(true);
        expect(ms).toBeLessThan(1000);
        if (r.ok) {
            expect(r.applied[0].line).toBe(12346);
            expect(r.text.length).toBe(big.length - 'lv_v12345 = 12345.'.length + 'lv_v12345 = 0.'.length - 'lv_v19999 = 19999.'.length + 'lv_v19999 = 1.'.length);
        }
    });
    it('an empty source simply cannot match', () => {
        expect(applyEdits('', [e('a', 'b')]).ok).toBe(false);
    });
});
