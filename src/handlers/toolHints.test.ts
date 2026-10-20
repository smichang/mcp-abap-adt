/**
 * Offline test (no SAP) of the read-path hints added after the 2026-10-19 OpenCode plan eval:
 * T1 GetCode object_name validation (objects[] batch), T2 unsupported-type messages, T3 selection
 * screen note, T4 inactive-object owner note.
 */
jest.mock('../lib/utils', () => ({
    McpError: class extends Error { constructor(_c: any, m: string) { super(m); } },
    ErrorCode: { InvalidParams: 'InvalidParams' },
    return_error: (e: any) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] }),
    makeAdtRequest: jest.fn(), getBaseUrl: jest.fn(), parseAdtErrorXml: jest.fn(), return_response: jest.fn(),
}));
jest.mock('./handleGetObject', () => ({
    ...jest.requireActual('./handleGetObject'),
    handleGetObject: jest.fn(async (a: any) => ({ isError: false, content: [{ type: 'text', text: `SRC ${a.object_name}` }] })),
}));

import { unsupportedKindMessage } from './handleGetObject';
import { selectionScreenNote } from './handleGetDynpro';
import { ownerNote } from './handleGetInactiveObjects';
import { handleGetCode } from './handleGetCode';

describe('T1 GetCode object_name', () => {
    test('objects[] batch works without object_name', async () => {
        const r: any = await handleGetCode({ resource: 'OBJECT', objects: ['ZA', 'ZB'] });
        expect(r.isError).toBe(false);
        expect(r.content[0].text).toContain('===== ZA =====');
    });
    test('a single read without object_name is refused with a clear message', async () => {
        const r: any = await handleGetCode({ resource: 'WHEREUSED', object_type: 'PROG' });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/object_name is required for resource=WHEREUSED/);
    });
});

describe('T2 unsupported types name the right tool', () => {
    test.each([
        ['ZUT01', 'DEVC/K', /GetMeta resource=PACKAGE package_name=ZUT01/],
        ['ZMM02', 'MSAG/N', /GetMeta resource=MESSAGE_CLASS message_class=ZMM02/],
        ['ZRUT0008', 'TRAN/T', /GetMeta resource=TRANSACTION transaction_name=ZRUT0008/],
        ['ZPPVC0136_A05_2', 'WAPA/WO', /BSP\/UI5 web application/],
    ])('%s (%s)', (name, type, re) => {
        expect(unsupportedKindMessage(name, type)).toMatch(re);
    });
    test('unknown type keeps the generic hint', () => {
        expect(unsupportedKindMessage('ZX', 'XYZ/Q')).toMatch(/does not read this type/);
    });
});

describe('T3 selection screens', () => {
    test.each(['S', 'J', 'W'])('type %s carries the source-only note', t => {
        expect(selectionScreenNote(t)).toMatch(/ManageDynpro refuses selection screens/);
    });
    test.each(['N', 'I', 'M'])('type %s has none', t => { expect(selectionScreenNote(t)).toBe(''); });
});

describe('T4 inactive object owner', () => {
    test("someone else's object is flagged", () => {
        const n = ownerNote('SSCR', 'WOODY.C.C');
        expect(n).toMatch(/sits on WOODY\.C\.C's object/);
        expect(n).toMatch(/discard the inactive version/);
    });
    test('own object, or unknown owner: no note', () => {
        expect(ownerNote('SSCR', 'sscr')).toBe('');
        expect(ownerNote('SSCR', '')).toBe('');
    });
});
