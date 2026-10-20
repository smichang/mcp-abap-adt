/**
 * Offline test (no SAP): GetCode SYNTAX and every GetDiagnostics resource honour output_file.
 * Until 2026-10-19 both ignored it silently and plans cited evidence files that were never written.
 * The real handlers are mocked; only the dispatch + lib/background contract is exercised.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../lib/utils', () => ({
    McpError: class extends Error { constructor(_c: any, m: string) { super(m); } },
    ErrorCode: { InvalidParams: 'InvalidParams' },
    return_error: (e: any) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] }),
}));
const ok = (text: string) => async () => ({ isError: false, content: [{ type: 'text', text }] });
jest.mock('./handleGetRuntimeDumps', () => ({ handleGetRuntimeDumps: ok('DUMP-TEXT') }));
jest.mock('./handleGetABAPTraces', () => ({ handleGetABAPTraces: ok('TRACE-TEXT') }));
jest.mock('./handleGetGatewayErrorLog', () => ({ handleGetGatewayErrorLog: ok('GW-TEXT') }));
jest.mock('./handleCheckSyntax', () => ({ handleCheckSyntax: ok('SYNTAX-TEXT') }));
for (const m of ['./handleGetObject', './handleGetObjectVersion', './handleGetEnhancements', './handleGetWhereUsed', './handleGetDynpro']) {
    jest.mock(m, () => ({}));
}

import { handleGetDiagnostics } from './handleGetDiagnostics';
import { handleGetCode } from './handleGetCode';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outfile-'));
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('output_file is honoured', () => {
    test.each([['DUMP', 'DUMP-TEXT'], ['TRACE', 'TRACE-TEXT'], ['GW_ERRORLOG', 'GW-TEXT']])('GetDiagnostics %s', async (resource, text) => {
        const f = path.join(tmp, `${resource}.txt`);
        const res: any = await handleGetDiagnostics({ resource, output_file: f });
        expect(read(f)).toBe(text);
        expect(res.content[0].text).toContain(`(written to ${f})`);
    });
    test('GetCode SYNTAX', async () => {
        const f = path.join(tmp, 'syntax.txt');
        await handleGetCode({ resource: 'SYNTAX', object_name: 'ZX', output_file: f });
        expect(read(f)).toBe('SYNTAX-TEXT');
    });
    test('without output_file nothing changes', async () => {
        const res: any = await handleGetDiagnostics({ resource: 'DUMP' });
        expect(res.content[0].text).toBe('DUMP-TEXT');
    });
});
