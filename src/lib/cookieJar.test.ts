import { mergeCookies, hasSessionCookie, Cooldown } from './cookieJar';

// Pure unit tests — no SAP connection needed.

describe('mergeCookies', () => {
    it('adds new cookies to an empty jar, keeping name=value only', () => {
        const jar = mergeCookies(null, ['SAP_SESSIONID_S4D_310=abc; path=/; secure; HttpOnly', 'sap-usercontext=sap-client=310; path=/']);
        expect(jar).toBe('SAP_SESSIONID_S4D_310=abc; sap-usercontext=sap-client=310');
    });
    it('replaces a cookie BY NAME and keeps the ones the response does not mention', () => {
        const jar = mergeCookies('SAP_SESSIONID_S4D_310=old; sap-XSRF_S4D_310=x; sap-contextid=ctx', ['SAP_SESSIONID_S4D_310=new; path=/']);
        expect(jar).toBe('SAP_SESSIONID_S4D_310=new; sap-XSRF_S4D_310=x; sap-contextid=ctx');
    });
    it('a response without the session cookie never drops a session cookie already held', () => {
        const jar = mergeCookies('SAP_SESSIONID_S4D_310=keep', ['sap-XSRF_S4D_310=t; path=/', 'sap-usercontext=sap-client=310']);
        expect(hasSessionCookie(jar)).toBe(true);
        expect(jar).toContain('SAP_SESSIONID_S4D_310=keep');
    });
    it('ignores skipped names (prefix) such as sap-contextid', () => {
        const jar = mergeCookies('SAP_SESSIONID_S4D_310=a', ['sap-contextid=ctx1; path=/', 'sap-contextid=0; expires=Thu, 01-Jan-1980 00:00:01 GMT'], ['sap-contextid']);
        expect(jar).toBe('SAP_SESSIONID_S4D_310=a');
    });
    it('does not treat attributes inside an old, raw jar as cookies', () => {
        const jar = mergeCookies('SAP_SESSIONID_S4D_310=a; path=/; secure; HttpOnly; SameSite=None', ['sap-XSRF_S4D_310=t']);
        expect(jar).toBe('SAP_SESSIONID_S4D_310=a; sap-XSRF_S4D_310=t');
    });
    it('keeps "=" inside values and de-duplicates repeated names', () => {
        const jar = mergeCookies(null, ['sap-usercontext=sap-client=310; path=/', 'sap-usercontext=sap-client=320; path=/']);
        expect(jar).toBe('sap-usercontext=sap-client=320');
    });
    it('handles an empty set-cookie list', () => {
        expect(mergeCookies('a=1', [])).toBe('a=1');
        expect(mergeCookies(null, [])).toBe('');
    });
});

describe('hasSessionCookie', () => {
    it('is true only for SAP_SESSIONID_*', () => {
        expect(hasSessionCookie('sap-usercontext=x; SAP_SESSIONID_S4D_310=abc')).toBe(true);
        expect(hasSessionCookie('sap-usercontext=x; sap-XSRF_S4D_310=abc')).toBe(false);
        expect(hasSessionCookie(null)).toBe(false);
        expect(hasSessionCookie('')).toBe(false);
    });
});

describe('Cooldown', () => {
    it('counts down and clears', () => {
        let t = 1000;
        const c = new Cooldown(() => t);
        expect(c.remainingMs()).toBe(0);
        c.trip(90_000);
        expect(c.remainingMs()).toBe(90_000);
        t += 30_000;
        expect(c.remainingMs()).toBe(60_000);
        t += 70_000;
        expect(c.remainingMs()).toBe(0);
        c.trip(10_000); c.clear();
        expect(c.remainingMs()).toBe(0);
    });
});
