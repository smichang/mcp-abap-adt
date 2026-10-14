// Pure helper (no imports, no SAP): turns SAP's ICM HTML error pages into a short message.
// SAP's ICM answers some failures with a full HTML page (inline base64 logo included — several
// thousand tokens of nothing). Reduce it to its message, and explain the one that matters most:
// "Session not found" always strands the object lock and the HTTP session behind it.
export function describeHttpErrorBody(data: unknown): string {
    const raw = String(data ?? '');
    if (!/^\s*<(!doctype|html)/i.test(raw)) return raw;
    const header = raw.match(/class="errorTextHeader"[^>]*>([^<]*)</i)?.[1]?.trim()
        || raw.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim()
        || raw.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (/session not found/i.test(header)) {
        return `${header} (HTTP error page from SAP's ICM). The stateful ADT session opened by LOCK was dropped by the server, ` +
            `so the follow-up request could not reach it: the object's SM12 lock and an SM04 HTTP session are STRANDED. ` +
            `Do not retry writes (each retry strands another pair). Clear them with UnlockObject(force=true) for your own lock ` +
            `(or sap_lock check/delete) and ManageSessions list/end (sessions older than 2 min), then reload /mcp before writing again.`;
    }
    return `${header} (HTTP error page from SAP)`;
}
