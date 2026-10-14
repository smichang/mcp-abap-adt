import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { describeHttpErrorBody } from './httpError';
export { describeHttpErrorBody };
import { Agent } from 'https';
import { AxiosResponse } from 'axios';
import { getConfig, SapConfig } from '../index'; // getConfig needs to be exported from index.ts

export { McpError, ErrorCode, AxiosResponse };

/**
 * Strip HTML (e.g. a runtime dump's /summary sub-resource, or a Gateway error log
 * entry's atom:summary) down to readable plain text: drop <style>/<script> blocks,
 * turn block tags into newlines, unescape entities, and collapse runs of whitespace/
 * blank lines.
 */
export function stripHtml(htmlStr: string): string {
    let t = htmlStr
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(div|p|tr|h\d|table|li)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    t = t
        .replace(/&nbsp;/gi, ' ')
        .replace(/&ndash;/gi, '-')
        .replace(/&mdash;/gi, '--')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&');
    return t
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Parse SAP ADT error XML and extract the human-readable message.
 * Falls back to error type description when message is a raw message key (e.g. "I::000").
 */
export function parseAdtErrorXml(xmlData: string): string | null {
    try {
        if (typeof xmlData !== 'string' || !xmlData.trim().startsWith('<')) return null;
        // Lazy import to avoid circular dependency issues
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];

        // Extract error type id (e.g. ExceptionResourceNotFound)
        let errorType = '';
        const typeKey = Object.keys(root).find((k: string) => k.endsWith(':type') || k === 'type');
        if (typeKey) {
            const typeAttrs = root[typeKey]._attributes || {};
            errorType = (Object.values(typeAttrs)[0] as string) || '';
        }

        // Extract message text
        let msgText = '';
        for (const key of Object.keys(root)) {
            if (key.endsWith(':message') || key === 'message' ||
                key.endsWith(':localizedMessage') || key === 'localizedMessage') {
                const msgNode = root[key];
                if (msgNode?._text) {
                    msgText = (msgNode._text as string).trim();
                    break;
                }
            }
        }

        // If message looks like a raw key (e.g. "I::000"), use error type instead
        if (!msgText || /^[A-Z]::/.test(msgText)) {
            if (errorType === 'ExceptionResourceNotFound') return 'Object not found in the system';
            if (errorType) return errorType.replace(/Exception/, '').replace(/([A-Z])/g, ' $1').trim();
            return null;
        }

        return msgText;
    } catch (e) { /* ignore */ }
    return null;
}

export function return_response(response: AxiosResponse) {
    return {
        isError: false,
        content: [{
            type: 'text',
            text: response.data
        }]
    };
}
export function return_error(error: any) {
    return {
        isError: true,
        content: [{
            type: 'text',
            text: `Error: ${error instanceof AxiosError ? describeHttpErrorBody(error.response?.data ?? error.message)
                : error instanceof Error ? error.message
                    : String(error)}`
        }]
    };
}

let axiosInstance: AxiosInstance | null = null;
let httpsAgent: Agent | null = null;
export function createAxiosInstance() {
    if (!axiosInstance) {
        httpsAgent = new Agent({
            rejectUnauthorized: false, // Allow self-signed certificates
            // Reuse TLS connections across ADT calls (lock → PUT → unlock → activate etc.)
            keepAlive: true,
            maxSockets: Number(process.env.SAP_MAX_CONCURRENT_REQUESTS) || 6,
            // An idle kept-alive socket is closed after 15 s, so a short-lived process (tests,
            // scripts) is not held open by sockets nobody will reuse.
            timeout: 15000
        });
        axiosInstance = axios.create({ httpsAgent });
    }
    return axiosInstance;
}

// Cleanup function for tests
export function cleanup() {
    if (axiosInstance) {
        // Clear any interceptors
        const reqInterceptor = axiosInstance.interceptors.request.use((config) => config);
        const resInterceptor = axiosInstance.interceptors.response.use((response) => response);
        axiosInstance.interceptors.request.eject(reqInterceptor);
        axiosInstance.interceptors.response.eject(resInterceptor);
    }
    axiosInstance = null;
    // Close the kept-alive sockets, otherwise the process (e.g. a jest run) cannot exit.
    httpsAgent?.destroy();
    httpsAgent = null;
    config = undefined;
    csrfToken = null;
    cookies = null;
}

let config: SapConfig | undefined;
let csrfToken: string | null = null;
let cookies: string | null = null; // Variable to store cookies

export function appendCookie(extra: string) {
    if (!extra) return;
    cookies = cookies ? cookies + '; ' + extra : extra;
}
export function removeCookie(prefix: string) {
    if (!cookies) return;
    cookies = cookies.split('; ').filter(c => !c.startsWith(prefix)).join('; ') || null;
}

export async function getBaseUrl() {
    if (!config) {
        config = getConfig();
    }
    const { url } = config;
    try {
        const urlObj = new URL(url);
        const baseUrl = Buffer.from(`${urlObj.origin}`);
        return baseUrl;
    } catch (error) {
        const errorMessage = `Invalid URL in configuration: ${error instanceof Error ? error.message : error}`;
        throw new Error(errorMessage);
    }
}

export async function getAuthHeaders() {
    if (!config) {
        config = getConfig();
    }
    const { username, password, client, language } = config;
    const auth = Buffer.from(`${username}:${password}`).toString('base64'); // Create Basic Auth string
    return {
        'Authorization': `Basic ${auth}`, // Basic Authentication header
        'sap-client': client,              // SAP client header
        ...(language ? { 'sap-language': language } : {}) // optional logon language
    };
}

// Cookie attributes that appear in raw Set-Cookie strings and must not be mistaken for cookies.
const COOKIE_ATTRS = /^(path|secure|httponly|samesite|expires|max-age|domain)$/i;

// Merge Set-Cookie headers into a jar BY NAME (a new value replaces the old one; cookies the response
// does not mention are kept). Used when a refresh must not throw away a still-valid session cookie.
function mergeCookies(jar: string | null, setCookie: string[]): string {
    const map = new Map<string, string>();
    for (const piece of (jar ?? '').split('; ')) {
        const name = piece.split('=')[0];
        if (piece && name && !COOKIE_ATTRS.test(name)) map.set(name, piece);
    }
    for (const sc of setCookie) {
        const pair = sc.split(';')[0];
        const name = pair.split('=')[0];
        if (pair && name) map.set(name, pair);
    }
    return [...map.values()].join('; ');
}

// preserve=true: present the current jar (minus any stateful context) on the fetch and MERGE the
// answer into it — the server then keeps a valid security session, or replaces an expired one.
async function fetchCsrfToken(url: string, preserve = false): Promise<string> {
    try {
        const sendCookie = preserve && cookies
            ? cookies.split('; ').filter(c => !c.startsWith('sap-contextid')).join('; ')
            : '';
        const response = await createAxiosInstance()({
            method: 'GET',
            url,
            headers: {
                ...(await getAuthHeaders()),
                'x-csrf-token': 'fetch',
                ...(sendCookie ? { Cookie: sendCookie } : {})
            }
        });

        const token = response.headers['x-csrf-token'];
        if (!token) {
            throw new Error('No CSRF token in response headers');
        }

        // Extract and store cookies
        if (response.headers['set-cookie']) {
            cookies = preserve ? mergeCookies(cookies, response.headers['set-cookie']) : response.headers['set-cookie'].join('; ');
        }

        return token;
    } catch (error) {
        // Even if the request fails, try to get token from error response
        if (error instanceof AxiosError && error.response?.headers['x-csrf-token']) {
            const token = error.response.headers['x-csrf-token'];
            if (token) {
                 // Extract and store cookies from the error response as well
                if (error.response.headers['set-cookie']) {
                    cookies = error.response.headers['set-cookie'].join('; ');
                }
                return token;
            }
        }
        // If we couldn't get token from error response either, throw the original error
        throw new Error(`Failed to fetch CSRF token: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// ── Global concurrency gate ──────────────────────────────────────────────
// SAP's ICM throttles/refuses connections beyond ~5-10 simultaneous sockets, and
// Node's https.Agent defaults to maxSockets=Infinity — so a burst of parallel tool
// calls can flood ICM and stall. Every outbound SAP request funnels through this
// semaphore; excess requests queue instead of overwhelming the server.
// Tune with SAP_MAX_CONCURRENT_REQUESTS (default 6).
const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.SAP_MAX_CONCURRENT_REQUESTS) || 6);
let activeRequests = 0;
const requestWaitQueue: Array<() => void> = [];

function acquireRequestSlot(): Promise<void> {
    if (activeRequests < MAX_CONCURRENT_REQUESTS) {
        activeRequests++;
        return Promise.resolve();
    }
    // No free slot — wait. The permit is handed over directly on release (activeRequests unchanged).
    return new Promise<void>(resolve => requestWaitQueue.push(resolve));
}

function releaseRequestSlot(): void {
    const next = requestWaitQueue.shift();
    if (next) {
        next(); // transfer the permit to the next waiter without touching the count
    } else {
        activeRequests--;
    }
}

// quickSearch result cache. Name resolution runs before nearly every write/lock/activate/read
// and the same name is typically resolved several times per task. Only GETs of quickSearch URLs
// that returned at least one hit are cached (an empty result may just be search-index lag after a
// create — never pin it), and ANY non-GET request clears the whole cache, so a create/delete/
// rename through this process is never masked. Short TTL bounds staleness from other users'
// changes. Disable with SEARCH_CACHE_TTL_MS=0.
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS ?? 30000);
const searchCache = new Map<string, { at: number; response: any }>();

function isCacheableSearch(url: string, method: string): boolean {
    return SEARCH_CACHE_TTL_MS > 0 && method === 'GET' && url.includes('/informationsystem/search?operation=quickSearch');
}

export async function makeAdtRequest(url: string, method: string, timeout: number, data?: any, params?: any, headers?: Record<string, string>) {
    const cacheable = isCacheableSearch(url, method) && !params;
    if (cacheable) {
        const hit = searchCache.get(url);
        if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.response;
        searchCache.delete(url);
    } else if (method !== 'GET') {
        searchCache.clear();
    }
    await acquireRequestSlot();
    try {
        const response = await executeAdtRequest(url, method, timeout, data, params, headers);
        if (cacheable && typeof response.data === 'string' && /objectReference\b/.test(response.data)) {
            searchCache.set(url, { at: Date.now(), response });
        }
        return response;
    } finally {
        releaseRequestSlot();
    }
}

// Opening a stateful ADT session (a LOCK carrying X-sap-adt-sessiontype: stateful and no
// sap-contextid yet) with a stale security-session cookie / CSRF token gets a 403 — but that refused
// request has ALREADY created a stateful context on the server (it answers Set-Cookie: sap-contextid),
// which nothing ever uses or closes: an orphan SM04 session per refusal (reproduced 2026-10-14). The
// 403 retry below then works, so the damage was invisible. Refresh token + cookie with one cheap
// stateless GET first, so the session-opening request is valid the first time.
// SAP_STATEFUL_PREREFRESH=0 turns this off.
const STATEFUL_PREREFRESH = process.env.SAP_STATEFUL_PREREFRESH !== '0';

// A stateful ADT session can only be continued if the cookie jar carries the server's security-session
// cookie (SAP_SESSIONID_*). Measured 2026-10-14: when the CSRF fetch is answered WITHOUT it (only
// sap-XSRF_*, which the server does at times and which nothing we send changes), LOCK succeeds (200) but
// the very next request carrying its sap-contextid gets "400 Session not found" — every time (25 of 25),
// leaving the SM12 lock and an SM04 session behind. So in that state a stateful flow is doomed; refuse it
// BEFORE the LOCK (a few cheap stateless GETs, no lock, no session) instead of stranding both.
// SAP_REQUIRE_SESSION_COOKIE=0 turns the guard off (e.g. a system whose ICM never issues the cookie).
const REQUIRE_SESSION_COOKIE = process.env.SAP_REQUIRE_SESSION_COOKIE !== '0';
const SESSION_COOKIE_ATTEMPTS = 4;

async function executeAdtRequest(url: string, method: string, timeout: number, data?: any, params?: any, headers?: Record<string, string>) {
    if (STATEFUL_PREREFRESH && method !== 'GET' && headers?.['X-sap-adt-sessiontype'] === 'stateful' && !(cookies ?? '').includes('sap-contextid=')) {
        let haveSessionCookie = false;
        for (let attempt = 1; attempt <= SESSION_COOKIE_ATTEMPTS; attempt++) {
            try {
                csrfToken = await fetchCsrfToken(url, true);
            } catch (_e) {
                break; // not fatal — the normal path below fetches/retries as before
            }
            haveSessionCookie = (cookies ?? '').includes('SAP_SESSIONID_');
            if (haveSessionCookie || !REQUIRE_SESSION_COOKIE) break;
            await new Promise(r => setTimeout(r, 300 * attempt));
        }
        if (REQUIRE_SESSION_COOKIE && cookies && !haveSessionCookie) {
            throw new Error(
                `SAP did not issue a security-session cookie (SAP_SESSIONID_*) on ${SESSION_COOKIE_ATTEMPTS} attempts, so a stateful ADT session ` +
                `cannot be continued: the LOCK would succeed and the next request would fail with "400 Session not found", ` +
                `stranding an SM12 lock and an SM04 session. Nothing was locked. The server does this for windows of about 30 minutes ` +
                `(2026-10-14 10:01-10:31, while another client of this user held the security session); a process that already ` +
                `holds the cookie is not affected. Retry later, or reload /mcp once the window is over. ` +
                `Set SAP_REQUIRE_SESSION_COOKIE=0 to disable this guard.`);
        }
    }

    // Any mutating verb needs a CSRF token — not just POST/PUT. DELETE (transport/object
    // deletion) needs it too; SAP rejects it the same way with "CSRF token validation failed"
    // if the header is missing, which previously went unhandled here.
    const needsCsrf = method !== 'GET';
    if (needsCsrf && !csrfToken) {
        try {
            csrfToken = await fetchCsrfToken(url);
        } catch (error) {
            // Not every SICF service enforces CSRF protection (verified live: a custom
            // service can accept PUT/POST with no x-csrf-token header at all, unlike
            // /sap/bc/adt which always does). Proceed without the header rather than
            // aborting client-side — if the target actually does require one, SAP itself
            // returns "CSRF token validation failed", a clearer error than this fetch
            // failing silently on a target that never issues a token in the first place.
        }
    }

    const requestHeaders: Record<string, string> = {
        ...(await getAuthHeaders()),
        ...(headers || {})
    };

    if (needsCsrf && csrfToken) {
        requestHeaders['x-csrf-token'] = csrfToken;
    }

    // Add cookies if available
    if (cookies) {
        requestHeaders['Cookie'] = cookies;
    }

    const config: any = {
        method,
        url,
        headers: requestHeaders,
        timeout,
        params: params
    };

    // Include data in the request configuration if provided
    if (data) {
        config.data = data;
    }

    try {
        const response = await createAxiosInstance()(config);
        return response;
    } catch (error) {
        // If we get a 403 with "CSRF token validation failed", try to fetch a new token and retry.
        // fetchCsrfToken() also refreshes the module-level `cookies` (from the token GET's
        // Set-Cookie) — the retry must resend that same refreshed cookie, or SAP rejects the new
        // token as belonging to a different session than the one on the request.
        if (error instanceof AxiosError && error.response?.status === 403 &&
            error.response.data?.includes('CSRF')) {
            csrfToken = await fetchCsrfToken(url, true); // keep a still-valid session cookie; an expired one is replaced by the server
            config.headers['x-csrf-token'] = csrfToken;
            if (cookies) config.headers['Cookie'] = cookies;
            return await createAxiosInstance()(config);
        }
        // "Session not found" (HTTP 400): the ABAP session behind our cookies is gone (timed out,
        // ended in SM04, or the intermittent SAP-side fault). The cached cookies and CSRF token are
        // then dead weight that every later call would resend, so drop them. Retry once only when
        // the request was not part of a stateful sequence: with a `sap-contextid` on it the lock
        // lives in the dead session and silently re-running the step on a new one would be wrong.
        if (isSessionNotFound(error)) {
            const hadContext = /(^|; )sap-contextid=/.test(String(config.headers['Cookie'] || ''));
            csrfToken = null;
            cookies = null;
            if (hadContext) throw error;
            delete config.headers['Cookie'];
            delete config.headers['x-csrf-token'];
            if (needsCsrf) {
                try { csrfToken = await fetchCsrfToken(url); } catch (_e) { /* retry without it */ }
                if (csrfToken) config.headers['x-csrf-token'] = csrfToken;
            }
            if (cookies) config.headers['Cookie'] = cookies;
            return await createAxiosInstance()(config);
        }
        throw error;
    }
}

function isSessionNotFound(error: unknown): boolean {
    if (!(error instanceof AxiosError) || error.response?.status !== 400) return false;
    const body = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data ?? '');
    return /session not found/i.test(body);
}
