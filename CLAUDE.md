# CLAUDE.md

## Commands

```bash
npm run build        # compile TypeScript → dist/
npm test             # run integration tests (requires live SAP system via .env)
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

**Exception — new read-only getters join a dispatcher instead of registering their own tool.** The 12 original `Get*` getters are consolidated into `GetCode`/`GetDiagnostics`/`GetMeta`, keyed by a `resource` enum (see table below). A new getter should add a `resource` case to whichever dispatcher fits its theme (code/version/source-adjacent → `GetCode`; runtime error/perf → `GetDiagnostics`; static object/system metadata → `GetMeta`) rather than register a 14th top-level tool. Only writes/actions keep their own top-level tool.

**Do NOT default new SAP-side capability to the shared ABAP dispatcher (`ZCL_MCP_DISPATCH`, SICF node `default_host/zmcp/dispatch`).** That dispatcher is for tiny, reusable diagnostic/bootstrap actions only (`ping`, `echo_upper`, `create_sicf_node`, `delete_sicf_node`). Every feature-sized ADT gap so far (`ManageAuthObject`'s SU21 wrapper, `ManageTransport`'s `move_object`/`merge`/`remove_object`) got its **own standalone SICF endpoint** instead (own handler class implementing `IF_HTTP_EXTENSION`, own SICF node, `ZCL_HTTP_MCP_AUTH_OBJECT`'s CSRF/Basic-Auth plumbing copied) — see those tools' sections below and `ADT_ENDPOINTS.md` §11. Reach for the shared dispatcher only for something as small as its existing four actions; anything with its own request/response shape, error taxonomy, or more than a couple params gets its own endpoint.

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

### GetMeta `INACTIVE_OBJECTS` — `handleGetInactiveObjects.ts`

```
GET /sap/bc/adt/activation/inactiveobjects
```
Lists objects the connection's own SAP user has **inactive** (written but not activated) — same set as SAP GUI/Eclipse's "Activate" dialog. No required params; `?user=` is silently ignored (always scoped to the connection's own user).

```xml
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">
  <ioc:entry>
    <ioc:object ioc:user="MCP" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/programs/programs/ztest..." adtcore:type="PROG/P" adtcore:name="ZTEST..." xmlns:adtcore="http://www.sap.com/adt/core"/>
    </ioc:object>
    <ioc:transport/>
  </ioc:entry>
</ioc:inactiveObjects>
```
`ioc:deleted="true"` marks a pending deletion. The handler renders whatever `ioc:transport` attributes it finds generically rather than assuming a shape (unverified populated case). Useful before a mass-activate call to see what's queued.

### GetCode `DYNPRO` — `handleGetDynpro.ts`

Classic SAP GUI screens. **Standard ADT has no screen content contract** — `objectstructure` lists screens (`PROG/PS`) and their VIT URI returns basic properties only; elements and flow logic sit compressed in `DYNPSOURCE`. So this calls the standalone SICF endpoint `default_host/zmcp/dynpro` (`ZCL_HTTP_MCP_DYNPRO` → `ZCL_MCP_DYNPRO` → `RPY_DYNPRO_READ`, own `ZCX_MCP_DYNPRO`). `object_name` = owning program (`SAPL<group>` for a function group). No `dynnr` → screen list (paged + `queryCache`); `dynnr` → readable summary; `raw=true` → full JSON (`header`/`containers`/`fields_to_containers`/`flow_logic`/`params`, lower-case `RPY_*` names — the shape `RPY_DYNPRO_INSERT` takes).

Screen type codes (`RPY_DYHEAD-TYPE`): `N` normal (stored blank in `D020S`), `I` subscreen, `M` modal dialog, `S` selection screen, `J` selection screen `AS SUBSCREEN`, `W` selection screen as modal dialog. `J` and `N` aren't in domain `SCRPTYP` — don't infer types from the domain. `raw=true` + `output_file` writes the JSON **only** to the file and replies with path + size (handled in `handleGetCode.ts`, not the shared `maybeBackground`, which would also return it inline).

Writes go through `ManageDynpro` (below).

---

## Key Utilities (`src/lib/utils.ts`)

| Export | Purpose |
|--------|---------|
| `getBaseUrl()` | SAP base URL as Buffer — safe in template literals |
| `makeAdtRequest(url, method, timeout, data?, params?, headers?)` | Authenticated SAP call; handles CSRF for any verb `!== 'GET'`. On a 403 CSRF failure, refetches token *and* session cookie together before retrying. On `400 Session not found` it drops the stored cookies and CSRF token and retries once, except when the request carried a `sap-contextid` (a stateful sequence's lock lived in the dead session, so it fails instead). All calls funnel through a global concurrency semaphore (default 6, env `SAP_MAX_CONCURRENT_REQUESTS`). Never call the SAP HTTP layer outside this function. |
| `parseAdtErrorXml(xmlString)` | Human-readable message from SAP ADT error XML |
| `return_response(axiosResponse)` | Wraps `{ isError: false, content: [{ type:'text', text }] }` |
| `return_error(error)` | Wraps `{ isError: true, content: [...] }`; for `AxiosError` uses `error.response?.data ?? error.message` |
| `createAxiosInstance()` | Singleton axios, `rejectUnauthorized: false` (self-signed SAP certs) |
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

## ADT Endpoint Patterns

Full reference: `ADT_ENDPOINTS.md`.

| Object | GET source endpoint |
|--------|-------------------|
| Program | `/sap/bc/adt/programs/programs/{name}/source/main` |
| Class | `/sap/bc/adt/oo/classes/{name}/source/main` |
| Interface | `/sap/bc/adt/oo/interfaces/{name}/source/main` |
| Function module | `/sap/bc/adt/functions/groups/{group}/fmodules/{name}/source/main` |
| Include | `/sap/bc/adt/programs/includes/{name}/source/main` |
| Table (DDL) | `/sap/bc/adt/ddic/tables/{name}/source/main` |
| Search | `/sap/bc/adt/repository/informationsystem/search?query={q}&maxResults={n}` |
| Where-used | `POST /sap/bc/adt/repository/informationsystem/usageReferences?uri={objectUri}` |
| Object properties | `/sap/bc/adt/repository/informationsystem/objectproperties/values?uri={encodedUri}` |
| Transport history | `/sap/bc/adt/cts/transportrequests/reference?uri={encodedObjectUri}` |
| Transport search | `/sap/bc/adt/cts/transportrequests?user={user}&status={status}` |

---

## VIT URI Scheme (version management, object properties)

Some endpoints (notably `objectproperties`) need a **VIT URI**: `/sap/bc/adt/vit/wb/object_type/{vitType}/object_name/{NAME}`. Used in `GetTransaction`:
```typescript
const uri = `/sap/bc/adt/vit/wb/object_type/trant/object_name/${encodedName}`;
const url = `${baseUrl}/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=${encodeURIComponent(uri)}`;
```
VIT type codes: PROG→`prog/p`, INCL→`prog/i`, CLAS→`clas/oo`, INTF→`intf/oo`, FUGR→`fugr`, TABL→`tabl`, DTEL→`dtel`, DOMA→`doma`, DDLS→`ddls`, TRAN→`trant`, DEVC→`devc`.

> `/sap/bc/adt/vit/wb/object/versions` does **not** work ("No suitable resource found"). Use HATEOAS discovery instead.

---

## HATEOAS Link Discovery Pattern

Some ADT URLs must be discovered at runtime from an object's metadata XML rather than constructed.

1. Fetch metadata (`objectUrl` without `/source/main`) with `Accept: application/xml, */*`.
2. Recursively find the `atom:link` whose `_attributes.rel` matches the target relation (e.g. `http://www.sap.com/adt/relations/versions`) and read `_attributes.href`.
3. Resolve — SAP returns **relative hrefs** (`source/main/versions`, no leading slash). Use `new URL(href, String(objectUrl) + '/')`, never string-concatenate with the base URL (the trailing `/` on `objectUrl` is required so the relative path appends rather than replacing the last segment).

---

## Atom Feed Parsing Pattern

Some endpoints (version history, changelists) return Atom feed XML — require `Accept: application/atom+xml;type=feed`, parsed differently from standard ADT XML:

```typescript
const feed = convert.xml2js(xmlData, { compact: true })?.['atom:feed'];
const entries = [feed['atom:entry']].flat();  // normalise single-vs-array
for (const entry of entries) {
    const date = entry['atom:updated']?._text;
    // version/transport id: the atom:link with type=transportrequests, attr adtcore:name
    const TRANSPORT_TYPE = 'application/vnd.sap.adt.transportrequests.v1+xml';
    const links = [entry['atom:link'] || []].flat();
    const version = (links.find((l: any) => l._attributes?.type === TRANSPORT_TYPE) || links[0])?._attributes?.['adtcore:name'];
    const sourceUri = entry['atom:content']?._attributes?.src;  // per-version source location
}
```
To read source **at a specific version**, use that entry's `atom:content/@src` — **`?version=` on `/source/main` is silently ignored**, always returns active source. Per-version source lives at `/sap/bc/adt/.../{name}/source/main/versions/{timestamp}/{verNo}/content`, exactly the `src` value. See `handleGetObjectVersion.ts`.

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

## XML Parsing Pattern (standard ADT responses)

```typescript
const parsed = convert.xml2js(xmlData, { compact: true }) as any;
const root = parsed[Object.keys(parsed).find(k => !k.startsWith('_'))!];
// Namespaced keys ("adtcore:objectReference") — match by suffix
const refKey = Object.keys(root).find(k => k.endsWith(':objectReference') || k === 'objectReference')!;
const items = Array.isArray(root[refKey]) ? root[refKey] : [root[refKey]];  // always wrap
const attr = items[0]._attributes;   // { name, type, ... }
const text = items[0]._text;
```
Always fall back to raw XML on a parse failure: `catch (_e) { return { isError: false, content: [{ type: 'text', text: xmlData }] }; }`

---

## DataPreview POST Endpoint Pattern

Both `/sap/bc/adt/datapreview/ddic` and `/sap/bc/adt/datapreview/freestyle` are POST, requiring `{ 'Accept': 'application/*', 'Content-Type': 'text/plain' }` — without `Accept`, some systems 400; without `text/plain`, SAP's ICM URL-decodes the body and mangles `%` in `LIKE 'SE%'` into 400 Bad Request.

```typescript
// DDIC (table preview)
`${baseUrl}/sap/bc/adt/datapreview/ddic?ddicEntityName=${name}&rowNumber=${maxRows}`  // POST '', same headers
// Freestyle (SQL)
`${baseUrl}/sap/bc/adt/datapreview/freestyle?rowNumber=${maxRows}`                    // POST sqlQuery, same headers
```

**`rowNumber` is an inclusive 0-based row index on the DDIC endpoint only** (`rowNumber=3` → 4 rows), but an exact count on freestyle (`rowNumber=3` → 3 rows). `handleDataPreview.ts` clamps the parsed rows to `max_rows` client-side after fetching, regardless of endpoint — safe on both.

**Freestyle SQL works:** `SELECT *`, table-qualified columns (`t~tcode`), string/numeric `WHERE`, `LIKE`, `AND`, `IN`, `BETWEEN`, `ORDER BY ASCENDING|DESCENDING`, `DISTINCT`, `GROUP BY` + aggregate, `JOIN` on a non-MANDT key.

**Freestyle SQL fails:** an explicit column list without a table qualifier (`SELECT MANDT, TCODE FROM TSTC` → "Unknown column name MANDT"), `JOIN` on MANDT, ABAP's `UP TO n ROWS` (use `rowNumber` instead), and any `MANDT` reference in `WHERE` at all (queries always run in the connection's own logon client — no workaround; the exact SAP error wording is unstable across patch levels, but the restriction itself is durable).

Response is rendered as a fixed-width text table: `Table: T000 | Rows: 6 | Query time: 0.22ms` header, columns, then `[DDIC | 3 row(s) displayed, 6 total]`.

---

## Transport Tools

`GetTransport` (`handleGetTransport.ts`) and `ManageTransport` (`handleManageTransport.ts`).

### GetTransport — key endpoints

- **List user's transports:** `GET /sap/bc/adt/cts/transportrequests?user={user}&targets=true` → `tm:root/tm:workbench`+`tm:customizing` → `tm:target` → `tm:modifiable`/`tm:released` → `tm:request` (`tm:number`/`tm:owner`/`tm:desc`/`tm:status`/`tm:uri`) → `tm:task` → `tm:abap_object`.
- **Single transport:** `GET /sap/bc/adt/cts/transportrequests/{number}` (`Accept: application/vnd.sap.adt.transportorganizer.v1+xml`) — full tasks + object lists.
- **Find transport for an object:** `GET /sap/bc/adt/cts/transportrequests/reference?pgmid={pgmid}&obj_wbtype={type}&obj_name={name}` (`Accept: application/*`) — **not** `?uri=`; returns an `href` link to follow, not a transport list directly. `pgmid` is always `R3TR`; `obj_wbtype`: Program→`PROG`, Include→`INCL`, Class→`CLAS`, Interface→`INTF`, Function group→`FUGR`, Table→`TABL`.

### ManageTransport — create

```
POST /sap/bc/adt/cts/transports
Content-Type: application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest
```
```xml
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
  <DEVCLASS>{dev_class}</DEVCLASS><REQUEST_TEXT>{description}</REQUEST_TEXT>
  <REF>{object_url}</REF><OPERATION>I</OPERATION>
</DATA></asx:values></asx:abap>
```
Response: plain-text URL ending `/transports/{NUMBER}`. `REF` must be a full ADT path and **doesn't need to point at an object that exists yet** — SAP derives the transport layer from `DEVCLASS` + the URL's collection shape, not by resolving it. `action=create` accepts `object_type`+`object_name` as a `REF`-builder shortcut, letting a new object get a real transport description instead of WriteProgram's auto-generated "Generated Request for Change Recording" (unrenamable once released).

The create call **already creates the CR's first task in one shot** — don't call `add_task` right after `create` (stacks a redundant second task; `add_task` is only for a *different* developer on a shared CR). `object_type` has no `FUNC` entry (`TYPE_PREFIX` covers `PROG`/`CLAS`/`INTF`/`FUGR`/`INCL`/`TABL`/`DTEL`/`DOMA`/`DDLS`) — for a new function module pass `object_type=FUGR`+`object_name={group}` (its container) instead.

### ManageTransport — rename (`set_text`)

```
PUT /sap/bc/adt/cts/transportrequests/{number}
Accept: application/vnd.sap.adt.transportorganizer.v1+xml
```
```xml
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm">
  <tm:request tm:number="{number}" tm:desc="{new description}" tm:target="{current tm:target}"/>
</tm:root>
```
Undocumented (found via the `changeattributes` HATEOAS link). Only works **pre-release**. **`tm:target` must be echoed back from a GET taken first** — omitting it silently clears the transport's CTS route (demotes it to "Local Change Requests"). `set_text` also accepts an optional `target` argument to explicitly repair a transport whose target was already cleared by this bug in an older build.

### ManageTransport — release / delete / task

```
POST   /sap/bc/adt/cts/transportrequests/{number}/newreleasejobs   # release
POST   /sap/bc/adt/cts/transportrequests/{number}/relwithignlock   # release, ignore locks
POST   /sap/bc/adt/cts/transportrequests/{number}/relObjigchkatc   # release, ignore ATC
DELETE /sap/bc/adt/cts/transportrequests/{number}
POST   /sap/bc/adt/cts/transportrequests/{number}/tasks             # add task
```
Release **returns HTTP 200 even when aborted** — check `tm:root/tm:releasereports/chkrun:checkReport` for `chkrun:status` matching `abort|error|fail` or any `type="E"` message; don't trust HTTP status alone.

Add-task body (undocumented, from `abap-adt-api`'s `transportAddUser`):
```xml
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="{number}" tm:targetuser="{user}" tm:useraction="newtask"/>
```
(`Content-Type: text/plain`, `Accept: application/*`). Response echoes `tm:uri` — the new task number is its last path segment. `action=add_task` (`transport_number` required, `task_user` optional, defaults to `SAP_USERNAME`) is only for adding an *additional* task, never called automatically by `create`.

A bare `DELETE` is CSRF-checked and auto-retried on 403 the same as any mutating verb.

**`DELETE` only succeeds on a transport with zero registered `tm:abap_object` entries.** Deleting the underlying object does **not** clear its CTS registration (`tm:lock_status="X"` persists) — SAP refuses with *"Request/task {task} cannot be deleted because it contains locked objects."* Use `action=remove_object` (below) to clear a stale entry first.

### ManageTransport — `assign_object` (lock + PUT + unlock, stateful session)

1. GET current source.
2. `removeCookie('sap-contextid')`, then `POST ?_action=LOCK&accessMode=MODIFY` with `X-sap-adt-sessiontype: stateful` → capture `sap-contextid`.
3. `PUT /source/main?lockHandle=...&corrNr={transport}` (stateful).
4. `POST ?_action=UNLOCK&lockHandle=...` (stateless) → `removeCookie('sap-contextid')`.

SAP only registers the object in CTS when source actually changes — a same-source PUT is a no-op. Reassigning an object already in transport A to transport B **silently reassigns it, no warning**. Only works for the 9 `/source/main`-having types in `TYPE_PREFIX` (`PROG`/`CLAS`/`INTF`/`FUGR`/`INCL`/`TABL`/`DTEL`/`DOMA`/`DDLS`) — for anything else, or to move a specific task, use `move_object`/`merge`.

### ManageTransport — `move_object` / `merge` / `remove_object` (standalone endpoint)

Reassigns **any** repository object (not just `assign_object`'s 9 types) to a different task/request, or removes a stale locked-object entry without touching the underlying object. No ADT REST endpoint covers either — both go through a standalone SICF service (`default_host/zmcp/transport_admin`, `ZCL_HTTP_MCP_TRANSPORT_ADMIN`, package `ZMCP`) wrapping `ZCL_MCP_TRANSPORT_ADMIN`, the same standalone-endpoint pattern as `ManageAuthObject` (not the shared `ZCL_MCP_DISPATCH` router — a dispatcher branch was tried first and explicitly reverted).

**Move** is backed by `TR_MOVE_OBJECTS` (function group `STRI`) — the engine behind SE01/SE09's own "Move" — after ruling out `CTS_WBO_API_INSERT_OBJECTS` (refuses a conflicting object outright) and `RS_CORR_INSERT` headless mode (silently no-ops on a conflict instead of reassigning). Shipped strategy: try `CTS_WBO_API_INSERT_OBJECTS` first (cheap, works when there's no prior conflict); on a lock conflict its `object_locks` output names the object's current request, fed straight into `TR_MOVE_OBJECTS`. Both source and target must resolve to the **task** holding/receiving the `E071` entry, not a bare request number (`resolve_task()` helper, `SELECT trkorr FROM e070 WHERE strkorr = {request}`).

**Live-verified 2026-10-12** on a disposable `ZMCP` class and two requests: `move_object` and `remove_object` both persist with no explicit `COMMIT WORK` (the HTTP request's implicit commit is enough).

**Remove** is backed by `TR_DELETE_COMM_OBJECT_KEYS` (same function group) — the `removeobject` HATEOAS link SAP advertises on a transport's object entry is a vestigial, unimplemented action on this release (falls through to `handle_action_not_supported`); this FM is what `CL_CTS_REST_API_IMPL`'s own delete-object path and SE01/SE09's "Delete Object" actually call.

**`LIMU` sub-objects:** the direct-insert path needs the object's `devclass`, but `TADIR` only has `R3TR` rows, so a `LIMU FUNC` (function module) would fail with `object not found in TADIR`. `move_object` therefore translates the key via SAP's `TR_CHECK_TYPE` (`we_tadir`: `LIMU FUNC X` → `R3TR FUGR <group>`) before reading `TADIR`.

Both surfaced a shared gotcha: errors read via the caught exception's `get_text()` get truncated to 50 chars by the T100 template — read the exception's raw `detail` attribute instead.

- `action=move_object` (`object_type`, `object_name`, `transport_number` — task or request, `pgmid` default `R3TR`).
- `action=merge` (`from_transport`, `to_transport`) — moves every object in `from_transport`, then deletes it only if every move succeeded (partial failure leaves the source transport in place).
- `action=remove_object` (`object_type`, `object_name`, `transport_number` — the task/request currently holding it, `pgmid` default `R3TR`).

### XML namespace

Transport responses use `tm:` (`xmlns:tm="http://www.sap.com/cts/adt/tm"`); parse with `xml-js compact:true` — keys like `tm:number`/`tm:desc` in `_attributes`.

---

## ManageAuthObject Tool

Creates/updates a custom **SU21 Authorization Object** and its fields. SU21 has no ADT/REST surface at all, so this is a standalone SICF service (`default_host/zmcp/auth_object`, `ZCL_HTTP_MCP_AUTH_OBJECT`, package `ZMCP`) wrapping SU21's real engine class `CL_SUSO_APPL` directly. TypeScript: `handleManageAuthObject.ts`, POSTing `mode`(`create`/`update`)/`object_class`/`object_name`/`description`/`devclass`/`trkorr` with a comma-separated field list as the body; plain-text response.

**Scope:** the Authorization Object + up to 10 fields only. Object Class must already exist; no delete action (SU21 objects aren't reachable by `DeleteObject`'s `quickSearch` resolver either).

`CL_SUSO_APPL` is built for SU21's interactive screen, so the wrapper drives it the same way the UI would: `CONSTRUCTOR` → `SET_DATA_SUSO` → `SAVE_DATA_SUSO`. The field list only reaches `TOBJ-FIEL1..0` in **change** mode, never on a pure create — so `action=create` does a header-only save first, then (if fields were supplied) a second change-mode save carrying the field buffer. `action=update` always runs the change-mode save and **replaces** the field list wholesale (mirrors SU21's own semantics) unless `fields` is omitted, which leaves the existing slots untouched. `SAVE_DATA_SUSO` does a real `DB_COMMIT` — it escapes AUnit rollback, so tests need explicit cleanup.

DDIC facts: `TOBJ` (client-independent, key `OBJCT`, 10 inline field slots `FIEL1..0`, FK `OCLSS`→`TOBC`); text table `TOBJT` keyed by `OBJECT` (not `OBJCT`). `object_name`/each `field_name` are CHAR10, validated and rejected (never truncated) over length.

**`ACTVT` support:** put permitted activities on the `ACTVT` field entry (`{"field_name":"ACTVT","permitted_activities":["02","03"]}`) → travels as `activities=02,03`, becomes `TACTZ` rows. Validated before any save: each activity exists in `TACT`, no duplicates, `ACTVT` requires activities and vice versa (on create). On `update`, omitting `permitted_activities` keeps the existing `TACTZ` list; omitting `ACTVT` from the field list clears it.

**Object class can change on `update`** — `object_class` is optional, validated against `TOBC`; a locked field list doesn't block a class change (SU21 keeps the header editable independently).

**Field list locks once the object is in use** — `CL_SUSO_APPL`'s constructor runs where-used checks (role authorizations, program cross-refs, TSTCA, DCL); if any hit, field edits are silently skipped (return code 0, header/activities still save). `attach_fields` now checks the edit mode first and raises `field_locked` (HTTP 409) if the requested field list differs from the current one — remove the code/role usage first if a field genuinely needs to change.

Message class `ZMCP_AUTH_OBJECT` doesn't exist, so `map_exception` builds error text itself from the textid + the exception's `detail` (same 50-char-truncation avoidance as `ManageTransport`).

**Live-verified 2026-10-12 on a clean system** with the permanent anchor object `ZMCP_E2E01` (class `BC_Z`, package `ZMCP`, in the transport used for the endpoint install; SU21 objects cannot be deleted, so it stays and is reused by the tests): `create` with fields `BUKRS`+`ACTVT` and activities `02,03` wrote `TOBJ`, `TOBJT`, `TACTZ` and a `TADIR` `SUSO` entry, all read back; `update` of the description alone left fields and activities untouched; `update` of the activities (`02,03,06`) changed only `TACTZ`; adding a field (`WERKS`) without `permitted_activities` kept the existing activity list; a duplicate `create` was refused (`already exists`); once a throwaway `$TMP` program used the object in an `AUTHORITY-CHECK`, a field-list change was refused (`field edit mode 03`, "Nothing was saved") while description and activities were still changeable. **Trap:** on `update` the field list is *replaced*, so a partial list silently drops the other fields (an early version of the test cut the anchor down to `ACTVT`; it was restored). The tests therefore send negative cases only as `create` calls with a short name and the nonexistent class `ZZZZ`.

---

## ManageDDIC Tool

Creates/updates DDIC **structures**, **table types**, **data elements**, **CDS view entities**, and **domains** via their native ADT contracts. `handleManageDDIC.ts`, `object_type=STRUCTURE|TABLE_TYPE|DATA_ELEMENT|CDS_VIEW|DOMAIN`, `action=create|update`. No delete action — use `DeleteObject` (live-verified on a `DOMAIN` 2026-10-07; the other metadata-XML types are unverified). Discovery record: `plan/20260826-manage-ddic-phase-{1..6}.md`. Two of the three metadata-XML types share a "description unretrievable after creation" quirk (below); `DATA_ELEMENT` doesn't.

There are two families: DDL-source objects (`STRUCTURE`, `CDS_VIEW` — share one `manageDdlSourceObject()` function) and metadata-XML objects (`TABLE_TYPE`, `DATA_ELEMENT`, `DOMAIN` — share lock/unlock plumbing but each has its own body-schema function).

### STRUCTURE / CDS_VIEW — DDL-source, same lock/PUT shape as WriteProgram

```
POST /sap/bc/adt/ddic/structures            (or /sap/bc/adt/ddic/ddl/sources for CDS_VIEW)
  Content-Type: application/vnd.sap.adt.structures.v2+xml  (or .ddlSource+xml)
POST .../{name}?_action=LOCK&accessMode=MODIFY
PUT  .../{name}/source/main?lockHandle=...[&corrNr=...]     Content-Type: text/plain
POST .../{name}?_action=UNLOCK&lockHandle=...
POST /sap/bc/adt/activation?method=activate&preauditRequested=true
```
`create` does one extra POST first to establish the (empty) object, then both `create`/`update` share the lock → PUT → unlock → activate tail. Body for `source_code` is the full `define structure NAME { ... }` / `define view NAME as select from ...` DDL. `CDS_VIEW`'s source PUT returns an **empty** body on success — don't rely on it for confirmation, check activation/read-back instead. Only classic `define view` syntax verified; `@AbapCatalog.preserveKey` triggers a (non-fatal) deprecation warning here.

### TABLE_TYPE / DATA_ELEMENT / DOMAIN — metadata-XML, no `/source/main`

Whole definition is one XML document at the object's own URL (`GET .../{name}/source/main` 404s). `create` is `POST /sap/bc/adt/ddic/{tabletypes|dataelements|domains}` with the full definition — activates immediately, no lock/PUT. `update` uses the same lock/unlock as the DDL family, but PUTs the full document to the object's **own URL** (not `/source/main`).

**TABLE_TYPE** (`application/vnd.sap.adt.tabletype.v1+xml`, root `ttyp:tableType`) — requires `ttyp:rowType`/`ttyp:builtInType`/`ttyp:rangeType` even when unused. Only `typeKind=dictionaryType` + `accessType=standard` supported (`sorted`/`hashed` with explicit keys was probed but the request shape that sets the key list was never found — SAP silently drops it).

**DATA_ELEMENT** (`application/vnd.sap.adt.dataelements.v2+xml`, root `blue:wbobj` wrapping `dtel:dataElement`) — needs `dataType`/`dataTypeLength`/`dataTypeDecimals` (read live from the referenced domain and embedded automatically) plus the full short/medium/long/heading field-label block. Only `typeKind=domain` supported. Unlike the other two, a changed description **does** take effect on update.

**DOMAIN** (`application/vnd.sap.adt.domains.v2+xml`, flat root `doma:domain`, no wrapper) — simplest of the three, worked first try. `doma:content/doma:typeInformation` (`datatype`/`length`/`decimals`); SAP auto-fills output/value info. V1 scope: `data_type`/`length`/`decimals` only.

**Description trap (`TABLE_TYPE`, `DOMAIN`):** a freshly created object's description is unretrievable through every read path (GET, quickSearch, objectproperties, even a freestyle `SELECT * FROM dd40t` returns zero rows) — only the create response's own `201` ever echoed it. `update`'s PUT therefore can't safely round-trip the description (an empty GET value trips `400 The description is missing`), so `update` rejects a supplied `description` outright and uses the object's own name as a schema-satisfying placeholder.

All five DDIC object types share `WriteProgram`'s 30-character name-length guard on `action=create`.

---

## WriteProgram Tool

Writes (overwrites) source for programs, includes, classes, function modules. `handleWriteProgram.ts`. Accepts either `source_code` (inline) or `source_file` (path to a local file, read via `fs.readFile`, resolved against `process.cwd()`) — prefer `source_file` for large source so the MCP argument and the calling LLM's context stay small; if both are given, `source_file` wins.

### Auto-detection

Before locking, resolves the object to determine type + ADT URI: Program `PROG/P` → `/sap/bc/adt/programs/programs/{name}`; Include `PROG/I` → `/sap/bc/adt/programs/includes/{name}`; Class `CLAS/OC` → `/sap/bc/adt/oo/classes/{name}`; Function module `FUGR/FF` → `/sap/bc/adt/functions/groups/{group}/fmodules/{name}`. This resolved URI is used for lock, PUT, unlock, **and activation** — activating an include via the `/programs/` path would silently activate the main program instead.

### Auto-creation (`CREATION_TYPES`, needs `description`+`package_name`)

- `PROG` (default) — `POST .../programs/programs`, root `program:abapProgram`
- `INCL` — `POST .../programs/includes`, root `include:abapInclude`
- `FUGR` — `POST .../functions/groups`, root `group:abapFunctionGroup`, type `FUGR/F`
- `CLAS` — `POST .../oo/classes`, root `class:abapClass`, type `CLAS/OC` (same generic template as PROG/INCL)

```xml
<program:abapProgram xmlns:program="..." xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="..." adtcore:name="ZNAME" adtcore:type="PROG/P">
  <adtcore:packageRef adtcore:name="ZPACKAGE"/>
</program:abapProgram>
```
`transport_number`, if given, is passed as `?corrNr=` to both create and PUT.

**`FUGR` is create-only** — a function group has no writable `/source/main` (SAP auto-generates TOP/UXX includes); provide `description`+`package_name`, omit `source_code`.

**`FUNC`** needs `function_group` (created on demand via `ensureFunctionGroup`); `createFunctionModule` POSTs a bare shell (`fmodule:abapFunctionModule`, `containerRef` pointing at the group), then the normal lock→PUT→unlock→activate flow runs. **The FM signature lives inline in `source/main`** (`FUNCTION name IMPORTING ... EXPORTING ... TABLES ... . <body> ENDFUNCTION.`) — do not prepend `*"`-comment interface blocks, SAP manages those. `TABLES` parameters must be `LIKE <DDIC structure>` — inline `STRUCTURE` fails with "Parameter X declares no type" (the handler appends a hint when it sees this).

**`CLAS`** rides the same generic lock→PUT→unlock→activate path as PROG/INCL (no special branch needed) — `source_code` must contain the **full** `CLASS ... DEFINITION ... ENDCLASS. CLASS ... IMPLEMENTATION ... ENDCLASS.`; visibility/`FINAL`/`ABSTRACT`/`CREATE PUBLIC|PROTECTED|PRIVATE` live in the `DEFINITION` header text itself, set by the caller's first PUT (a brand-new class starts as `PUBLIC CREATE PRIVATE` with empty sections).

### Post-create resolution

After `createObject()`/`createFunctionModule()`, resolving the just-created object via `quickSearch` can miss a still-**inactive** object (the search index lags), producing `"created but could not be resolved"` and, on retry, an orphaned inactive shell no tool can reach. Fix: `directObjectInfo()` builds the `ObjectInfo` directly from the known creation path (or FM group/name shape), `verifyObjectUrl()` confirms with a plain metadata GET, and only falls back to `quickSearch` if that direct URL doesn't check out. (`CLAS` and `ManageDDIC`'s `CDS_VIEW` create didn't exhibit this — scoped as a search-index gap, not universal.)

### Change-request reassignment guard

The lock result's `CORRNR`/`CORRUSER`/`CORRTEXT` show the transport the object is currently locked under. If a **different** `transport_number` is supplied, `WriteProgram` unlocks and refuses rather than let SAP silently move the object into the new request. Same transport, no `transport_number`, or not-yet-in-any-request all proceed normally.

**Check the object's current transport before creating a new one** — order matters, otherwise a refused reassignment leaves an empty duplicate transport behind. **Prefer `UnlockObject` over `GetTransport` for this check**: `GetTransport`'s list mode is scoped to the connection's own user and returns headers only, so an object already sitting in a *different user's* open transport is invisible to it — `UnlockObject`'s LOCK/UNLOCK cycle reads `CORRNR` straight off the object's own CTS registration regardless of owner. Recovery from an already-created orphan: delete it (`ManageTransport action=delete`, succeeds on an empty transport) and retry `WriteProgram` with the transport the refusal message named.

### `transport_description`

When `transport_number` is omitted, SAP auto-creates one on first write, titled "Generated Request for Change Recording" (unrenamable once released). Pass `transport_description` (+ `package_name`, used as `DEVCLASS`) to have `WriteProgram` explicitly `POST /sap/bc/adt/cts/transports` first with a real description, then use that number as `corrNr`. Ignored when `transport_number` is also given.

### Object name length limits (validated pre-create, never silently truncated)

**PROG/INCL 30, CLAS 30, FUGR 26, FUNC 30 characters.** PROG/INCL over the limit are hard-rejected by SAP; CLAS/FUGR/FUNC used to be **silently truncated on create** (their classic CHAR30/CHAR26 name field just truncates on insert) — `WriteProgram` now validates against `MAX_NAME_LENGTH` before any create call and throws `McpError(InvalidParams, ...)` with actual/max length instead. `ManageDDIC` carries the same 30-char guard for its five object types.

### Usage notes

- FM source must not include `*"---` parameter comment blocks — SAP manages those.
- Close SE37/SE38/SE80 sessions before writing; a lock conflict names the editing user and flags whether it matches our own `SAP_USERNAME` (likely a leftover session — try `UnlockObject`) vs. a different developer (coordinate, don't force).

### Flow

```
0. removeCookie('sap-contextid')
1. POST  {objectUrl}?_action=LOCK&accessMode=MODIFY        (stateful) → LOCK_HANDLE, capture sap-contextid
2. PUT   {objectUrl}/source/main?lockHandle=...[&corrNr=...] (stateful)
3. POST  {objectUrl}?_action=UNLOCK&lockHandle=...          (stateless) → removeCookie('sap-contextid')
4. POST  /sap/bc/adt/activation?method=activate&preauditRequested=true   (stateless, must run AFTER unlock)
```
Every unlock call site goes through a shared `attemptUnlock()` that surfaces SAP's error text instead of discarding it. If step 3's unlock fails, step 4 is **skipped outright** and the response reads "Activation SKIPPED — unlock FAILED", pointing at `UnlockObject`.

### Activation error parsing

Activation returns HTTP 200 even on failure — real errors are `<msg type="E">` inside `chkl:messages`; `type="W"` are warnings. **`activationExecuted="false"` alone is NOT a failure** — it also fires on a harmless no-op (source identical to already-active). Only fail on an actual `type="E"`; otherwise report "nothing to activate" when `activationExecuted="false"` with no errors. Parse `<shortText><txt>` children for message text (nested, non-compact xml-js).

---

## Stateful Operation Gate (`src/lib/writeLock.ts`)

One non-reentrant gate for **every handler that opens an ADT stateful `LOCK` session**: `WriteProgram`, `ManageDDIC`, `ManageMessageClass`, `ManageTransport(action=assign_object)`, `ActivateObjects(rfc_enabled)`, `UnlockObject`, `DeleteObject`. At most one of them runs at a time per SAP system (`SAP_URL|SAP_CLIENT`) on this machine — whether the competing call comes from another MCP connection (each `StdioServerTransport` connection is its own OS process) or from the **same** process (the shared module-level `sap-contextid` cookie in `utils.ts` makes two overlapping lock flows corrupt each other's session). A blocked call is refused immediately with the holder's label and token, never queued.

**Lock token = the real `sap-contextid`.** A file-based mutex (`fs.writeFileSync(..., { flag: 'wx' })`) keyed by `sha1(SAP_URL|SAP_CLIENT)` under `os.tmpdir()` (`mcp-abap-adt-writelock-<key>.json`):

1. `acquireStatefulOperationLock(label)` — first thing in the handler's wrapper; atomically creates `{ pid, token: 'pending:<pid>', label, acquiredAt }`. Held by any live pid (including our own) → `{ ok: false, message }`.
2. `refreshStatefulOperationToken(sapContextId)` — overwrites `token` once the real LOCK POST succeeds.
3. `releaseStatefulOperationLock()` in the wrapper's `finally` — deletes the file only if its `pid` still matches this process.

**Crash recovery, two layers:** `isProcessAlive(pid)` via `process.kill(pid, 0)` takes over immediately if the holder's pid is gone (`ESRCH`); `EPERM`/inconclusive falls through to a **2-minute (`STALE_MS`) time-based takeover** regardless. Either path only changes local file state — SAP's own enqueue lock still correctly rejects a genuinely-live crashed session.

**Fails open:** any filesystem error other than `EEXIST` on create (permissions, read-only tmp) proceeds without locking.

**Windows note:** `os.tmpdir()` is per-user there, so the gate only sees connections on the same machine *and* same OS login. SAP's own per-object enqueue remains the authority across machines, logins, SAP GUI and Eclipse.

**Not gated:** the stateless standalone-endpoint writers (`TextPoolLang`, `ManageAuthObject`, `ManageDynpro`, `ManageSicfNode`, `UnlockObject force=true` → `lock_admin`, `ManageSessions` → `session_admin`) — one HTTP call each, no shared session. A new handler that takes an ADT `LOCK` must wrap its core in this gate (template: `handleManageMessageClass`'s exported wrapper) **and** call `removeCookie('sap-contextid')` right before its `LOCK` POST (see Key Utilities).

---

## ManageDynpro Tool

Creates, updates, deletes or consistency-checks a classic screen. `handleManageDynpro.ts` → `POST|DELETE|GET …/zmcp/dynpro` (`ZCL_HTTP_MCP_DYNPRO` → `ZCL_MCP_DYNPRO`). One stateless HTTP call per action, so **not** behind the stateful-operation gate (same as `TextPoolLang`/`ManageAuthObject`). Input: `definition`/`definition_file` = the `GetCode DYNPRO raw=true` JSON (header program/screen are overridden by the target, so copying between screens/programs works; a self-referencing next screen is retargeted); or, on `update`, just `flow_logic(_file)`, `description` and/or `screen_attributes` (the handler reads the current definition and swaps those parts). `screen_attributes` maps SE51's Attributes tab to `RPY_DYHEAD` (`type` normal/subscreen/modal, `next_screen`, `cursor_position`, `screen_group`, `lines`/`columns`, `context_menu` → `ctx_menon`, flags `hold_data`/`switch_off_runtime_compression`/`hold_scroll_position`/`without_application_toolbar`/`fiori_no_enlargement`) — all live-verified to write and read back exactly. **"Template – non-executable" (`no_execute`) is refused:** SAP cannot generate template screens ("Template dynpros cannot be generated"). TS validates flow lines ≤ 72 chars, description ≤ 60, the screen type, every attribute value, and refuses an element with `input_fld "X"` + `requ_entry "N"` (domain `SCRPFOBL`: `""` input possible, `N` not possible, `R` recommended, `O` required — SAP silently drops the input flag; TEXT elements carry `N`, so copying one as an input-field template was the trap) before any SAP call. `GetCode DYNPRO`'s readable view lists the ticked Settings and the context-menu FORM.

Rules (ABAP side): customer programs only (`Z*`/`Y*`/`SAPLZ*`/`SAPLY*`); only screen types `N`/`I`/`M` are writable (selection screens and unknown codes refused); `$…` package → no transport, otherwise `transport_number` required (task → its request) and refused with 409 if the screen or its `R3TR PROG` is already locked in a **different** open request — SAP itself would silently keep it there.

Write sequence and the traps behind it (all live-verified):
1. **Own pre-check: every subscreen area must have `CALL SUBSCREEN` in PBO and PAI** (handles chained `CALL SUBSCREEN: a, b.`), else refused, nothing saved. SAP's own #145 finding missed a screen created earlier in the same session, so it isn't relied on.
2. `RPY_DYNPRO_INSERT` with `SUPPRESS_COMMIT_WORK='X'`, `USE_CORRNUM_IMMEDIATEDLY=' '`, request as `CORRNUM`. Its `TYPE C` flags reject an inline `xsdbool( )` actual at runtime (`CX_SY_DYN_CALL_ILLEGAL_TYPE`) — pass CHAR1 variables. A **failed** generation rolls back cleanly; a **successful** generation is final.
3. `COMMIT WORK`, then SE51's consistency check `RS_SCRP_CONS_CHECK_TODO_SINGLE` (finding = 100 + pointer, texts = `SAPLSEUZ` text symbols 1nn). **The check commits implicitly** — so it can only report after the write, never gate it. Runtime-fatal findings (102 undefined MODULE, 103, 104, 112, 116, 117, 121, 123, 145) → header `x-mcp-check: errors` → `isError` with "screen IS saved, fix the program and `action=check` again"; the rest (e.g. 101 next screen doesn't exist yet) are warnings. Screen generation itself does **not** check MODULE existence.

Delete: `RS_SCRP_DELETE WITH_POPUP=' '` + explicit `COMMIT WORK` (it never commits itself) + `D020S` re-check. Integration tests write only to `$TMP` program `ZMCP_DYNP_W_E2E`.

---

## ManageMessageClass Tool

Creates/updates/deletes an SE91 message class and its individual messages over the **native ADT contract** (no SICF endpoint needed). `handleManageMessageClass.ts`, `action=create|update|delete`; `update` upserts `messages` in one language (the class's master language, or `language` = ISO code for a translation), removes `delete_messages` (all languages), or with `replace_all=true` deletes every message not in `messages`. Read side stays `GetMeta resource=MESSAGE_CLASS`. Behind the stateful-operation gate (`writeLock.ts`) like `ManageDDIC`. Live-probed 2026-10-07 on `$TMP` classes.

```
POST   /sap/bc/adt/messageclass                          create (201), body = header only
POST   /sap/bc/adt/messageclass/{name}?_action=LOCK|UNLOCK
PUT    /sap/bc/adt/messageclass/{name}?lockHandle=…[&corrNr=…]   only the messages being written
DELETE /sap/bc/adt/messageclass/{name}?lockHandle=…[&corrNr=…]   then UNLOCK anyway
Content-Type/Accept: application/vnd.sap.adt.mc.messageclass+xml
```
```xml
<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:name="ZFOO" adtcore:type="MSAG/N" adtcore:description="..." adtcore:masterLanguage="EN" adtcore:language="EN">
  <adtcore:packageRef adtcore:name="$TMP"/>
  <mc:messages mc:msgno="001" mc:msgtext="Order &amp;1 not found" mc:selfexplainatory="true"/>
  <mc:deletedmessages mc:msgno="002"/>   <!-- explicit delete; must follow every mc:messages -->
</mc:messageClass>
```
No activation step — the class reads back `version="active"` straight after the PUT. Description changes on update take effect. Limits validated before any call: name Z/Y, ≤ 20 chars (`T100A-ARBGB`); text ≤ 73 (`T100-TEXT`); description ≤ 60.

**Traps (all found live):**
- **Every write PUT must carry `adtcore:language` — omitting it wrote a real class into the BLANK language.** `DO_UPDATE` reads the existing texts and writes every incoming message in `adtcore:language` (`update_message`: `T100-SPRSL = iv_language`). 3.4.0 never sent it, so SAP compared against the empty language, treated all messages as new, and wrote all 37 of `ZCU01` with `SPRSL = ' '`. Fixed: the PUT carries `adtcore:language` (default: master language) and only the messages being written. The master language comes from `T100A-MASTERLANG` → `T002-LAISO` via a freestyle DataPreview, because **ADT's GET reports `adtcore:masterLanguage` wrongly** (`EN` for `ZCU01`, whose master is `M`/`ZF`). Reads honour the `sap-language` header; an unknown code silently falls back to the logon language, so the returned `adtcore:language` is checked.
- **Deletion is language-sensitive the other way round.** `CL_ADT_MESSAGE_CLASS_API=>DELETE` removes a message in **all** languages (plus its long text and `T100U`) when the language is empty or equals the logon language, otherwise only that language's `T100` row. The tool therefore sends deletions in a separate PUT without `adtcore:language` and without `<mc:messages>`, and refuses `delete_messages`/`replace_all` together with a translation `language`. Consequence: blank-language rows can't be removed through ADT (an empty language means "all languages") — that needs a direct `DELETE FROM t100 ... AND sprsl = ' '`.
- **Leaving a message out of the PUT does NOT delete it — list it in `<mc:deletedmessages mc:msgno="…"/>`.** `CL_ADT_MC_RES_CONTROLLER->DO_UPDATE` (package `SMESSAGE_ADT`) deletes only the `TT_DELETEDMESSAGE` rows; its "delete what the front end dropped" loop is commented out. Element name/order come from the simple transformation `ST_ADT_MESSAGE_CLASS` (a loop over `tt_message`, then a loop over `tt_deletedmessage`). Empty `msgtext`/invented flags are silently ignored. The per-message resource `…/messages/{no}` (`CL_ADT_MSG_ATOM_RES_CONT`) is no alternative: it implements only GET and `LOCK_MSG`, so a plain DELETE there answers 423 `InvalidLockHandle`. Found by reading those classes after the black-box probes failed — when ADT behaves oddly, read its resource controller (registered in the package's `*_REST_RFC_APPLICATION->REGISTER_RESOURCES`).
- **A DELETE without a following UNLOCK leaves the name enqueued** by our session: re-creating it fails with *"User {own user} is currently editing {name}"* although the object is gone, until the SAP session times out (or SM12). `action=delete` therefore unlocks after the DELETE; `action=create` explains the symptom when it sees it.
- `mc:selfexplainatory="false"` reads back with `mc:documented="true"` — SAP sets that itself.

Every write re-reads the class and compares the numbers/texts it sent; a mismatch → `isError` (`Read-back WARNING`). Transports live-verified on a disposable `ZMCP` class: create with `transport_description` registers `R3TR MSAG`; `update`/`delete` without `transport_number` reuse the request the class is already locked in (`CORRNR` from the LOCK) and refuse only when it's transportable and in none; a different `transport_number` is refused. Cleanup after deleting a transportable class: `ManageTransport remove_object` (object_type `MSAG`) on the task, then `action=delete`. **Long texts can't be written through ADT on this release.** `…/messages/{no}/longtext` (`CL_ADT_MSG_RES_LONGTEXT`) redefines only `GET` (HTML); the write API `CL_ADT_MSG_LONGTEXT_API` (`SAVE_LONGTEXT`/`CREATE_LONGTEXT` → `DOCU_UPD`, docu class `NA`, object = class padded to 20 + msgno) exists but no REST resource calls it — Eclipse edits long texts through embedded SAP GUI. A write would need a standalone SICF endpoint wrapping that API.

**Long-text deletion trap:** `DO_UPDATE` deletes a message's long text when the PUT carries `selfexplainatory="true"` **and** `documented="true"` for it. The tool therefore never sends `mc:documented`, and an overwritten message keeps its existing self-explanatory flag unless `self_explanatory` is passed (new messages default to true).

---

## UnlockObject Tool

Recovers from a stuck ADT edit lock (`WriteProgram`'s `"User X is currently editing Y"`) without SAP GUI/SM12. `handleUnlockObject.ts`. ADT has no read-only "who holds this lock" endpoint — the only way to observe lock state is to attempt the lock itself:

1. Resolve `object_name` via `quickSearch` (any object type, shared `src/lib/resolveObject.ts`). A name matching several types (program and structure `RSPARAM`) is refused with the candidates listed — pass `object_type` (`PROG` or `PROG/P`).
2. `removeCookie('sap-contextid')`, then `POST ?_action=LOCK&accessMode=MODIFY` (stateful).
3a. **Lock acquired** → immediately `POST ?_action=UNLOCK` (stateless). Net effect: a free object is untouched; a stray/reclaimable lock is cleared. Reports `CORRNR`/`CORRTEXT` if registered in a transport.
3b. **Lock failed** → no further action. Compares the editing user against our own `SAP_USERNAME` (match = likely our own leftover session; mismatch = a different developer, never force).

**`force=true` (own-user orphans only):** when 3b fails and the holder is our own `SAP_USERNAME`, `UnlockObject` POSTs `object_name`+`delete=X` to the standalone SICF endpoint `default_host/zmcp/lock_admin` (`ZCL_HTTP_MCP_LOCK_ADMIN` → `ZCL_MCP_LOCK_ADMIN`, sources in `abap-tasks/zmcp-lock-admin/`; CSRF plumbing copied from `ZCL_HTTP_MCP_TRANSPORT_ADMIN`). ABAP side runs `ENQUEUE_READ` with `guname = sy-uname` and deletes matching entries via `ENQUE_DELETE` (one U — `ENQUEUE_DELETE` doesn't exist; this is SM12's own Delete FM, TABLES `ENQ` type `SEQG3`, exports `SUBRC`), so another user's lock is unreachable by construction; each entry is also re-checked for our user and client before it is deleted. Without `delete=X` the endpoint only reports. Matching is whole-name (client prefix and `U+FFFF` padding stripped), so `ZMCP_X` never hits `ZMCP_X2`. Then run `UnlockObject` again without force to confirm. There is no orphan-vs-live test on the ABAP side, so only use it when no GUI/Eclipse session of yours is open: a **live** lock of your own would be deleted too. `ENQUE_DELETE` live-verified 2026-10-12 on `TRDIR` (programs), `SEOCLSENQ` (class) and `T100`+`T100A` (message class) orphans left by failed test runs. The first version of this class called `ENQUEUE_DELETE` and failed with HTTP 500 "Function module not found" on first contact.

**Never force-unlocks another session's lock** — the only state-changing outcomes are 3a and the own-user `force` delete, and even in 3a a genuinely-held lock's own LOCK attempt in step 2 would have failed, landing in 3b instead.

**`force` removes the lock, not the session.** The failed stateful call that orphaned the lock also left an ABAP session of the user in SM04; deleting the SM12 entry does not end it and it lingers until the HTTP session timeout — end it with [`ManageSessions`](#managesessions-tool) (list first, then end by `server:tid`) or in SM04. **To see all SM12 entries use SM12 or an RFC-based Basis tool** — ADT has no lock-list endpoint and `UnlockObject` fails exactly when an orphan exists. After deleting a lock held by a still-open ADT session, also send that session's UNLOCK (or it lingers in SM04 until timeout).

---

## ManageSessions Tool

Lists and ends the connection user's **own** stale ABAP sessions (SM04) on **every** application server — the session half of recovering from a failed stateful ADT call (`UnlockObject force=true` removes only the SM12 lock). `handleManageSessions.ts` → `POST …/zmcp/session_admin` (`ZCL_HTTP_MCP_SESSION_ADMIN` → `ZCL_MCP_SESSION_ADMIN`, sources in `abap-tasks/zmcp-session-admin/`, SICF node created with `ManageSicfNode`). Standalone endpoint, one stateless call per action, so **not** behind the stateful-operation gate. Developed in the private sibling project first and cloned here.

- `action=list` → one line per session, id = `server:tid`, `kind` (`HTTP` = type 202, `GUI` = 4, else `type<n>`), `term` (client IP), `time` (logon time of day only — the day is unknown, `age` wraps at 24 h), `CURRENT` marks the session carrying the request, and a second header line names the current session (system, client, user, language, application server). Built from `TH_SERVER_LIST` + `TH_USER_LIST DESTINATION <server>`, rows filtered to `sy-uname`/`sy-mandt`; an unreachable server is reported under `PROBLEMS`, never fails the call. The `type32` rows are RFC contexts created by the list calls themselves.
- `action=end` (`ids` required, `min_age_minutes` default 2) → `TH_DELETE_USER` per id. ABAP-side safety rules: fresh list before every id; unknown → "not found"; `CURRENT`, non-`HTTP` kinds and sessions younger than `min_age` are REFUSED; `tid` is never `-1`; `AUTHORITY_ERROR` is reported as "use SM04"; a final list reports `ended`/`still there`. **No "end all".** Refusals/failures set `isError`.
- Your own open Eclipse/ADT sessions are HTTP sessions too and look identical — end only ids you recognize by `term` and `age`.

**What leaves a lingering session (probed 2026-10-12):** a **stateful** request (`X-sap-adt-sessiontype: stateful`) does — even one refused with 403 — while a plain `GET` or a `GET` with `x-csrf-token: fetch` leaves none (the list stayed at the same size). Idle HTTP sessions also disappear by themselves after the SAP session timeout (57 → 34 in about 30 minutes).

**`tid` is a slot number and is reused immediately.** In one run tid 47 was the HTTP session carrying the request in one call and an RFC context (`type32`) in the next; asking to end the id of a session that had just been ended answered `REFUSED - kind type32 …`. An id is only meaningful in the list it came from, which is why `end` re-validates every id against a fresh list, and why the minimum age exists. **Known flaw (found 2026-10-12 through the MCP tool):** the final check compares only `server:tid`, so when the freed slot is reused at once — here by the very session carrying the verification request — it answers `still there` and sets `isError` although the session was ended (the next `list` showed tid 28 with a new logon time, the old one gone). Treat `still there` as unproven and compare logon time in a fresh `list`; the fix is to compare `tid` **and** logon time `time` (and `term`) in the verification step.

**Verified live 2026-10-12** (one application server on this system): `list`; malformed or missing `ids`; an unknown id; refusals for the current session, a GUI session (the user's SM04) and an RFC context; the default minimum age refusing a 0-minute-old session; and a real `end` of a throwaway session created by a stateful `POST` without CSRF token — answer `ended`, absent from the next list, and `TH_DELETE_USER` raised no authority error for the MCP user. **Not verified:** a second application server (only one is registered here), and the effect of ending a session on a client that is mid-sequence. `activate` shows two warnings that `regex =` uses the deprecated POSIX standard (`pcre =` would remove them).

## DeleteObject Tool

Deletes a repository object outright. `handleDeleteObject.ts`. (`ManageDDIC` is create/update only; `ManageTransport action=delete` only deletes an *empty transport*, not an object inside it.)

1. Resolve via `quickSearch` (any type), same shared resolver and `object_type` disambiguation as `UnlockObject`.
2. `removeCookie('sap-contextid')`, `POST ?_action=LOCK&accessMode=MODIFY` (stateful) → `LOCK_HANDLE` + `CORRNR`/`CORRTEXT` if already registered.
3. `DELETE {objectUrl}?lockHandle={handle}[&corrNr={transport}]` (stateful) — no response body on success; throws on failure (unlock before reporting the error in that case).
4. On success, `UNLOCK` anyway — an ADT `DELETE` does not release the enqueue entry (SM12 keeps a `TRDIR` lock for a deleted program, so re-creating the name fails with "currently editing" by your own user).

Same reassignment guard as `WriteProgram`: a supplied `transport_number` differing from the lock's `CORRNR` refuses the delete rather than silently reassigning.

**Container-lock trap:** deleting a member of a container (e.g. an FM inside a function group) must be recorded under whichever transport holds the **container's own** CTS lock (`R3TR FUGR {group}`), not the member's own `LIMU FUNC` entry — these can differ. Symptom: `ExceptionResourceDeletionFailure`, *"Object R3TR FUGR {group} is already locked in request {other transport}"* even though your own transport plainly lists the member. The handler parses this and names the blocking transport; retry with `transport_number={blocking transport}`, release it first, or merge the two requests.

Generic for any type `resolveAnyObject`/`quickSearch` can find via the `{objectUrl}?lockHandle=...&corrNr=...` contract, but only `PROG/P`, `FUGR/FF` and `DOMA/DD` were exercised end-to-end — confirm with a disposable object before relying on this for an untested type (`CLAS/OC`, `INTF/OI`, `TABL`, DDIC metadata objects).

---

## ActivateObjects Tool

Mass activation in one `POST /sap/bc/adt/activation` request. `handleActivateObjects.ts`. Required when several includes/programs cross-reference each other — activating one-by-one breaks on not-yet-active dependents.

```
WriteProgram(name=A, activate=false); WriteProgram(name=B, activate=false); WriteProgram(name=C, activate=false)
ActivateObjects(names=["A","B","C"])
```

**A standalone include has no master program until some source references it** — an include's `include:contextRef` populates automatically the moment any program's source contains `INCLUDE {name}.` (even while that program is itself inactive). Always write the main program's `INCLUDE` statement, not just the include's own source, before the first `ActivateObjects` call, to avoid `"Select a master program for include {name}"`.

`resolveUri()` retries via `GET /sap/bc/adt/activation/inactiveobjects` when `quickSearch` misses a just-created object (same search-index-lag class of bug as `WriteProgram`'s post-create fix) — this was previously surfacing as a confusing `"No URI-Mapping defined for URI"` HTTP 500 on the whole batch.

```xml
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="..." adtcore:name="A"/>
  ...
</adtcore:objectReferences>
```
For every resolved `PROG/P`, a second reference for its text-elements object (`/sap/bc/adt/textelements/programs/{name}`, `PROG/PX`) is appended automatically, otherwise text symbols written by `WriteProgram(activate:false)` stay inactive; SAP tolerates the extra reference when there's no text pool.

**Result classification** (`chkl:messages`, attrs `checkExecuted`/`activationExecuted`/`generationExecuted`): any `<msg type="E">` → **FAILED**. `activationExecuted="false"` alone is not failure — "nothing to activate", `OK (generation refreshed)` if `generationExecuted="true"` else `NO-OP`. Otherwise `OK`.

### `rfc_enabled` — toggling a function module's Remote-Enabled checkbox

`ActivateObjects(rfc_enabled: { [fmName]: boolean })` flips `fmodule:processingType` (`"normal"`/`"rfc"`) on the FM's own object URL (no `/source/main`). Run **sequentially**, not `Promise.all` — each cycle shares the single `sap-contextid` cookie:

1. `quickSearch` (FUGR/FF) to resolve URI + group.
2. GET current description/processingType; skip if already at target.
3. `removeCookie('sap-contextid')` → `LOCK` (stateful) → `PUT` (`application/vnd.sap.adt.functions.fmodules.v3+xml`, echoing description/containerRef) → `UNLOCK`.

Same reassignment guard as `WriteProgram`. Names in `rfc_enabled` are unioned into the mass-activation call automatically — the property change alone leaves the FM inactive. Only `normal`↔`rfc` is implemented; other `processingType` values are unverified.

---

## RunUnitTest Tool

Runs real **ABAP Unit** methods — the only ADT endpoint that actually *executes* ABAP server-side. `handleRunUnitTest.ts`.

```
POST /sap/bc/adt/abapunit/testruns
Content-Type: application/*
Accept: application/*
```
Strict content types return an empty/short response — loose `application/*` on both headers required. Single object per call:
```xml
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <external><coverage active="false"/></external>
  <options>
    <uriType value="semantic"/>
    <testDeterminationStrategy sameProgram="true" assignedTests="false"/>
    <testRiskLevels harmless="true" dangerous="false" critical="false"/>
    <testDurations short="true" medium="false" long="false"/>
    <withNavigationUri enabled="true"/>
  </options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive"><adtcore:objectReferences>
      <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/{name}"/>
    </adtcore:objectReferences></objectSet>
  </adtcore:objectSets>
</aunit:runConfiguration>
```
`risk_levels`/`durations` args map 1:1 (defaults `["harmless"]`/`["short"]`, SAP's own dialog defaults).

A `testMethod` with no `<alerts>` child passed. `alert/@kind` is `failedAssertion`/`exception` (→FAIL) or `warning` (→WARN); assertion detail (`Expected [X] Actual [Y]`) is nested arbitrarily deep under `<details><detail text="...">`, flattened depth-first; the failing line comes from the first `<stackEntry adtcore:uri="...#start={line},{col}">`.

**Trap (same class as RunATCCheck):** a nonexistent object returns the exact same empty `<aunit:runResult/>` as "no matching tests", HTTP 200, no error — `handleRunUnitTest.ts` validates via `quickSearch` first.

**Scope:** only `FOR TESTING` classes using `cl_abap_unit_assert` — there is no ADT endpoint to execute an arbitrary program and capture `WRITE` output.

---

## Secrets Keystore (opt-in alternative to plaintext `.env`)

Local dev keeps plaintext `.env` by default. `src/lib/secretStore.ts` adds an encrypted keystore tier for a deployment server that shouldn't have SAP credentials readable on disk. Design doc: `plan/secrets-keystore-pattern-nodejs.md`.

**Resolution order** (`getConfig()`), first hit wins:
1. Real process env var (set by OS/CI/MCP client config, before `dotenv.config()` runs).
2. Keystore, only if `SECRETS_KEYSTORE` is set — a total no-op otherwise.
3. `.env` file fallback.

**Files** (`secret/`, gitignored, mode 700): `keystore.key` (random AES-256 key, base64, mode 600) and `secrets.json` (`{ ALIAS: { iv, tag, ct } }`, AES-256-GCM per entry).

**Setup/rotation** (run on the server itself, in a real terminal, never through an AI tool — it reads real credentials): `node scripts/setup-secrets.js` converts `.env` to the keystore (round-trip-verifies before offering to delete `.env`); `node scripts/setup-secrets.js --rotate KEY` changes one value in place. Point the MCP client at `SECRETS_KEYSTORE=<secrets.json path>` and `SECRETS_KEYSTORE_PASSWORD_FILE=<keystore.key path>`. Server only reads the keystore at startup — reload/restart after rotation.

`getConfig()` fails loudly and synchronously at startup, naming which tier each required key resolved from.


### Connecting to a second SAP client/system

Each keystore is one fixed credential set. To reach a second client/system concurrently, run a **second `dist/index.js` process** with its own keystore:
```bash
node scripts/setup-secrets.js --env .env.800 --out secret-800
```
Then register a second MCP server entry pointing at the same build with a distinguishing name, e.g.:
```jsonc
"mcp-abap-adt-client800": {
  "type": "stdio", "command": "node",
  "args": ["/path/to/mcp-abap-adt/dist/index.js"],
  "env": {
    "SECRETS_KEYSTORE": "/path/to/mcp-abap-adt/secret-800/secrets.json",
    "SECRETS_KEYSTORE_PASSWORD_FILE": "/path/to/mcp-abap-adt/secret-800/keystore.key"
  }
}
```
Each server is a separate process with its own cookies/CSRF state and its own write-lock file (keyed by `sha1(SAP_URL|SAP_CLIENT)`, so the two never block each other). Tool names collide across servers in most clients — the server-name prefix is how you address one system vs. the other. If encryption-at-rest doesn't matter for a throwaway sandbox target, skip the keystore and put `SAP_*` directly in that server's `env` block instead — simpler, and real env always wins anyway.

---

## GetRuntimeDumps Tool (`GetDiagnostics` `resource=DUMP`)

Dual mode like `GetTransport`: no `dump_id` lists dumps; `dump_id` set drills into one dump's summary (`/sap/bc/adt/runtime/dump/{id}[/{type}]` — singular "dump", plural 404s).

**Always `decodeURIComponent` the `dump_id` before re-encoding it**, regardless of whether it arrived as a bare id, a still-percent-encoded bare id (the natural result of copying the list output's trailing segment, which embeds literal `%20` for SAP's space-padded host/user/client fields), or a full path. Skipping this on the "no prefix" branch used to double-escape `%20`→`%2520`, corrupting ids copied straight from the tool's own list output.

---

## GetGatewayErrorLog Tool (`GetDiagnostics` `resource=GW_ERRORLOG`)

```
GET /sap/bc/adt/gw/errorlog
Accept: application/atom+xml;type=feed
```
The SAP Gateway Error Log (same feed Eclipse ADT's monitoring view reads) — OData/Gateway service errors (missing services, binding failures, backend exceptions), a failure class none of this toolset's other getters reach (`GetRuntimeDumps` only sees ABAP short dumps). `handleGetGatewayErrorLog.ts`, dual mode: no `entry_id` lists the current buffer; `entry_id` set re-fetches the list and picks the matching entry (no dedicated per-entry endpoint, unlike `GetRuntimeDumps`).

**No working filter/pagination** — `?username=`/`?maxResults=`/`?top=` are all silently ignored (byte-identical response); the endpoint just returns its full current (short-lived) buffer every time.

**`atom:summary` is HTML double-escaped inside XML text** (unlike a runtime dump's own `/summary`, served as real `text/html`). Run a local `decodeEntities()` pass first, *then* the shared `stripHtml()` — calling `stripHtml()` directly on the raw text is a no-op since its tag regexes don't match the still-escaped `&lt;style&gt;` etc.

Discovered via `GET /sap/bc/adt/feeds`, a catalog of 7 monitoring-feed sources; the other six (`eee/errorlog`, `error/urimapper`, `atc/feeds/verdicts`, `bo/feeds/ccviolations`, `runtime/systemmessages`, and `runtime/dumps` which is already covered) were empty at test time and left unwired — re-probe live if one becomes populated rather than shipping an unverified shape.

---

## RunATCCheck Tool

Runs an **ABAP Test Cockpit** check over one or more **transport requests**. `handleRunATCCheck.ts`.

```
1. GET  /sap/bc/adt/cts/transportrequests/{n}   per transport — 404 → reported missing, not a silent 0-finding pass
2. GET  /sap/bc/adt/atc/customizing              → default checkVariant (unless supplied)
3. POST /sap/bc/adt/atc/worklists?checkVariant={v} → plain-text worklistId
4. POST /sap/bc/adt/atc/runs?worklistId={id}     → <atc:run> with one objectReference per transport, returns "E,W,N"
5. GET  /sap/bc/adt/atc/worklists/{id}           → full findings XML
```
```xml
<atc:run xmlns:atc="http://www.sap.com/adt/atc" maximumVerdicts="100">
  <objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive">
    <adtcore:objectReferences><adtcore:objectReference adtcore:uri="/sap/bc/adt/cts/transportrequests/{NUMBER}"/></adtcore:objectReferences>
  </objectSet></objectSets>
</atc:run>
```

**Traps:** a bad object reference is silently dropped (`0,0,0`, no error) — step 1 validates transports up front so a typo doesn't look like clean code. Multiple transports must go in a **single** run call — re-running against the same `worklistId` replaces the prior objects. An invalid `checkVariant` is silently accepted (SAP falls back to default). Findings point at sub-includes, not the container (`atcfinding:location`'s segment before `/source/main`, line/col in `#start=`). Priority 1=Error/2=Warning/3=Note; `isError` only on a priority-1 finding.

**`scope="transport"` (default)** filters out pre-existing debt in untouched siblings of the same compilation unit (a function group's other FMs, etc.) — resolves each transport's registered objects and keeps only findings on those. Falls back to unfiltered (`scope="full"`) if the object-name set comes back empty, rather than risk hiding real findings.

### Background mode (`background=true` + `output_file`) — shared across tools

`src/lib/background.ts` (`maybeBackground`) wraps a handler whose core resolves to the standard single-text-block result:
```typescript
export async function handleGetWhereUsed(args: any) {
    return maybeBackground(args, `Where-used for ${name}`, `whereused-${name}`, () => getWhereUsedCore(args));
}
```
Default: `await core()`, persist to `output_file` if given. `background:true`: writes an `IN PROGRESS` placeholder, launches `core()` unawaited, returns instantly (~15ms) with a `"started → read <path>"` response; the file is updated with the result (or error) when it settles. Exists because some MCP clients enforce short `tools/call` timeouts regardless of server-side timeout settings.

**Opted in:** `RunATCCheck`, `RunUnitTest`, `GetEnhancements` (`scan_all=true`), `GetWhereUsed`, `GetPackage`, `DataPreview`. Single-GET getters return in 1–2s and don't self-wrap, but `GetCode`/`GetMeta` (which spread `backgroundSchemaProps` into their whole schema) wrap every resource that doesn't self-wrap — so `output_file`/`background` are honored there too. `GetDiagnostics` doesn't advertise the props, so its resources stay unwrapped. `WriteProgram`/`ActivateObjects` deliberately don't opt in — a fire-and-forget "started" reply would hide whether a write/activation actually succeeded.

---

## Text Elements (TEXT-XXX symbols, selection texts, list headings)

A **separate ADT object** (`REPT`/`PROG/PX`) from the main source, under a different lockable resource — the main program's lock handle doesn't grant write access here.

| Category | URL suffix | Accept/Content-Type |
|----------|-----------|--------------------------|
| Text symbols | `/source/symbols` | `application/vnd.sap.adt.textelements.symbols.v1` |
| Selection-screen texts | `/source/selections` | `application/vnd.sap.adt.textelements.selections.v1` |
| List headings | `/source/headings` | `application/vnd.sap.adt.textelements.headings.v1` |

Without the right `Accept`, SAP returns 406. Discover the root URL via the object's own `atom:link rel=".../textelements"`.

```
# symbols (KEY is 3 chars: 001-999 or F01/M01-style)
@MaxLength:30
001=Header Material(GA/SA)
# selections (param name padded to 8 chars)
P_BATCH =Production Batch
# headings
listHeader=My Report
```

**Read** (`handleGetObject.fetchProgramWithSymbols`): fetches source + all three categories in parallel; empty/stub categories are silently skipped; failures non-fatal. **SAP's text-elements endpoint always returns master language**, regardless of `sap-language`/locale overrides.

**Write** (`handleWriteProgram` step 2b): all three subobjects share **one** lock on the parent `/sap/bc/adt/textelements/programs/{name}` URL (coexists with the main-program lock in the same session). Text-element failure is non-fatal — main source is already written.

**Activation** needs a second `<adtcore:objectReference>` for the `PROG/PX` object whenever any category was written, or the text pool stays inactive despite a successful source activation.

---

## GetEnhancements Tool

Reads source-code enhancements. `handleGetEnhancements.ts`. Three auto-detected modes:

1. **Enhancement implementation** (`ENHO/*`) — source at `.../source/main`; reverse lookup its own metadata XML for host function group/include/enhancement spot.
2. **Single object with enhancements attached** — `GET {uri}/source/main/enhancements/elements?options=withsource:{X|}` (headers `Content-Type`/`Accept: */*`; **not** `/source/main/enhancements`, which 404s). `<enh:source>` is base64 — decode with `Buffer.from(text, 'base64').toString('utf8')`.
3. **Function group** (`FUGR/F`, or `FUGR/I` named `SAPL*`) — default: lightweight search for `L{group}*` to list includes. `scan_all=true`: concurrency-limited fan-out (5 parallel, 10s timeout each), capped at `max_includes` (default 100; e.g. `COKO1` has 3,359 includes).

```typescript
function detectFunctionGroup(objInfo: ObjectInfo): string | null {
    if (objInfo.type.toUpperCase() === 'FUGR/F') return objInfo.uri.match(/\/groups\/([^\/]+)/i)?.[1]?.toUpperCase() ?? objInfo.name;
    if (objInfo.type.toUpperCase() === 'FUGR/I' && objInfo.name.toUpperCase().startsWith('SAPL')) return objInfo.name.slice(4);
    return null;
}
```

---

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
ADT_ENDPOINTS.md      # SAP ADT REST API reference
```

`src/index.ts` exports `mcp_abap_adt_server` and `getConfig()`/`SapConfig`. Config resolves (process env / keystore / `.env`, in that order) for `SAP_URL`, `SAP_USERNAME`, `SAP_PASSWORD`, `SAP_CLIENT` (required), `SAP_LANGUAGE` (optional — adds `sap-language` header; honored for DDIC/message-class text, not text-elements). Restart/`/mcp` reload after changing any of these.

`SAP_MAX_CONCURRENT_REQUESTS` (default 6) caps `makeAdtRequest`'s concurrency semaphore. `QUERY_CACHE_TTL_MS` (default 180000) controls `queryCache.ts`'s TTL.

Tests in `src/index.test.ts` are live integration tests against the real SAP system, needing a valid `.env`.

**Tests must never touch other people's objects.** Write/lock tests use dedicated anchors only: `$TMP` objects (`ZMCP_*`), and for anything that needs a transportable object, an intentionally empty class (default `ZCL_MCP_TRANSPORT_E2E` in package `ZMCP`; override with `MCP_TEST_ANCHOR_CLASS` / `MCP_TEST_ANCHOR_PACKAGE`) that you create once. `complex.test.ts`'s transport lifecycle creates a transport for that anchor and **deletes** it at the end; releasing it is opt-in (`MCP_TEST_RELEASE=1 npm test`), because a released transport can't be deleted.
