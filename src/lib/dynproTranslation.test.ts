/**
 * Offline test (no SAP) of the Dynpro translation tools' argument handling and rendering. `./utils` is
 * mocked because the real one imports the server entry, which needs SAP credentials.
 */
const calls: { url: string; method: string; body?: any; params?: any }[] = [];
let reply: any = '';

jest.mock('./utils', () => {
    const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
    return {
        McpError, ErrorCode,
        getBaseUrl: async () => 'http://sap',
        return_error: (e: any) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }),
        makeAdtRequest: async (url: string, method: string, _t: number, body?: any, params?: any) => {
            calls.push({ url, method, body, params });
            return { data: reply };
        },
    };
});

import { normalizeTexts, readTranslation, writeTranslation, renderListing } from '../handlers/dynproTranslation';

beforeEach(() => { calls.length = 0; reply = ''; });

describe('normalizeTexts', () => {
    it('accepts an object map, an array and a JSON string', () => {
        expect(normalizeTexts({ A: '甲', B: '乙' })).toEqual([{ element: 'A', text: '甲' }, { element: 'B', text: '乙' }]);
        expect(normalizeTexts([{ element: 'A', text: 'x' }])).toEqual([{ element: 'A', text: 'x' }]);
        expect(normalizeTexts('{"A":"x"}')).toEqual([{ element: 'A', text: 'x' }]);
    });
    it('refuses missing, empty, duplicate and oversized input', () => {
        expect(() => normalizeTexts(undefined)).toThrow(/translations is required/);
        expect(() => normalizeTexts({})).toThrow(/empty/);
        expect(() => normalizeTexts({ A: '  ' })).toThrow(/deleting a translation is not supported/);
        expect(() => normalizeTexts([{ element: 'A', text: 'x' }, { element: 'a', text: 'y' }])).toThrow(/twice/);
        expect(() => normalizeTexts('{bad')).toThrow(/not valid JSON/);
        expect(() => normalizeTexts(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`E${i}`, 'x'])))).toThrow(/max 200/);
    });
});

describe('writeTranslation / readTranslation', () => {
    it('POSTs {texts} to zmcp/dynpro_transl with the language, nothing before validation passes', async () => {
        reply = 'Wrote 1 text(s)';
        const r = await writeTranslation('ZPROG', '0100', 'M', { EL: '文' });
        expect(r.isError).toBe(false);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://sap/zmcp/dynpro_transl');
        expect(calls[0].method).toBe('POST');
        expect(calls[0].params).toEqual({ program: 'ZPROG', dynnr: '0100', language: 'M' });
        expect(JSON.parse(calls[0].body)).toEqual({ texts: [{ element: 'EL', text: '文' }] });
    });
    it('makes no SAP call for a missing language or bad texts', async () => {
        await expect(writeTranslation('ZPROG', '0100', '', { EL: 'x' })).rejects.toThrow(/language is required/);
        await expect(writeTranslation('ZPROG', '0100', 'zhTWx', { EL: 'x' })).rejects.toThrow(/not valid/);
        await expect(writeTranslation('ZPROG', '0100', 'M', {})).rejects.toThrow(/empty/);
        expect(calls).toHaveLength(0);
    });
    it('renders the listing and flags missing target texts', async () => {
        reply = JSON.stringify({ program: 'ZPROG', dynnr: '0100', source_language: 'E', target_language: 'M', target_iso: 'zhTW',
            elements: [{ element: 'A', source_text: 'Cycle', target_text: '週期', max_length: 20 }, { element: 'B', source_text: 'Segment', target_text: '', max_length: 20 }] });
        const text = (await readTranslation('ZPROG', '0100', 'M')).content[0].text;
        expect(text).toContain('2 element(s), 1 without a M text');
        expect(text).toContain('(missing)');
        expect(calls[0].method).toBe('GET');
    });
    it('renderListing copes with an empty element list', () => {
        expect(renderListing({ program: 'P', dynnr: '0100', source_language: 'E', target_language: 'M', target_iso: 'zhTW', elements: [] })).toContain('0 element(s)');
    });
});
