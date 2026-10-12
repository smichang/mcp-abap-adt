// In-memory, process-lifetime cache for query-tool "full result" lists.
//
// Several list tools (GetPackage, GetWhereUsed, GetTransport, GetRuntimeDumps,
// GetABAPTraces) already fetch the *entire* result set from SAP before slicing it down
// to max_results — the rest was previously discarded. This cache keeps that full list
// around briefly so a follow-up call with a different offset/max_results can page
// through it without a second SAP round-trip.
//
// Keyed by tool name + the params that determine the underlying SAP query — never the
// pagination window (offset/max_results) itself, so different windows over the same
// query share one cache entry. TTL default 3 minutes: short enough that stale transport/
// dump state is a minor annoyance rather than a correctness hazard (e.g. a transport
// released moments ago still showing as modifiable). Override with QUERY_CACHE_TTL_MS.

interface CacheEntry {
    data: unknown[];
    expiresAt: number;
}

const store = new Map<string, CacheEntry>();
const TTL_MS = Math.max(1000, Number(process.env.QUERY_CACHE_TTL_MS) || 3 * 60 * 1000);

export function cacheKey(tool: string, parts: Record<string, string | number | undefined>): string {
    // JSON-encode the sorted [key, value] pairs rather than hand-joining "k=v&k=v" — a
    // delimiter-joined string is ambiguous if a value itself contains '=' or '&' (two
    // different queries could serialize to the same string); JSON.stringify is not.
    const sorted = Object.keys(parts).sort().map(k => [k, parts[k] ?? '']);
    return `${tool}::${JSON.stringify(sorted)}`;
}

/** Returns the cached list, or undefined on a miss/expiry (expired entries are evicted). */
export function getCachedList<T>(key: string): T[] | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
    }
    return entry.data as T[];
}

export function setCachedList<T>(key: string, data: T[]): void {
    store.set(key, { data, expiresAt: Date.now() + TTL_MS });
}
