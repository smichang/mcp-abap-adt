# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.11.0] - 2026-10-20

### Added
- **`GetMeta resource=TRANSPORT object_name=…` — who holds this object?** Read-only ADT `POST /cts/transportchecks`, **no lock**. Verdict `LOCAL` / `FREE` / `HELD_BY_SELF` / `HELD_BY_OTHER` with the holder's request, task and owner (or your own open requests when free). Replaces the `UnlockObject` probe as the pre-write check. Optional `type_hint` disambiguates a shared name. Function modules are checked against the CTS lock table, because ADT reports every function module as free.
- **`ManageDynpro action=translate` + `GetCode DYNPRO dynnr language`** — language-dependent screen texts (what SE63 does for a Dynpro) through the new standalone endpoint `default_host/zmcp/dynpro_transl` (`ZCL_HTTP_MCP_DYNPRO_TRANSL` → `ZCL_MCP_DYNPRO_TRANSL`, `abap-tasks/zmcp-dynpro-transl/`). Everything is validated first; either all texts are written or none. The texts are not on a workbench request; they travel with SE63's translation transport.
- **`GetCode OBJECT` of a function module** also shows its processing type (normal / RFC / update), last change and release state; `output_file` still writes the source only.
- **`WriteProgram overwrite`** (default false) — see Changed.

### Changed
- **`WriteProgram` never replaces an existing object through its create parameters.** `description` / `package_name` on a name that already exists is refused before any lock unless `overwrite=true`. An update of an existing object reports `UPDATED (object already existed)`.
- **Reassignment guards** in `WriteProgram`, `DeleteObject` and `ActivateObjects(rfc_enabled)` accept the holder's request or any of its tasks as `transport_number`.
- `GetMeta INACTIVE_OBJECTS` shows each object's responsible user and package, and warns when the inactive version sits on someone else's object.
- `ManageSicfNode` description says it is for the gateway's own endpoints only.

### Fixed
- `output_file` / `background` were silently ignored by `GetCode SYNTAX` and every `GetDiagnostics` resource.
- `GetCode` no longer marks `object_name` as required in its schema, so an `objects[]` batch is not rejected by the client.
- `GetCode OBJECT` on an enhancement implementation returns its source; other unsupported types name the tool that reads them. `GetCode DYNPRO` on a selection screen explains it is generated from the source.
- `type_hint` / `object_type` `INCL` also matches function-group includes (`FUGR/I`).

## [3.10.0] - 2026-10-15

### Added
- **`apply_patch` works with `class_include`.** A passed `edits[]` dry run on a class's local include returns an `apply_patch` id; applying it re-applies the edits to the then-current include without sending them again. The id is bound to one class and one include (refused for another include, for the class's main source, or combined with `edits`/`source_*`).
- **`GetCode OBJECT class_include`** — read a class's local include (`testclasses` | `implementations` | `definitions` | `macros`) as stored; the read twin of `WriteProgram class_include`. A missing include and a non-class are clear errors.
- **`WriteProgram class_include` is syntax-checked before the lock.** The class is checked with the new include text in place (`/checkruns`, artifact `…/includes/<inc>`); errors in the include itself refuse the write ("Nothing was locked or written"), errors elsewhere in the class are listed without blocking. On by default (`syntax_check=false` opts out, `check_only=true` reports only). Live-verified: a broken `testclasses` include is reported as `ZCL_… (testclasses)`, left unchanged on SAP, and written only with the opt-out.
- **`GetCode WHEREUSED` no longer fails on very widely used objects.** A synchronous call that runs into the 60 s request timeout (e.g. `IF_MESSAGE`: 47,828 usages) continues automatically in the background with a 10-minute timeout and returns the output-file path; `background=true` uses the long timeout from the start. Other failures are still errors.
- **`WriteProgram object_type=INTF` creates interfaces** (they could only be read before): `POST /oo/interfaces`, full `INTERFACE … ENDINTERFACE.` source, same lock → PUT → activate flow. Live-verified with an implementing class that runs.
- **List cache cleared on writes.** After `ManageDynpro delete`, `GetCode DYNPRO` still listed the screen as `[cached]`; `makeAdtRequest` now empties the list cache on any write (read-only POSTs excluded), as the quickSearch cache already did.
- **`GetMeta MESSAGE_CLASS` is paged** (`max_results` default 200, `offset`; truncation flagged with the next-page call) — class `00` returned all 927 messages (~35 KB) every time.
- **`src/objecttypes.test.ts`** — 38 live tests across interface, function group/module, DDIC chain (domain → data element → structure → table type → CDS view), message class, Dynpro, text pool, transport, plus a read matrix over 21 standard-object reads.
- **`DeleteObject object_names[]`** — delete up to 20 objects in one call, in the order given (program before its includes, package last); per-object ✓/✗ result, a failure doesn't stop the rest. The transport-record note is now printed only when a transport was involved (it was noise for `$TMP` objects).
- **`WriteProgram class_include`** (`testclasses` | `implementations` | `definitions` | `macros`): write a class's local includes — unit tests, local classes/types/macros — which could not be written at all (the splitter rejects them in the main source). Creates the include if needed, under the class lock; `source_code` / `source_file` / `edits[]`; activates the class; snapshots the replaced text. Live-verified: create + green test, patch to red with a readable failure, fix to green.
- **`WriteProgram apply_patch=<id>` — apply a passed dry run without re-sending the edits.** A passed `edits[]` + `check_only` dry run returns an id; applying it re-uses the validated edits (re-applied to the then-current source through the normal patch path). In memory, 15 minutes, bound to the object.
- **Local pre-write snapshots + `GetCode VERSION snapshot:<id>`.** `WriteProgram` keeps the text each write replaces (temp dir, per connection, 15 per object; `WRITE_SNAPSHOTS=0` disables) so a local `$TMP` object — whose SAP history is a single version — can still be diffed (`compare_to=snapshot:<id>` / `snapshot:latest`) and recovered. The version list shows them.
- **Activation messages show their real line.** SAP reports `line 1`/`line 2`; `WriteProgram` and `ActivateObjects` now append `→ real position per syntax check: line 1693:4` by matching the message to the object's syntax check.
- **`GetCode OBJECT text_elements`** (programs): `true` default (source + text symbols/selection texts/headings appended as comment blocks), `false` (source only — clean text to patch, diff or write back), `"only"` (just the bare blocks in `WriteProgram`'s `text_symbols`/`selection_texts`/`list_headings` format). A clone no longer needs a script to split them.
- **`GetCode resource=SYNTAX` — syntax-check an existing object.** Reads the object's current source (the inactive working version if there is one) and runs the ADT check run on it: `E/W line:col — text`, `isError` on errors, nothing locked or written. The read-only counterpart of `WriteProgram check_only`, which needs the source passed in. Objects without `/source/main` (data elements, domains, function groups) are refused clearly. Live-verified: clean, saved-inactive error `3:8 Field "LV_UNDEFINED" is unknown`, unknown name, data element.
- **`RunATCCheck` checks objects and packages, and re-reads worklists.** New `objects[]` (max 20 names or packages; unresolved names are reported, never silently dropped) and `worklist_id` (fetch an earlier run's findings with no new ATC run), plus `offset`/`limit` paging (default 200) over a globally priority-sorted list — errors, then warnings, then notes across all objects. Every report states its worklist id and the exact next-page call. Exactly one target is required. An unknown worklist id (SAP answers 200 with an all-zero empty worklist) is refused instead of reading as "No findings". Live-verified on `ZMCP` (2,083 findings, 65 warnings) with the transport mode unchanged.
- **`RunABAP` — execute a class or report and get its output.** `CLAS` runs a class implementing `IF_OO_ADT_CLASSRUN` (`POST /sap/bc/adt/oo/classrun/{class}`), `PROG` runs an executable report with its selection-screen defaults (`POST …/programs/programrun/{program}`). The object is resolved first (a typo is an error, not an empty run); a report needs `confirm_side_effects=true`; output is capped by `max_chars`. A class without the classrun interface answers HTTP 200 with `Error: …` in the body — reported as an error with a hint. Live-verified on `$TMP` objects.
- **`ManagePackage` — create / update an ABAP package.** `create` (`software_component`, `transport_number` unless `$`, optional `super_package`/`package_type`/`transport_layer`/`application_component`; `responsible` defaults to the connection user, which SAP requires); `update` locks, patches only the fields passed (description, software component, layer, application component, super package), writes and unlocks, behind the stateful gate, with the transport-reassignment guard. Deleting a package already works through `DeleteObject object_type=DEVC` (live-verified). Live-verified on a `$TMP` and a transportable (`ZMCP`-child) package, incl. a refused wrong-transport update.
- **`WriteProgram` patch mode — `edits[]` (`old_string` → `new_string`, `replace_all?`).** Change part of an existing object without sending its whole source: 59 bytes instead of 48,856 for a one-line change to a 1,500-line program (wall time about equal). Exact match, exactly-once unless `replace_all`, ordered, atomic (any failing edit → nothing locked or written); a miss explains itself (other whitespace/case, end of source without line break, only first line matches). The source is read from SAP (the inactive working version if there is one), re-read after the lock and the edits re-applied if it changed meanwhile (aborting cleanly if they no longer apply). Works with `check_only` (dry run), `syntax_check`, `activate=false`, transports and text elements; max 20 edits; existing objects only; not for `FUGR`. Engine `src/lib/sourcePatch.ts`; 46 unit tests, 27 live tests (incl. a payload benchmark and injected concurrent changes), and a Sonnet black-box eval: ambiguity errors show surrounding lines, failed activations say the source is saved but INACTIVE, the line summary counts only changed lines.
- **`GetCode resource=OBJECT` batch read — `objects[]`.** Up to 10 objects in one call, fetched in parallel (each entry a name or `{ object_name, kind?, function_group? }`; other args are shared defaults). Output is one `===== NAME =====` section per object; a failing object is reported in place and does not hide the others (`isError` only if all fail); more than 10 is refused. Live-verified: class + table + a nonexistent name, and the 11-entry refusal.

### Fixed
- **`RunATCCheck fail_on_error`** (opt-in, default false): a run that finds priority-1 findings is also returned as `isError`, for scripts/CI that gated on it before the verdict-line change; the verdict wording says so.
- **`RunABAP` no longer runs any class unconfirmed.** A class that implements the classrun interface can do anything — SAP ships demo classes that write data. A class in a local `$` package still runs without ceremony; a class anywhere else (transportable, standard) now needs `confirm_side_effects=true`, like a report. An undeterminable package asks too.
- **The class-include pre-check no longer reports a false "clean" for a not-yet-existing include.** SAP cannot compile an include before it exists (a new `testclasses` include passed with "0 errors" for source with an undefined variable). The tool now says `NOT CHECKED … errors will show at activation`, `check_only` answers the same, and from the second write on the check is real. Found by the post-release review; live-verified (first write → activation error → pre-checked retry → fix → green test).
- **A refused first write no longer leaves an empty class shell** (deleted again under the lock; the error says so).
- **Source-splitter error names the real cause** (local class / `FOR TESTING` in the main source) and points at `class_include`.
- **Snapshots show in the class version overview** (it returned before building the section) and per class include.
- **Syntax-check messages name their unit** when it is not the checked object (`MAIN line 5:3` instead of a bare `line 8:10` for a 3-line include).
- **Syntax check of an include now runs in its master program's context.** `WriteProgram check_only`/`syntax_check` and `GetCode SYNTAX` resolve the include's master program (`include:contextRef`) and send `?context=` like Eclipse; a type error against a master-declared FORM that passed as "no messages" when the include was checked alone is now caught (live: `E 432:12 … not type-compatible with the formal parameter "PV_COLUMN"`, nothing written). The report states the context, or flags `include checked ALONE` when there is no master. Found by a fresh-session lifecycle test.
- **`output_file` no longer returns huge results inline as well.** Past 20,000 characters (`OUTPUT_FILE_INLINE_LIMIT`) the reply is the first 30 lines plus path, size and line count; the file has everything. A 123,000-character include used to overflow the caller's token limit although the file was written.
- **`object_type=INCL` (and `FUNC`, `DTEL`, `DOMA`, `DDLS`/`CDS`, `STRU`) now resolve.** The resolver compared the hint to ADT subtypes only, so `INCL` — which the tool descriptions advertise — matched nothing ("not found … of type INCL"). Affects `GetCode SYNTAX`, `UnlockObject`, `DeleteObject`, `RunABAP`, `RunATCCheck objects`.
- **`RunATCCheck` no longer returns `isError` for a successful run with priority-1 findings.** `isError` now means the run failed; the report carries `Verdict: PASS` / `Verdict: FAIL — N priority-1 finding(s). The tool call itself succeeded.`
- **ROOT CAUSE of `400 Session not found` (and the stranded locks): our own cookie-less requests.** The server throttles creation of security sessions per user/IP and withholds `SAP_SESSIONID_*` for ~100 s after a burst of requests that carry no session cookie (controlled A/B: cookie-less noise flips a polling observer within 12 s and for ~100 s after; the same volume presenting a cookie does not disturb it, 36/36). The jar was only filled before mutating requests, so a read-only process sent EVERY request cookie-less (56 of 56 in the new `session.test.ts` R1 on the old code). Now `absorbCookies()` keeps the jar from every response (1 of 56 cookie-less), the first request of a process runs alone, and the guard retries twice then refuses for 90 s without sending anything (`src/lib/cookieJar.ts`, unit-tested). Earlier entry, superseded where it speculates on the trigger:
- **`400 Session not found` after a successful LOCK — stateful flows now refuse instead of stranding a lock.** Measured 25/25: when the CSRF fetch is answered without the security-session cookie (`SAP_SESSIONID_*`, only `sap-XSRF_*` — server-side, seen while the user's SAP GUI logon was open, nothing we send changes it), LOCK returns 200 but the next request on that context gets `400 Session not found`, stranding the SM12 lock and an SM04 session. `makeAdtRequest` now refreshes token + cookies before OPENING a stateful session, retries up to 4× for the cookie, and throws a clear error **before the LOCK** if it never arrives (`SAP_REQUIRE_SESSION_COOKIE=0` disables). The refresh and the 403 retry now present the cookie jar and merge by name (`fetchCsrfToken(url, true)`), so a still-valid session cookie is kept and no extra security session is created. Reads and the standalone SICF writers are unaffected. Why the server sometimes stops issuing the cookie is NOT established (GUI-logon and stray-session theories refuted; a rolling per-user security-session limit is the leading guess).
- **A refused (403) stateful LOCK left an orphan stateful context — and sometimes the lock itself.** After an expired security session the LOCK answered 403 but the server had already created a stateful context (and intermittently taken the lock); the retry then collided with it ("currently editing" by our own user). The same pre-refresh makes the session-opening request valid the first time (`src/session.test.ts`; `SAP_STATEFUL_PREREFRESH=0` restores the old behaviour — the test then fails and leaves 5 SM04 sessions vs 0).
- **ICM HTML error pages no longer flood the tool result.** `return_error` reduces them to their message (`describeHttpErrorBody`, `src/lib/httpError.ts`; the `Session not found` page now carries the cleanup recipe) — the raw page was ~6 KB of inline base64 logo per failure.
- **`activate=false` writes were silent about the inactive state.** The response now says "Not activated (activate=false) — the saved source stays inactive until …".
- **`WriteProgram` left an empty change request behind when creating a NEW object failed after its `transport_description` request was made.** For new objects and `FUGR` the request is still made first (the create call needs it as `corrNr`), but if the create (or the function-group create for a new FM) then fails, the transport this call auto-created is deleted again and the error says so (or says it could not be deleted). Live-verified: a refused create in `ZMCP` auto-created `S4DK000000`, which was gone from SAP afterwards.
- **A finished jest run could not exit after the keep-alive change.** `cleanup()` now destroys the kept-alive HTTPS agent and idle sockets close after 15 s. (Separately, in a non-interactive shell jest also needs stdin closed — `npm test -- patch < /dev/null` — because an open stdin pipe, not SAP, keeps the process alive.)

### Tests
- **Gate under real overlap** (live): two `WriteProgram` calls fired together → exactly one runs, the other is refused immediately, no lost update; a `WriteProgram` + `DeleteObject` together → the second is refused and the lock is released. Settles the earlier "both succeeded" observation: that was client-side serialization, not a gate gap.
- `src/lib/newtools.test.ts` (13 offline tests) and `src/newtools.test.ts` (16 live tests on disposable `$TMP` objects) cover `RunABAP`, `ManagePackage`, `GetCode SYNTAX` incl. the include-in-master-context regression (checked alone → no error; in context → error), `apply_patch`, local snapshots, `RunATCCheck` objects/worklists/verdict, `text_elements` and the `output_file` inline limit. The offline test found that `snapshots.ts` eagerly imported the server entry (needs credentials) — now a lazy require.

### Changed
- **`CLAUDE.md` cut from 119 KB to 41 KB (−66%).** It is loaded into every session; most of it was tool-by-tool investigation notes. The 21 per-tool sections moved **verbatim** to `reference/TOOL_INTERNALS.md` (verified: every moved section is byte-identical apart from link targets, no heading lost, no broken in-page link); `CLAUDE.md` keeps the rules and patterns that apply to any handler change plus a hand-written stub per moved section (the one or two things to know before touching that tool) and a new compact block of rules for stateful (LOCK) handlers. README, README.zh-TW and `ADT_ENDPOINTS.md` point at the new file.
- **`WriteProgram`'s description now opens with a MODES block** (source_code|source_file / edits / apply_patch / class_include, check_only, and the differing `syntax_check` defaults) — the ways to call it exclude each other only in prose otherwise.


## [3.6.0] - 2026-10-14

### Added
- **`GetCode resource=OBJECT` batch read — `objects[]`.** Up to 10 objects in one call, fetched in parallel (each entry a name or `{ object_name, kind?, function_group? }`; other args are shared defaults). Output is one `===== NAME =====` section per object; a failing object is reported in place and does not hide the others (`isError` only if all fail); more than 10 is refused.
- **`WriteProgram` pre-write syntax check — `syntax_check` / `check_only`.** `check_only=true` runs an ADT check run (`POST /sap/bc/adt/checkruns`) of the new source against an existing object and reports `line:col — text` without locking or writing anything; `syntax_check=true` does the same before the lock and refuses the write on any error. Both default off (an include is checked without its master program). A failing check call never blocks a write (`src/lib/syntaxCheck.ts`).

### Fixed
- **`WriteProgram` with `transport_description` left an empty change request behind when the write was refused.** For an existing object the request is now created after the lock and the reassignment guard. An object already in an open request keeps it (`transport_description` is ignored, said in the response, and the request is passed as `corrNr`); a failed creation unlocks the object. New objects and `FUGR` still create it first (needed as `corrNr` for the create call).
- **`WriteProgram` dropped nothing when creating a NEW object failed after its auto-created request was made.** The transport this call auto-created is now deleted again and the error says so.

### Changed
- **Performance: TLS keep-alive and a quickSearch cache.** The shared HTTPS agent reuses connections (`keepAlive: true`, `maxSockets` = `SAP_MAX_CONCURRENT_REQUESTS`). quickSearch GETs with at least one hit are cached for 30 s (`SEARCH_CACHE_TTL_MS`, `0` disables); empty results are never cached and any non-GET request clears the cache.

## [3.5.1] - 2026-10-12

### Fixed
- `ManageSessions action=end` reported a successful end as `still there` when SAP reused the freed `tid` at once; the verification now also compares logon time and terminal (same fix as in the original project). The two `regex =` activation warnings became `pcre =`.

## [3.5.0] - 2026-10-12

### Added
- `ManageSessions` (`list` / `end`): list and end the connection user's own ABAP sessions on every application server; standalone SICF endpoint `session_admin`. Own user, HTTP sessions only, never the calling session, no "end all"; ids are reused at once, so an id is only valid in the latest list. The `list` header also names the current session (system, client, user, language, application server). Live-verified here, including a real `end`; a freed `tid` can be reused at once, so the final check compares server, tid, logon time and terminal.
- `UnlockObject force=true`: delete the connection user's own orphan SM12 locks through the standalone endpoint `lock_admin` (`ENQUE_DELETE`, whole-name match).
- `scripts/adt-session-check.js`: bare-client check whether the SAP system keeps a stateful ADT session alive (LOCK → follow-up → UNLOCK); the cause of the intermittent `400 Session not found` is a fault of the SAP system, not of the tools.
- Live integration tests for `ManageAuthObject` (against a permanent anchor object) and `ManageSessions`.

### Fixed
- CSRF expiry in all ABAP HTTP handlers compared raw `TIMESTAMP` values instead of seconds (`CL_ABAP_TSTMP=>SUBTRACT` now).
- `create_sicf_node` sets `LOG_FLAG`, so generated nodes use the Alternative Logon Procedure.
- `UnlockObject` schema: `object_type` was outside `properties`.
- Tests no longer rewrite a program found by search pattern; they create their own `$TMP`/`ZMCP_*` fixtures.

- The server announced itself as version 3.4.1; it now reads its version from `package.json`.

### Removed
- `Dockerfile` and `smithery.yaml` (inherited from upstream, never used here; the old image would also have copied a local `.env` into itself). The server runs with `node dist/index.js`.

### Changed
- `abap-tasks/README.md` corrected after a first install on a clean system (message classes `ZMCP_DISPATCH`/`ZMCP_TEXTPOOL` are required for readable errors); project skill extended with the recovery procedure for orphaned sessions and locks.

## [3.4.1]

First public release. Derived from [mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) with a large set of additions:

- Read tools consolidated into `GetCode`, `GetDiagnostics` and `GetMeta` dispatchers (`resource` enum).
- Write tools: `WriteProgram`, `ManageDDIC`, `ManageMessageClass`, `ManageTransport`, `ManageDynpro`, `ManageAuthObject`, `TextPoolLang`, `ManageSicfNode`, `ActivateObjects`, `DeleteObject`, `UnlockObject`.
- `RunUnitTest` and `RunATCCheck`, with `background=true` / `output_file` mode for long-running calls and offset paging with a short-lived result cache for list tools.
- Cross-process stateful-operation gate so only one ADT `LOCK` session runs at a time per SAP system.
- Optional encrypted secrets keystore as an alternative to a plaintext `.env`.
- Optional ABAP-side SICF endpoints (see `abap-tasks/`) for capabilities standard ADT lacks.
