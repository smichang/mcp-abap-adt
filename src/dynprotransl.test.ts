/**
 * Live integration test of the Dynpro translation endpoint (ManageDynpro action=translate,
 * GetCode DYNPRO language=…). Needs a live SAP system (.env or keystore). Writes ONLY a disposable
 * $TMP program ZMCP_DTR_E2E with one screen, deleted in afterAll. Translation-log rows (LXE_LOG) for
 * the deleted program stay behind: no tool removes them and they are harmless.
 * Run: SECRETS_KEYSTORE=… SECRETS_KEYSTORE_PASSWORD_FILE=… npm test -- --testPathPattern=dynprotransl < /dev/null
 *
 * Element names are chosen so their alphabetical order differs from their creation order: the ABAP side
 * maps text keys to elements by the primary-key order of D021T, and a wrong mapping would put a
 * translation on the wrong element.
 */
import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleManageDynpro } from './handlers/handleManageDynpro';
import { handleGetCode } from './handlers/handleGetCode';
import { handleDataPreview } from './handlers/handleDataPreview';
import { handleDeleteObject } from './handlers/handleDeleteObject';

const PROG = 'ZMCP_DTR_E2E';
const text = (r: any): string => r?.content?.[0]?.text ?? '';
function mustOk(r: any, what = ''): string {
    if (r?.isError) throw new Error(`${what}: ${text(r)}`);
    return text(r);
}

const prog = [
    `REPORT ${PROG.toLowerCase()}.`, 'DATA ok_code TYPE sy-ucomm.', 'START-OF-SELECTION.', "  WRITE / 'dtr ran'.",
    'MODULE status_0100 OUTPUT.', '  SET PF-STATUS space.', 'ENDMODULE.',
    'MODULE user_command_0100 INPUT.', '  CLEAR ok_code.', 'ENDMODULE.', '',
].join('\n');
const FLOW = 'PROCESS BEFORE OUTPUT.\n  MODULE status_0100.\nPROCESS AFTER INPUT.\n  MODULE user_command_0100.';
const label = (name: string, txt: string, col: number) => ({
    cont_type: 'SCREEN', cont_name: 'SCREEN', type: 'TEXT', name, text: txt.padEnd(20, '_').replace(/ /g, '_'),
    line: 2, column: col, length: 20, vislength: 20, height: 1, format: 'CHAR', requ_entry: 'N',
});
const definition = () => ({
    header: { program: PROG, screen: '0100', language: 'E', descript: 'MCP translation e2e', type: 'N', nextscreen: '0100', lines: 20, columns: 80 },
    containers: [{ type: 'SCREEN', name: 'SCREEN', element_of: '', line: 0, column: 0, length: 0, height: 0 }],
    fields_to_containers: [
        { cont_type: 'SCREEN', cont_name: 'SCREEN', type: 'OKCODE', name: 'OK_CODE', text: '____________________', line: 0, column: 0, length: 20, vislength: 20, height: 1, format: 'CHAR', input_fld: 'X' },
        label('ZZ_LAST', 'Last Heading', 2),
        label('AA_FIRST', 'First Heading', 24),
        label('MM_MID', 'Middle Heading', 46),
    ],
    flow_logic: FLOW.split('\n').map(line => ({ line })),
    params: [],
});

async function d021t(lang: string): Promise<Record<string, string>> {
    const r = text(await handleDataPreview({ query: `SELECT fldn, dtxt FROM d021t WHERE prog = '${PROG}' AND dynr = '0100' AND lang = '${lang}'`, max_rows: 20 }));
    const out: Record<string, string> = {};
    for (const line of r.split('\n')) {
        const m = line.match(/^(ZZ_LAST|AA_FIRST|MM_MID)\s+(.*?)\s*$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

describe('Dynpro translation (ManageDynpro translate, GetCode DYNPRO language)', () => {
    beforeAll(async () => {
        mustOk(await handleWriteProgram({ program_name: PROG, source_code: prog, description: 'MCP dynpro translation e2e', package_name: '$TMP' }), 'program');
        mustOk(await handleManageDynpro({ action: 'create', program_name: PROG, dynnr: '0100', definition: definition() }), 'screen');
    });

    afterAll(async () => {
        const r = await handleManageDynpro({ action: 'delete', program_name: PROG, dynnr: '0100' });
        if (r?.isError) console.warn(`cleanup: screen not deleted: ${text(r)}`);
        const d = await handleDeleteObject({ object_name: PROG });
        if (d?.isError) console.warn(`LEFTOVER: ${PROG} — ${text(d)}`);
    });

    it('D1. lists the translatable elements with maximum length and no target text yet', async () => {
        const out = mustOk(await handleGetCode({ resource: 'DYNPRO', object_name: PROG, dynnr: '0100', language: 'M' }), 'list');
        expect(out).toContain('3 element(s), 3 without a M text');
        for (const e of ['ZZ_LAST', 'AA_FIRST', 'MM_MID']) expect(out).toContain(e);
        expect(out).toMatch(/AA_FIRST\s+20\s+First Heading/);
    });

    it('D2. writes translations on the right elements, leaves the master language alone', async () => {
        const out = mustOk(await handleManageDynpro({ action: 'translate', program_name: PROG, dynnr: '0100', language: 'M',
            translations: { ZZ_LAST: '最後標題', AA_FIRST: '第一標題' } }), 'translate');
        expect(out).toContain('Wrote 2 text(s)');
        expect(out).toContain('master language E unchanged');
        const zh = await d021t('M');
        expect(zh).toEqual({ ZZ_LAST: '最後標題', AA_FIRST: '第一標題' });
        const en = await d021t('E');
        expect(en).toEqual({ ZZ_LAST: 'Last Heading', AA_FIRST: 'First Heading', MM_MID: 'Middle Heading' });
        const listed = mustOk(await handleGetCode({ resource: 'DYNPRO', object_name: PROG, dynnr: '0100', language: 'ZF' }), 'list again');
        expect(listed).toContain('1 without a M text');
        expect(listed).toMatch(/MM_MID[^\n]*\(missing\)/);
        const master = mustOk(await handleGetCode({ resource: 'DYNPRO', object_name: PROG, dynnr: '0100' }), 'master');
        expect(master).toContain('Last Heading');
        expect(master).not.toContain('最後標題');
    });

    it('D3. updates an existing translation and accepts the LXE language code', async () => {
        mustOk(await handleManageDynpro({ action: 'translate', program_name: PROG, dynnr: '0100', language: 'zhTW',
            translations: [{ element: 'mm_mid', text: '中間標題' }, { element: 'ZZ_LAST', text: '末尾標題' }] }), 'update');
        expect(await d021t('M')).toEqual({ ZZ_LAST: '末尾標題', AA_FIRST: '第一標題', MM_MID: '中間標題' });
    });

    it('D4. refuses bad input and writes nothing', async () => {
        const before = await d021t('M');
        const call = (translations: any, language = 'M', program_name = PROG) =>
            handleManageDynpro({ action: 'translate', program_name, dynnr: '0100', language, translations });
        const unknown = await call({ AA_FIRST: '好', NO_SUCH: '無' });
        expect(unknown.isError).toBe(true);
        expect(text(unknown)).toMatch(/NO_SUCH.*no translatable text/);
        const tooLong = await call({ AA_FIRST: '一二三四五六七八九十一二三四五六七八九十一' });
        expect(tooLong.isError).toBe(true);
        expect(text(tooLong)).toMatch(/at most 20/);
        const master = await call({ AA_FIRST: 'x' }, 'E');
        expect(master.isError).toBe(true);
        expect(text(master)).toMatch(/master language/);
        const lang = await call({ AA_FIRST: 'x' }, 'Q9');
        expect(lang.isError).toBe(true);
        expect(text(lang)).toMatch(/unknown language/);
        const std = await handleManageDynpro({ action: 'translate', program_name: 'SAPMSSY0', dynnr: '0120', language: 'M', translations: { X: 'y' } });
        expect(std.isError).toBe(true);
        expect(text(std)).toMatch(/customer programs/);
        expect(await d021t('M')).toEqual(before);
    });
});
