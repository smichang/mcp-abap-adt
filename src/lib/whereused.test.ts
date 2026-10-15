/**
 * Offline test (no SAP) of the where-used timeout fallback: a synchronous call that runs into the 60 s
 * request timeout continues in the background with the long timeout and returns where the result will be
 * written, instead of failing (IF_MESSAGE has 47,828 usages and failed at exactly 60 s).
 * `./utils` is mocked because the real one imports the server entry, which needs SAP credentials.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const calls: { url: string; method: string; timeout: number }[] = [];
let postAttempts = 0;
let mockFast = false; // true = SAP answers within the synchronous window

jest.mock('./utils', () => {
    const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
    const { AxiosError } = require('axios');
    const SEARCH = '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_wu" adtcore:type="CLAS/OC" adtcore:name="ZCL_WU"/></adtcore:objectReferences>';
    const RESULT = '<usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences" resultDescription="0 usages"><usageReferences:referencedObjects/></usageReferences:usageReferenceResult>';
    return {
        McpError, ErrorCode,
        getBaseUrl: async () => 'http://sap',
        parseAdtErrorXml: () => '',
        return_error: (e: any) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }),
        makeAdtRequest: async (url: string, method: string, timeout: number) => {
            calls.push({ url, method, timeout });
            if (method === 'GET') return { data: SEARCH };
            postAttempts++;
            if (!mockFast && timeout <= 60000) {
                const e = new AxiosError(`timeout of ${timeout}ms exceeded`, 'ECONNABORTED');
                throw e;
            }
            return { data: RESULT };
        },
    };
});

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wu-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { calls.length = 0; postAttempts = 0; mockFast = false; jest.resetModules(); });

const load = () => require('../handlers/handleGetWhereUsed') as typeof import('../handlers/handleGetWhereUsed');
const ARGS = { object_name: 'ZCL_WU', object_type: 'CLAS' };

describe('where-used timeout fallback', () => {
    it('a synchronous call that times out is continued in the background, with the long timeout', async () => {
        const { handleGetWhereUsed } = load();
        const out = path.join(tmp, 'wu1.txt');
        const r: any = await handleGetWhereUsed({ ...ARGS, output_file: out });
        expect(r.isError).toBe(false);
        const t = r.content[0].text;
        expect(t).toMatch(/did not finish within 60 s/);
        expect(t).toContain('Continued automatically in the background');
        expect(t).toContain(out);
        // the background run issues a second POST with the long timeout and writes the result to the file
        await new Promise(res => setTimeout(res, 200));
        const posts = calls.filter(c => c.method === 'POST');
        expect(posts.map(p => p.timeout)).toEqual([60000, 600000]);
        expect(fs.readFileSync(out, 'utf8')).not.toMatch(/IN PROGRESS/);
    });

    it('an explicit background call uses the long timeout straight away (no 60 s attempt)', async () => {
        const { handleGetWhereUsed } = load();
        const out = path.join(tmp, 'wu2.txt');
        const r: any = await handleGetWhereUsed({ ...ARGS, background: true, output_file: out });
        expect(r.content[0].text).toContain('started');
        await new Promise(res => setTimeout(res, 200));
        expect(calls.filter(c => c.method === 'POST').map(p => p.timeout)).toEqual([600000]);
    });

    it('a call that answers in time is untouched: one POST, a normal result, no background note', async () => {
        mockFast = true;
        const { handleGetWhereUsed } = load();
        const r: any = await handleGetWhereUsed(ARGS);
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).not.toMatch(/background/i);
        expect(calls.filter(c => c.method === 'POST').map(p => p.timeout)).toEqual([60000]);
    });

    it('a non-timeout failure is still reported as an error (no silent background retry)', async () => {
        const { handleGetWhereUsed } = load();
        const utils = require('./utils');
        const orig = utils.makeAdtRequest;
        utils.makeAdtRequest = async (url: string, method: string) => {
            if (method === 'GET') return orig(url, method, 1);
            const { AxiosError } = require('axios');
            throw new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE');
        };
        try {
            const r: any = await handleGetWhereUsed(ARGS);
            expect(r.isError).toBe(true);
            expect(r.content[0].text).not.toMatch(/Continued automatically/);
        } finally { utils.makeAdtRequest = orig; }
    });
});
