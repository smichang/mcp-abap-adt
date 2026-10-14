// Pure cookie-jar helpers (no imports, no SAP) — unit-tested in cookieJar.test.ts.
//
// Why this matters (measured 2026-10-14): a request that carries NO session cookie makes the server
// create a security session. When too many of those arrive for one user/IP in a short time the server
// stops issuing SAP_SESSIONID (it answers with sap-XSRF_* only) for ~100 s after the last excess
// request, and a stateful ADT session opened in that window dies on its next request
// ("400 Session not found", lock stranded). Presenting a cookie costs nothing (117 requests presented
// in 3 min did not disturb a cookie-less observer). So: keep the jar fresh from EVERY response and
// present it on every request.

// Cookie attributes that appear in raw Set-Cookie strings and must not be mistaken for cookies.
const COOKIE_ATTRS = /^(path|secure|httponly|samesite|expires|max-age|domain)$/i;

/** Merge Set-Cookie header values into a jar BY NAME: a new value replaces the old one, cookies the
 *  response does not mention are kept. `skip` names (prefix match) are ignored, e.g. 'sap-contextid'. */
export function mergeCookies(jar: string | null, setCookie: string[], skip: string[] = []): string {
    const map = new Map<string, string>();
    for (const piece of (jar ?? '').split('; ')) {
        const name = piece.split('=')[0];
        if (piece && name && !COOKIE_ATTRS.test(name)) map.set(name, piece);
    }
    for (const sc of setCookie) {
        const pair = sc.split(';')[0];
        const name = pair.split('=')[0];
        if (!pair || !name || skip.some(s => name.startsWith(s))) continue;
        map.set(name, pair);
    }
    return [...map.values()].join('; ');
}

export const hasSessionCookie = (jar: string | null): boolean => (jar ?? '').includes('SAP_SESSIONID_');

/** A refusal window: after `trip(ms)`, `remainingMs()` counts down; used so a process that found the
 *  server NOT issuing a session cookie stops sending requests (each one extends the server's throttle). */
export class Cooldown {
    private until = 0;
    constructor(private now: () => number = Date.now) {}
    trip(ms: number): void { this.until = this.now() + ms; }
    clear(): void { this.until = 0; }
    remainingMs(): number { return Math.max(0, this.until - this.now()); }
}
