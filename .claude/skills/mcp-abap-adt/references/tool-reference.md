# Tool reference

Authoritative schemas are in `src/index.ts` (or ask your MCP client for the tool list).
This file adds what the schemas do not say. Tools marked † need the optional ABAP-side
endpoint from `abap-tasks/README.md`.

## Read tools

The read tools are three dispatchers with a required `resource` argument plus that
resource's own fields.

| Tool | `resource` | Use | Notes |
|---|---|---|---|
| `SearchObject` | — | Find objects by name | `query` with `*`; optional single `object_type` (`PROG`, `CLAS`, …); not paged — narrow the query |
| `GetCode` | `OBJECT` | Source of program, include, class, interface, function module, table, structure, data element, domain, CDS | `kind` hint skips auto-detection; `function_group` needed for `kind=FUNC`; a miss runs a "did you mean" search |
| | `VERSION` | Version history / old source / diff | list without `version`; `version` for old source; `compare_to` for a unified diff; for classes `class_include` selects `main`/`definitions`/`implementations`/`macros`/`testclasses` (history is per include) |
| | `WHEREUSED` | Where-used list | `object_name` + `object_type`; `max_results`/`offset`; cached ~3 min |
| | `ENHANCEMENTS` | Enhancement implementations / per-object list / function-group scan | `scan_all=true` fans out and is capped by `max_includes` |
| | `DYNPRO` † | Classic screens | `object_name` = program (`SAPL<group>` for a function group); no `dynnr` lists screens; `dynnr` shows attributes, elements, flow logic; `raw=true` full JSON |
| `GetMeta` | `PACKAGE` | Package contents | paged (`max_results`, `offset`), cached |
| | `TYPEINFO` | Table / structure fields | use to verify `SELECT` columns |
| | `DDIC` | CDS / data element / domain detail | `object_type` selects which |
| | `TRANSACTION` | Tcode → program, package | |
| | `TRANSPORT` | List a user's transports or inspect one (tasks + objects) | paged, cached |
| | `MESSAGE_CLASS` | All texts of an SE91 class; optional `language` (ISO) reads a translation, shows the true master language, refuses a language without texts | |
| | `INACTIVE_OBJECTS` | What your user has written but not activated | no params |
| `GetDiagnostics` | `DUMP` | Short dumps | list (user/date/category) or `dump_id` |
| | `TRACE` | SAT / SQL traces | list or `trace_id` |
| | `GW_ERRORLOG` | Gateway (OData/Fiori) error log | the only tool reaching OData-layer errors |
| `DataPreview` | — | Table data / freestyle SQL | cannot reference `MANDT`; no explicit column list without table qualifier; use `max_rows` instead of `UP TO n ROWS`. A column list needs an alias and `~`: `SELECT t~a, t~b FROM tab AS t WHERE t~k = '…'` (`tab~a` without alias fails with `"." is invalid here`); `OR` works; a very long `IN ('…','…')` list can fail with "text literal longer than 255 characters" — use several short conditions or `LIKE`; joins to text tables with extra literals can fail with `"TABLE" is invalid here`, so run two simple queries. `SELECT *` works and is the quickest way to inspect an unfamiliar table; with `output_file` the full result goes to a file |

Cached results (`PACKAGE`, `WHEREUSED`, `TRANSPORT`, `DUMP`, `TRACE`) are marked
`[cached]` and may be ~3 minutes stale; page with `offset` instead of raising `max_results`.

Long-running reads (`RunATCCheck`, `RunUnitTest`, `GetCode WHEREUSED/ENHANCEMENTS`,
`GetMeta PACKAGE`, `DataPreview`) accept `background=true` + `output_file` for clients
with short tool timeouts: the call returns immediately and the file is filled later.
Do not use background mode for writes.

## Write tools

| Tool | What it does | Traps |
|---|---|---|
| `WriteProgram` | Create/overwrite programs, includes, classes, function modules (and function groups, create-only); text elements; `transport_description` auto-creates a titled transport for a new object | Accepts `source_file` (preferred) or `source_code`. Create needs `description` + `package_name`. FM source carries its signature inline (`FUNCTION f IMPORTING … .`); no `*"` comment blocks; `TABLES` params must be `LIKE <DDIC structure>`. A class's `source_code` is the full definition + implementation. Physical lines > 255 chars are rejected |
| `ManageDDIC` | Structures, table types, data elements, domains, CDS views (`create`/`update`) | Descriptions of table types and domains cannot be read back after creation, so `update` rejects `description`. No delete — use `DeleteObject` |
| `ManageMessageClass` | SE91 classes and messages (`create`/`update`/`delete`) | `update` upserts messages in one language (master by default, or `language`); deleting messages is separate (`delete_messages`, all languages). Long texts cannot be written through ADT |
| `ActivateObjects` | Mass activation in one request; `rfc_enabled` toggles an FM's Remote-Enabled flag | A standalone include needs a program that `INCLUDE`s it before the first activation |
| `ManageTransport` | `create`, `release`, `set_text`, `delete`, `add_task`, `assign_object`, and † `move_object`, `merge`, `remove_object` | Release returns HTTP 200 even when aborted — read the report. `delete` only works on a transport with no object entries. `assign_object` works for PROG/CLAS/INTF/FUGR/INCL/TABL/DTEL/DOMA/DDLS only and silently reassigns an object from another transport |
| `UnlockObject` | Recover a stuck edit lock | Tries LOCK then releases it; reports transport (`CORRNR`) and the lock holder. A name shared by several types needs `object_type`. Without `force` it cannot clear a lock held by a live or orphaned session. `force=true` † deletes the connecting user's **own** SM12 entries matching the object through `default_host/zmcp/lock_admin` (never another user's; a live GUI/Eclipse lock of your own would go too, so ask first and close your own editors); run `UnlockObject` again without force to confirm. See `recovery.md` |
| `ManageSessions` † | `list` / `end` the connection user's **own** ABAP sessions (SM04) on every application server | `list` prints `server:tid`, kind (`HTTP`/`GUI`/…), client IP, logon time, age. `end` needs `ids` (no "end all"); it refuses the current session, non-HTTP kinds and sessions younger than `min_age_minutes` (default 2). Ids are slot numbers that are reused at once — use an id from the latest list. Your own open Eclipse sessions look like stale ones: end only ids you recognize. Stateful requests leave sessions, plain reads do not. `still there` means the same session (same logon time and terminal) is still listed — check SM04 |
| `DeleteObject` | Delete a repository object | Destructive. Verified on program, function module, domain; confirm other types on a disposable object first |
| `TextPoolLang` † | Read/write a program's text pool in an explicit language | Merges per id+key; `delete_keys` removes a row (an empty value blanks it) |
| `ManageAuthObject` † | Create/update an SU21 authorization object, fields and `ACTVT` activities | Fields lock once code or roles use the object (409); define the full field list first. No delete |
| `ManageDynpro` † | Create/update/delete/check a classic screen of a customer program | Write the program's modules first; a result with consistency errors means the screen **is saved** — fix the program, then `action=check` |
| `ManageSicfNode` † | `ping`, `create_sicf_node`, `delete_sicf_node` under `default_host/zmcp` | See `abap-tasks/README.md`. A node's *Alternative Logon Procedure* is `ICFSERVICE-LOG_FLAG = 'X'` together with `LOGIN_PROCESS = 'L'` — `'L'` alone still shows *Standard* in SICF; check with `DataPreview SELECT * FROM icfservice WHERE icfparguid = '<zmcp node guid>'`. Error texts of the dispatcher and the text pool need message classes `ZMCP_DISPATCH` / `ZMCP_TEXTPOOL`; without them errors read `I:ZMCP_DISPATCH:001 …`. Identical repeated `GET`s can be served from a cache — change the probe input to see a new text |

## Test and quality tools

| Tool | Notes |
|---|---|
| `RunUnitTest` | One class/program per call; defaults to harmless risk / short duration. Returns PASS/FAIL per method with expected/actual and line. A nonexistent object is validated first (SAP would return an empty "no tests" result) |
| `RunATCCheck` | One or more transports in a single call; `scope="transport"` (default) hides findings in untouched siblings. A typo'd transport is reported as missing rather than "0 findings". `isError` only on priority-1 findings |

## Transport workflow

1. Existing request for the object? `UnlockObject` shows `CORRNR`/`CORRTEXT` regardless of owner.
2. None suitable → `ManageTransport action=create` (give `object_type` + `object_name` to
   have the path built for you, and a meaningful description — SAP's auto-generated
   "Generated Request for Change Recording" cannot be renamed after release).
3. `WriteProgram transport_number=…` (or ManageDDIC / ManageMessageClass).
4. `RunATCCheck` on the transport, fix findings, then `ManageTransport action=release`
   only with the user's approval.

## Writing a class — a safe sequence

1. Create the full source in a disposable `$TMP` class and activate it (proves it compiles).
2. Write the same file to the real package with the transport.
3. If first activation fails, correct the full source and write again while the
   inactive object exists; do not create a second shell.

## Raw ADT endpoints

For anything not wrapped by a tool see `docs/ADT_ENDPOINTS.md`. Probing rules: use
stateless requests only (a stateful request opens an ABAP session that lingers until
timeout unless a matching UNLOCK ends it), compare responses by `md5sum` to detect
silently ignored parameters, and never trust the status code alone.
