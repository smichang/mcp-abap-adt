/**
 * Live integration tests for stateful-session hygiene. Needs a live SAP system.
 * Writes only to the disposable $TMP program ZMCP_SESS_PROBE (created in beforeAll, deleted in afterAll).
 * Run with: npm test -- --testPathPattern=session < /dev/null
 */
import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleDeleteObject } from './handlers/handleDeleteObject';
import { handleUnlockObject } from './handlers/handleUnlockObject';
import { handleGetCode } from './handlers/handleGetCode';
import * as utils from './lib/utils';

const PROG = 'ZMCP_SESS_PROBE';
const text = (r: any): string => r?.content?.[0]?.text ?? '';
// Fails with the tool's own message instead of a bare "expected false, received true"
function mustOk(r: any) { if (r?.isError) throw new Error('unexpected isError result: ' + text(r).slice(0, 400)); }

// Records the HTTP status of every LOCK request (status of the FIRST answer, before any retry).
function watchLocks() {
    const statuses: number[] = [];
    const ax = utils.createAxiosInstance();
    const id = ax.interceptors.response.use(
        r => { if (String(r.config.params?._action) === 'LOCK') statuses.push(r.status); return r; },
        e => { if (String(e.config?.params?._action) === 'LOCK') statuses.push(e.response?.status ?? 0); return Promise.reject(e); }
    );
    return { statuses, stop: () => ax.interceptors.response.eject(id) };
}

// An expired security session: the cookie jar holds a session cookie SAP no longer knows.
const expireSession = () => { utils.removeCookie('SAP_SESSIONID'); utils.appendCookie('SAP_SESSIONID_S4D_310=EXPIRED_FOR_TEST'); };

// When the server is answering CSRF fetches without a security-session cookie, every stateful flow is
// refused by the client guard (see utils.ts, SAP_REQUIRE_SESSION_COOKIE) — these tests cannot say
// anything useful then, so they skip with a warning instead of reporting a false failure.
let cookielessServer = false;
const skipIfCookieless = () => { if (cookielessServer) console.warn('  (skipped: SAP is not issuing SAP_SESSIONID right now)'); return cookielessServer; };

beforeAll(async () => {
    const r = await handleWriteProgram({ program_name: PROG, source_code: `REPORT ${PROG.toLowerCase()}.\n`, description: 'MCP session probe (disposable)', package_name: '$TMP' });
    if (r.isError && /did not issue a security-session cookie/.test(text(r))) { cookielessServer = true; return; }
    if (r.isError) throw new Error('fixture create failed: ' + text(r));
});

afterAll(async () => {
    try { await handleDeleteObject({ object_name: PROG, object_type: 'PROG' }); } catch { /* best effort */ }
    utils.cleanup();
    await new Promise(res => setTimeout(res, 100));
});

describe('opening a stateful session with an expired security session', () => {
    it('X1. UnlockObject: the LOCK is valid the first time (no refused 403 LOCK, so no orphan stateful context)', async () => {
        if (skipIfCookieless()) return;
        await handleUnlockObject({ object_name: PROG });          // make sure the jar exists
        const w = watchLocks();
        expireSession();
        const r = await handleUnlockObject({ object_name: PROG });
        w.stop();
        mustOk(r);
        expect(w.statuses).toEqual([200]);                         // not [403, 200]
    });

    it('X2. WriteProgram edits: same — one LOCK, 200', async () => {
        if (skipIfCookieless()) return;
        const w = watchLocks();
        expireSession();
        const r = await handleWriteProgram({ program_name: PROG, edits: [{ old_string: 'REPORT', new_string: 'REPORT' }].map(() => ({ old_string: `${PROG.toLowerCase()}.`, new_string: `${PROG.toLowerCase()}. " x` })), activate: false });
        w.stop();
        mustOk(r);
        expect(w.statuses).toEqual([200]);
    });

    it('X3. repeated expiries in a row never fail and never leave the object locked', async () => {
        if (skipIfCookieless()) return;
        for (let i = 0; i < 3; i++) {
            expireSession();
            const r = await handleUnlockObject({ object_name: PROG });
            mustOk(r);
        }
        const u = await handleUnlockObject({ object_name: PROG });
        expect(text(u)).not.toMatch(/currently editing/i);
    });
});


describe('a process that only reads still presents its session cookie (the burst-of-cookie-less-requests trigger)', () => {
    it('R1. after the first response every request carries SAP_SESSIONID; at most the first one is cookie-less', async () => {
        if (skipIfCookieless()) return;
        utils.cleanup();                                   // a fresh process: no jar at all
        const sent: boolean[] = [];                        // per request: did it carry a session cookie?
        let issued = false;                                // did the SERVER hand out a session cookie at any point?
        const ax = utils.createAxiosInstance();
        const reqId = ax.interceptors.request.use(cfg => { sent.push(String((cfg.headers as any)?.Cookie ?? '').includes('SAP_SESSIONID_')); return cfg; });
        const resId = ax.interceptors.response.use(r => { if ((r.headers['set-cookie'] ?? []).some((c: string) => c.startsWith('SAP_SESSIONID'))) issued = true; return r; });
        // a burst of parallel reads, then a few more
        await Promise.all(Array.from({ length: 8 }, () => handleGetCode({ resource: 'OBJECT', object_name: PROG })));
        for (let i = 0; i < 4; i++) await handleGetCode({ resource: 'OBJECT', object_name: PROG });
        ax.interceptors.request.eject(reqId); ax.interceptors.response.eject(resId);
        const cookieless = sent.filter(x => !x).length;
        console.log(`  ${sent.length} requests, ${cookieless} without a session cookie, server issued a cookie: ${issued}`);
        if (!issued) { console.warn('  (server issued no cookie in this run; nothing to present — claim not checkable now)'); return; }
        expect(cookieless).toBe(1);                        // the first request only — NOT one per read
    });
});
