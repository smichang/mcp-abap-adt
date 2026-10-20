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
| `GetCode` | `OBJECT` | Source of program, include, class, interface, function module, table, structure, data element, domain, CDS | `objects=["A",{"object_name":"B","kind":"TABL"}]` reads up to 10 objects in parallel, one section each; `kind` hint skips auto-detection; `function_group` needed for `kind=FUNC`; a miss runs a "did you mean" search; `class_include=testclasses\|implementations\|definitions\|macros` reads a class's local include (read twin of `WriteProgram class_include`); for programs `text_elements=false` returns source alone, `only` just the text blocks |
| | `VERSION` | Version history / old source / diff | list without `version`; `version` for old source; `compare_to` for a unified diff; for classes `class_include` selects `main`/`definitions`/`implementations`/`macros`/`testclasses` (history is per include). Local objects keep one SAP version, but each `WriteProgram` saves the text it replaces: use `version=snapshot:<id>`/`snapshot:latest` or `compare_to=snapshot:<id>` |
| | `SYNTAX` | Syntax-check an existing object | `object_name` (+ `object_type`); checks the current source (inactive working version included), returns `E/W line:col — text`; read-only, no SLIN/ATC; objects without source (DTEL, DOMA, FUGR) are refused |
| | `WHEREUSED` | Where-used list | `object_name` + `object_type`; `max_results`/`offset`; cached ~3 min; a very widely used object that exceeds the 60 s window continues in the background and returns an output-file path — read it, then page with `offset` |
| | `ENHANCEMENTS` | Enhancement implementations / per-object list / function-group scan | `scan_all=true` fans out and is capped by `max_includes` |
| | `DYNPRO` † | Classic screens | `object_name` = program (`SAPL<group>` for a function group); no `dynnr` lists screens; `dynnr` shows attributes, elements, flow logic; `raw=true` full JSON; `dynnr` + `language` lists translatable texts |
| `GetMeta` | `PACKAGE` | Package contents | paged (`max_results`, `offset`), cached |
| | `TYPEINFO` | Table / structure fields | use to verify `SELECT` columns |
| | `DDIC` | CDS / data element / domain detail | `object_type` selects which |
| | `TRANSACTION` | Tcode → program, package | |
| | `TRANSPORT` | List a user's transports or inspect one (tasks + objects); with `object_name` (+ `type_hint`): who holds this object, no lock | paged, cached |
| | `MESSAGE_CLASS` | Texts of an SE91 class, paged (`max_results` default 200, `offset`); optional `language` (ISO) reads a translation, shows the true master language, refuses a language without texts | |
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
Do not use background mode for writes. A result over 20,000 characters written with `output_file` is not also returned inline: you get the first 30 lines plus path, size and line count.

## Write tools

| Tool | What it does | Traps |
|---|---|---|
| `WriteProgram` | Create/overwrite programs, includes, classes, function modules (and function groups, create-only); text elements; `transport_description` auto-creates a titled transport for a new object | Accepts `source_file` (preferred) or `source_code`. Create needs `description` + `package_name`. FM source carries its signature inline (`FUNCTION f IMPORTING … .`); no `*"` comment blocks; `TABLES` params must be `LIKE <DDIC structure>`. A class's `source_code` is the full definition + implementation. Physical lines > 255 chars are rejected. `check_only=true` syntax-checks new source against an existing object (no lock/write, returns `line:col — text`); `syntax_check=true` does it before the lock and refuses the write on errors (default off). Includes are checked in their master program's context; "include checked ALONE" means errors against the master can be missed. **Change an existing object with `edits=[{old_string,new_string,replace_all?}]`** instead of resending source: unique exact anchor, atomic, max 20, not with `source_code`; a passing `check_only` dry run prints `apply_patch="p-…"` to apply without resending. **`object_type=INTF`** creates interfaces. **`class_include`** (`testclasses`/`implementations`/`definitions`/`macros`) writes a class's local parts (unit tests, local classes/types) — never paste `FOR TESTING` classes into the main source; the class is syntax-checked with the new include before the lock (first write of a new include is `NOT CHECKED`). Each write keeps the replaced text as a local snapshot |
| `ManageDDIC` | Structures, table types, data elements, domains, CDS views (`create`/`update`) | Descriptions of table types and domains cannot be read back after creation, so `update` rejects `description`. No delete — use `DeleteObject` |
| `ManageMessageClass` | SE91 classes and messages (`create`/`update`/`delete`) | `update` upserts messages in one language (master by default, or `language`); deleting messages is separate (`delete_messages`, all languages). Long texts cannot be written through ADT |
| `ActivateObjects` | Mass activation in one request; `rfc_enabled` toggles an FM's Remote-Enabled flag | A standalone include needs a program that `INCLUDE`s it before the first activation |
| `ManageTransport` | `create`, `release`, `set_text`, `delete`, `add_task`, `assign_object`, and † `move_object`, `merge`, `remove_object` | Release returns HTTP 200 even when aborted — read the report. `delete` only works on a transport with no object entries. `assign_object` works for PROG/CLAS/INTF/FUGR/INCL/TABL/DTEL/DOMA/DDLS only and silently reassigns an object from another transport |
| `UnlockObject` | Recover a stuck edit lock | Tries LOCK then releases it; reports transport (`CORRNR`) and the lock holder. A name shared by several types needs `object_type`. Without `force` it cannot clear a lock held by a live or orphaned session. `force=true` † deletes the connecting user's **own** SM12 entries matching the object through `default_host/zmcp/lock_admin` (never another user's; a live GUI/Eclipse lock of your own would go too, so ask first and close your own editors); run `UnlockObject` again without force to confirm. See `recovery.md` |
| `ManageSessions` † | `list` / `end` the connection user's **own** ABAP sessions (SM04) on every application server | `list` prints `server:tid`, kind (`HTTP`/`GUI`/…), client IP, logon time, age. `end` needs `ids` (no "end all"); it refuses the current session, non-HTTP kinds and sessions younger than `min_age_minutes` (default 2). Ids are slot numbers that are reused at once — use an id from the latest list. Your own open Eclipse sessions look like stale ones: end only ids you recognize. Stateful requests leave sessions, plain reads do not. `still there` means the same session (same logon time and terminal) is still listed — check SM04 |
| `DeleteObject` | Delete a repository object | Destructive. `object_names[]` deletes up to 20 in the given order (dependents first, package last); a failure doesn't stop the rest. Verified on program, function module, domain and the five `ManageDDIC` types; confirm other types on a disposable object first |
| `TextPoolLang` † | Read/write a program's text pool in an explicit language | Merges per id+key; `delete_keys` removes a row (an empty value blanks it) |
| `ManageAuthObject` † | Create/update an SU21 authorization object, fields and `ACTVT` activities | Fields lock once code or roles use the object (409); define the full field list first. No delete |
| `ManageDynpro` † | Create/update/delete/check a classic screen of a customer program; `translate` writes target-language texts (`language` + `translations`) | Write the program's modules first; a result with consistency errors means the screen **is saved** — fix the program, then `action=check` |
| `ManageSicfNode` † | `ping`, `create_sicf_node`, `delete_sicf_node` under `default_host/zmcp` | See `abap-tasks/README.md`. A node's *Alternative Logon Procedure* is `ICFSERVICE-LOG_FLAG = 'X'` together with `LOGIN_PROCESS = 'L'` — `'L'` alone still shows *Standard* in SICF; check with `DataPreview SELECT * FROM icfservice WHERE icfparguid = '<zmcp node guid>'`. Error texts of the dispatcher and the text pool need message classes `ZMCP_DISPATCH` / `ZMCP_TEXTPOOL`; without them errors read `I:ZMCP_DISPATCH:001 …`. Identical repeated `GET`s can be served from a cache — change the probe input to see a new text |

## Test and quality tools

| Tool | Notes |
|---|---|
| `RunUnitTest` | One class/program per call; defaults to harmless risk / short duration. Returns PASS/FAIL per method with expected/actual and line. A nonexistent object is validated first (SAP would return an empty "no tests" result) |
| `RunATCCheck` | Exactly ONE target: `transport_numbers` (default `scope="transport"` hides findings in untouched siblings), `objects` (object or **package** names, max 20) or `worklist_id` (re-read an earlier run). Every report prints a `Verdict: PASS/FAIL` line — gate on that, not `isError` (`fail_on_error=true` makes priority-1 findings `isError`). Findings sorted errors → warnings → notes and paged with `offset`/`limit` (default 200); re-call with the worklist id instead of re-running. A typo'd transport or unknown worklist id is refused |
| `RunABAP` | `object_name` (+ `object_type` `CLAS`/`PROG`). `CLAS` must implement `IF_OO_ADT_CLASSRUN` and returns its output; `PROG` runs the report with selection-screen defaults. It really executes and may change data: a class outside a `$` package and any report need `confirm_side_effects=true`. Output capped by `max_chars` (default 20000). Not for unit tests |
| `ManagePackage` | `create` (`package_name`, `description`, `software_component`, `transport_number` unless `$`, optional `super_package`/`package_type`/`transport_layer`/`application_component`) or `update` (patches only the fields passed; refuses a different transport). Delete with `DeleteObject object_type=DEVC`; a deleted transportable package leaves a locked entry — `ManageTransport remove_object` first |

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
