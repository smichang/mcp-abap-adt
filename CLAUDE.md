# CLAUDE.md

## Commands

```bash
npm run build        # compile TypeScript → dist/
npm test             # run integration tests (requires live SAP system via .env)
npm run check:skill  # keep the agent skill within its size budget
npm run start        # run server (stdio MCP mode)
npm run dev          # run with MCP Inspector at localhost:5173
```

After any code change, run `npm run build`, then reload the MCP server in Claude Code with `/mcp`.

---

## Adding a New Tool — 3-Step Pattern

Every tool = one handler file + two edits to `src/index.ts`.

1. **`src/handlers/handleMyTool.ts`** — follow the [error-handling convention](#error-handling-convention-every-handler): top-level try/catch → `return_error`, `McpError` for arg validation, `parseAdtErrorXml` on SAP failures. Template off `handleUnlockObject.ts` (simple lock/unlock) or `handleWriteProgram.ts` (full lock → PUT → unlock → activate).
2. **Import** in `src/index.ts`: `import { handleMyTool } from './handlers/handleMyTool';`
3. **Register** — add to the `ListToolsRequestSchema` tools array (`name`/`description`/`inputSchema`) and to the `CallToolRequestSchema` switch: `case 'MyTool': return await handleMyTool(request.params.arguments);`

**Exception — new read-only getters join a dispatcher instead of registering their own tool.** The 12 original `Get*` getters are consolidated into `GetCode`/`GetDiagnostics`/`GetMeta`, keyed by a `resource` enum (see the table in the next section). A new getter should add a `resource` case to whichever dispatcher fits its theme (code/version/source-adjacent → `GetCode`; runtime error/perf → `GetDiagnostics`; static object/system metadata → `GetMeta`) rather than register a 14th top-level tool. Only writes/actions keep their own top-level tool — except the `Manage*` tools for SAP-side objects with their own handler (auth object, message class, package, transaction), which are `resource`s of the `ManageObject` dispatcher (`handleManageObject.ts` + `manageObjectSchema.ts`).

**Do NOT default new SAP-side capability to the shared ABAP dispatcher (`ZCL_MCP_DISPATCH`, SICF node `default_host/zmcp/dispatch`).** That dispatcher is for tiny, reusable diagnostic/bootstrap actions only (`ping`, `echo_upper`, `create_sicf_node`, `delete_sicf_node`). Every feature-sized ADT gap so far (`ManageObject AUTH_OBJECT`'s SU21 wrapper, `ManageTransport`'s `move_object`/`merge`/`remove_object`) got its **own standalone SICF endpoint** instead (own handler class implementing `IF_HTTP_EXTENSION`, own SICF node, `ZCL_HTTP_MCP_AUTH_OBJECT`'s CSRF/Basic-Auth plumbing copied) — see those tools' sections in `docs/TOOL_INTERNALS.md` and `docs/ADT_ENDPOINTS.md` §11. Reach for the shared dispatcher only for something as small as its existing four actions; anything with its own request/response shape, error taxonomy, or more than a couple params gets its own endpoint.

**Always consider paging (`offset`/`limit`) for any tool whose result can grow unbounded** — package listings, transport object lists, where-used scans, DataPreview rows, ATC/AUnit findings. A `tools/call` response round-trips through the calling LLM's context, so an unpaged tool that's small today can blow up against bigger live data tomorrow.
- List tools that fetch SAP's full result set before slicing → reuse [Query Result Caching](#query-result-caching-srclibquerycachets--offset-paging-without-repeat-sap-calls). Already wired into `GetPackage`, `GetWhereUsed`, `GetTransport`/`GetRuntimeDumps`/`GetABAPTraces` (list modes).
- Tools that can structurally exceed a client's short `tools/call` timeout → reuse [Background mode](#background-mode-backgroundtrue--output_file--shared-across-tools).
- A genuinely new shape → add explicit `offset`/`limit` to the schema and flag truncation in the response text (`(N total, showing M from offset O)`) rather than silently capping/unbounding.

---

## Get* Tool Consolidation

The original 12 `Get*` read-only tools are reachable only through three dispatcher tools, each with a required `resource` param plus that resource's own fields (unchanged schema). `SearchObject`/`DataPreview` stayed standalone.

| Dispatcher | `resource` | Original tool | Handler |
|---|---|---|---|
| `GetCode` | `OBJECT` / `VERSION` / `ENHANCEMENTS` / `WHEREUSED` / `DYNPRO`* | `GetObject` / `GetObjectVersion` / `GetEnhancements` / `GetWhereUsed` / — | `handleGetObject.ts` / `handleGetObjectVersion.ts` / `handleGetEnhancements.ts` / `handleGetWhereUsed.ts` / `handleGetDynpro.ts` |
| `GetDiagnostics` | `DUMP` / `TRACE` / `GW_ERRORLOG`* | `GetRuntimeDumps` / `GetABAPTraces` / — | `handleGetRuntimeDumps.ts` / `handleGetABAPTraces.ts` / `handleGetGatewayErrorLog.ts` |
| `GetMeta` | `PACKAGE` / `TYPEINFO` / `TRANSACTION` / `TRANSPORT` / `MESSAGE_CLASS` / `DDIC` / `INACTIVE_OBJECTS`* | `GetPackage` / `GetTypeInfo` / `GetTransaction` / `GetTransport` / `GetMessageClass` / `GetDDICObject` / — | `handleGetPackage.ts` / ... / `handleGetInactiveObjects.ts` |

\* not one of the original 12 — added directly under the dispatcher.

The dispatcher handlers (`handleGetCode.ts`, `handleGetDiagnostics.ts`, `handleGetMeta.ts`) just strip `resource` and forward to the original handler function unchanged. An unrecognized `resource` throws `McpError(InvalidParams, ...)`. The rest of this document refers to the original handler names when describing internal behavior — those remain accurate; only the externally-called tool name changed.

## Key Utilities (`src/lib/utils.ts`)

| Export | Purpose |
|--------|---------|
| `getBaseUrl()` | SAP base URL as Buffer — safe in template literals |
| `makeAdtRequest(url, method, timeout, data?, params?, headers?)` | Authenticated SAP call; handles CSRF for any verb `!== 'GET'`. On a 403 CSRF failure, refetches token *and* session cookie together before retrying. On `400 Session not found` it drops the stored cookies and CSRF token and retries once, except when the request carried a `sap-contextid` (a stateful sequence's lock lived in the dead session, so it fails instead). All calls funnel through a global concurrency semaphore (default 6, env `SAP_MAX_CONCURRENT_REQUESTS`). Never call the SAP HTTP layer outside this function. |
| quickSearch cache (inside `makeAdtRequest`) | GETs of `…/informationsystem/search?operation=quickSearch` that returned ≥1 `objectReference` are cached 30 s (`SEARCH_CACHE_TTL_MS`, `0` = off). Empty results are never cached (search-index lag after a create); **any non-GET request clears the whole cache**. Other users' changes can show up to 30 s late. |
| `parseAdtErrorXml(xmlString)` | Human-readable message from SAP ADT error XML |
| `return_response(axiosResponse)` | Wraps `{ isError: false, content: [{ type:'text', text }] }` |
| `return_error(error)` | Wraps `{ isError: true, content: [...] }`; for `AxiosError` uses `error.response?.data ?? error.message` |
| `createAxiosInstance()` | Singleton axios, `rejectUnauthorized: false` (self-signed SAP certs), HTTPS `keepAlive: true` with `maxSockets` = `SAP_MAX_CONCURRENT_REQUESTS` so lock → PUT → unlock → activate reuse one TLS connection (stateful sessions ride the `sap-contextid` cookie, not the socket) |
| `getAuthHeaders()` | `{ Authorization, 'sap-client', 'sap-language'? }` |
| `appendCookie(extra)` / `removeCookie(prefix)` | Manage global session cookies (e.g. `sap-contextid`). **Every handler opening a stateful lock session calls `removeCookie('sap-contextid')` immediately before its `LOCK` POST**, not just after unlock. |

**Why `removeCookie` runs before every `LOCK`:** `cookies` is module-level for the process lifetime. If a stateful sequence (`WriteProgram`, `ActivateObjects rfc_enabled`, `ManageTransport assign_object`, `UnlockObject`) is ever interrupted before its own cleanup, a leftover `sap-contextid` gets resent on every later request — including unrelated ones — and the next `LOCK` on that object silently rides the dead session, producing a self-conflict ("User X is currently editing" where X is our own `SAP_USERNAME`) even though the object is free. Fix: purge the cookie before every `LOCK`, not just after unlock. If this symptom recurs, `/mcp` reload resets the module-level state as a stopgap.

### Error-handling convention (every handler)

1. Top-level `try { … } catch (error) { return return_error(error); }`.
2. Validate required args with `throw new McpError(ErrorCode.InvalidParams, '…')`.
3. On SAP HTTP failure, branch on `AxiosError` and run `parseAdtErrorXml` before falling back to `return_error`.
4. **HTTP 200 ≠ success.** Activation/transport-release return 200 with the real status in the XML body (`chkl:messages type="E"`, `chkrun:status` matching `abort|error|fail`) — inspect it and set `isError` accordingly.

---

## Query Result Caching (`src/lib/queryCache.ts`) — offset paging without repeat SAP calls

Several list tools fetch SAP's **entire** result set before slicing to the requested window. `queryCache.ts` keeps that full list in memory for a few minutes so a follow-up call with a different `offset` pages through it without a second SAP round-trip.

**Wired in:** `GetPackage`, `GetWhereUsed`, `GetTransport`/`GetRuntimeDumps`/`GetABAPTraces` (list modes). Not applicable to single-object getters or `SearchObject` (no stable "full set" to cache).

```typescript
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';

const key = cacheKey('MyTool', { the_params_that_define_the_query /* never offset/limit */ });
let full = getCachedList<MyItemType>(key);
if (!full) { full = /* fetch + parse entire list */; setCachedList(key, full); }
const windowed = full.slice(offset, offset + limit);
```

- **Key = tool name + query-defining params only**, never the pagination window.
- **TTL default 3 min** (`QUERY_CACHE_TTL_MS`), lazily evicted on next read. In-memory, process-lifetime only, no cross-tool invalidation (short TTL is the only staleness guard).
- Cache a single non-array value by wrapping in a one-element array (see `handleGetTransport.ts`).
- Every handler appends `[cached]` to its header line on a cache hit.
- Window **after** grouping/sorting, not before — split a group across pages correctly rather than dropping/duplicating rows.
- Keep the render step inside its own try/catch falling back to raw XML — hoist `let xmlData = ''` above the cache-hit/miss branch so the render catch can use it.

---

## Background mode (`background=true` + `output_file`) — shared across tools

`src/lib/background.ts` (`maybeBackground`) wraps a handler whose core resolves to the standard single-text-block result:
```typescript
export async function handleGetWhereUsed(args: any) {
    return maybeBackground(args, `Where-used for ${name}`, `whereused-${name}`, () => getWhereUsedCore(args));
}
```
Default: `await core()`, persist to `output_file` if given. `background:true`: writes an `IN PROGRESS` placeholder, launches `core()` unawaited, returns instantly (~15ms) with a `"started → read <path>"` response; the file is updated with the result (or error) when it settles. Exists because some MCP clients enforce short `tools/call` timeouts regardless of server-side timeout settings.

**Opted in:** `RunATCCheck`, `RunUnitTest`, `GetEnhancements` (`scan_all=true`), `GetWhereUsed`, `GetPackage`, `DataPreview`. Single-GET getters return in 1–2s and don't self-wrap, but `GetCode`/`GetMeta` (which spread `backgroundSchemaProps` into their whole schema) wrap every resource that doesn't self-wrap — so `output_file`/`background` are honored there too. `GetDiagnostics` doesn't advertise the props, so its resources stay unwrapped. `WriteProgram`/`ActivateObjects` deliberately don't opt in — a fire-and-forget "started" reply would hide whether a write/activation actually succeeded.

---

## Discovering & Verifying ADT Endpoints

SAP ADT is under-documented: singular-vs-plural paths, silently-ignored query params, relative HATEOAS hrefs, and "200 but actually failed" responses are common traps. **Probe live with `curl` before shipping an endpoint.**

```bash
# 1. Auth from .env, never echo the password
set -a; . ./.env 2>/dev/null; set +a
auth=(-k -s --user "$SAP_USERNAME:$SAP_PASSWORD" -H "sap-client: $SAP_CLIENT" -H "sap-language: $SAP_LANGUAGE")
curl "${auth[@]}" "$SAP_URL/sap/bc/adt/<path>" -o /tmp/out.xml

# 2. Compare candidate paths by status/timing/size
hdr=(-k -s -o /dev/null -w "%{http_code}  %{time_total}s  %{size_download}b" "${auth[@]:1}")
curl "${hdr[@]}" "$SAP_URL/sap/bc/adt/runtime/dump/$ID"

# 3. Detect silently-ignored query params via md5/diff (identical body = ignored param)
curl "${auth[@]}" "$URL?version=A" -o /tmp/a; curl "${auth[@]}" "$URL?version=B" -o /tmp/b
md5sum /tmp/a /tmp/b

# 4. Inspect structure for the real link/id (don't hand-construct deep URLs)
python3 -c "import re; x=open('/tmp/out.xml',encoding='utf-8',errors='replace').read(); print(sorted(set(re.findall(r'<([A-Za-z0-9:]+)[ >/]', x))))"
```
Then cross-check against the `abap-adt-api` reference (`ADT_ENDPOINTS.md`) for the blueprint shape.

**Never probe with `X-sap-adt-sessiontype: stateful` unless a LOCK/UNLOCK pair will close it.** Every stateful request opens an ABAP session on the instance (SM04), and a later stateless request carrying its `sap-contextid` does **not** end it — it lingers until the HTTP session timeout. Only the ADT UNLOCK ends it (SAP answers `Set-Cookie: sap-contextid=0; expires=1980…` — that's a *delete* cookie, not a new session; sending `0` back as a stateful request opens a fresh one). Ad-hoc stateful liveness probes and force-killed test runs leave sessions behind. Probe stateless, or ask Basis to watch SM04. **HTTP 200 ≠ success, identical bytes ≠ honored param, and the canonical sub-resource URL lives in the response body, not your imagination.**

---

## Stateful Operation Gate (`src/lib/writeLock.ts`)

One non-reentrant gate for **every handler that opens an ADT stateful `LOCK` session**: `WriteProgram`, `ManageDDIC`, `ManageObject` (`MESSAGE_CLASS`, `PACKAGE update`), `ManageTransport(action=assign_object)`, `ActivateObjects(rfc_enabled)`, `UnlockObject`, `DeleteObject`. At most one of them runs at a time per SAP system (`SAP_URL|SAP_CLIENT`) on this machine — whether the competing call comes from another MCP connection (each `StdioServerTransport` connection is its own OS process) or from the **same** process (the shared module-level `sap-contextid` cookie in `utils.ts` makes two overlapping lock flows corrupt each other's session). A blocked call is refused immediately with the holder's label and token, never queued.

**Lock token = the real `sap-contextid`.** A file-based mutex (`fs.writeFileSync(..., { flag: 'wx' })`) keyed by `sha1(SAP_URL|SAP_CLIENT)` under `os.tmpdir()` (`mcp-abap-adt-writelock-<key>.json`):

1. `acquireStatefulOperationLock(label)` — first thing in the handler's wrapper; atomically creates `{ pid, token: 'pending:<pid>', label, acquiredAt }`. Held by any live pid (including our own) → `{ ok: false, message }`.
2. `refreshStatefulOperationToken(sapContextId)` — overwrites `token` once the real LOCK POST succeeds.
3. `releaseStatefulOperationLock()` in the wrapper's `finally` — deletes the file only if its `pid` still matches this process.

**Crash recovery, two layers:** `isProcessAlive(pid)` via `process.kill(pid, 0)` takes over immediately if the holder's pid is gone (`ESRCH`); `EPERM`/inconclusive falls through to a **2-minute (`STALE_MS`) time-based takeover** regardless. Either path only changes local file state — SAP's own enqueue lock still correctly rejects a genuinely-live crashed session.

**Fails open:** any filesystem error other than `EEXIST` on create (permissions, read-only tmp) proceeds without locking.

**Windows note:** `os.tmpdir()` is per-user there, so the gate only sees connections on the same machine *and* same OS login. SAP's own per-object enqueue remains the authority across machines, logins, SAP GUI and Eclipse.

**Not gated:** the stateless standalone-endpoint writers (`TextPoolLang`, `ManageObject AUTH_OBJECT`/`TRANSACTION`, `ManageDynpro`, `ManageSicfNode`, `UnlockObject force=true` → `lock_admin`, `ManageSessions` → `session_admin`) — one HTTP call each, no shared session. A new handler that takes an ADT `LOCK` must wrap its core in this gate (template: `handleManageMessageClass`'s exported wrapper) **and** call `removeCookie('sap-contextid')` right before its `LOCK` POST (see Key Utilities).

---

## Per-tool internals — `docs/TOOL_INTERNALS.md`

That file is **reference, not rules** — read the section of the tool you are about to change, not the whole file. It holds the live-verified endpoints, request shapes and traps for: `GetCode DYNPRO` and `GetMeta INACTIVE_OBJECTS`; the ADT endpoint, VIT URI, HATEOAS, Atom feed, XML and DataPreview patterns; `GetTransport`/`ManageTransport` (create, rename, release, `assign_object`, `move_object`/`merge`/`remove_object`); `ManageAuthObject`; `ManageDDIC`; `WriteProgram`; `ManageDynpro`; `ManageMessageClass`; `UnlockObject`; `ManageSessions`; `DeleteObject`; `ActivateObjects`; `RunUnitTest`; `RunATCCheck`; text elements; `GetEnhancements`; `GetDiagnostics` dump and gateway log; and the opt-in secrets keystore (setup, rotation, a second SAP system).

When a change teaches something durable, add it to that file (or the agent skill), not here — keep this file to rules every session needs.

## Architecture

```
src/
  index.ts            # MCP server: ListToolsRequestSchema + CallToolRequestSchema switch
  lib/utils.ts        # HTTP client, auth, CSRF, error parsing
  lib/queryCache.ts   # In-memory TTL cache for list-tool full result sets (offset paging)
  lib/background.ts   # background=true / output_file wrapper for slow read tools
  lib/secretStore.ts  # process env / encrypted keystore / .env resolution
  handlers/           # One file per tool — pure async functions
dist/                 # Compiled output (gitignored; used by MCP clients)
scripts/setup-secrets.js  # Server-side .env -> keystore conversion / rotation
docs/ADT_ENDPOINTS.md      # SAP ADT REST API reference
docs/TOOL_INTERNALS.md     # per-tool endpoints, request shapes and traps
```

`src/index.ts` exports `mcp_abap_adt_server` and `getConfig()`/`SapConfig`. Config resolves (process env / keystore / `.env`, in that order) for `SAP_URL`, `SAP_USERNAME`, `SAP_PASSWORD`, `SAP_CLIENT` (required), `SAP_LANGUAGE` (optional — adds `sap-language` header; honored for DDIC/message-class text, not text-elements). Restart/`/mcp` reload after changing any of these.

`SAP_MAX_CONCURRENT_REQUESTS` (default 6) caps `makeAdtRequest`'s concurrency semaphore. `SEARCH_CACHE_TTL_MS` (default 30000, `0` = off) controls the quickSearch cache in `makeAdtRequest`. `QUERY_CACHE_TTL_MS` (default 180000) controls `queryCache.ts`'s TTL.

Tests in `src/index.test.ts` are live integration tests against the real SAP system, needing a valid `.env`.

**Tests must never touch other people's objects.** Write/lock tests use dedicated anchors only: `$TMP` objects (`ZMCP_*`), and for anything that needs a transportable object, an intentionally empty class (default `ZCL_MCP_TRANSPORT_E2E` in package `ZMCP`; override with `MCP_TEST_ANCHOR_CLASS` / `MCP_TEST_ANCHOR_PACKAGE`) that you create once. `complex.test.ts`'s transport lifecycle creates a transport for that anchor and **deletes** it at the end; releasing it is opt-in (`MCP_TEST_RELEASE=1 npm test`), because a released transport can't be deleted.

