---
name: mcp-abap-adt
metadata:
  version: "1.1"
description: >-
  How to work on an SAP ABAP system through the mcp-abap-adt MCP server: find and
  read objects, change source safely (lock → write → unlock → activate), manage
  transports, DDIC objects, message classes and screens, run ABAP Unit and ATC,
  and debug lock/transport/activation problems. Use for any task that reads or
  changes ABAP objects via these MCP tools.
---

# Working with SAP through `mcp-abap-adt`

All access goes through ADT (ABAP Development Tools) REST APIs. There is no shared
filesystem with SAP: reading returns text into the conversation, writing sends it
back. Local files are only working copies.

Load `references/tool-reference.md` for the full tool table, parameters and traps.
Load `abap-tasks/README.md` (repo root) only when a tool needs a custom ABAP-side
endpoint that is not installed yet.

## Workflow for any change

1. **Find** — `SearchObject` (`*` wildcards). Never guess a standard object name
   from analogy (`BAPI_COMPANYCODE_GETDETAIL` does not imply `BAPI_GLACC_GETDETAIL`);
   search for the real one first.
2. **Read** — `GetCode resource=OBJECT`. Save the source unchanged to a local file
   named `[ObjectName].[type].abap` (e.g. `ZCL_FOO.clas.abap`) as the baseline for diffs.
3. **Edit locally**, then write with `WriteProgram source_file=<path>` rather than
   inline `source_code` — keeps large sources out of the conversation.
4. **Transport** — before writing outside `$TMP`, find the object's current transport
   (`UnlockObject` reports `CORRNR` for an object already in a request, whoever owns
   it). Reuse it; create a new one only if none fits (`ManageTransport action=create`,
   which already creates the first task — do not also `add_task`).
5. **Write** — `WriteProgram` does lock → PUT → unlock → activate in one call. Pass
   `transport_number`. For several mutually dependent objects write each with
   `activate=false`, then one `ActivateObjects`.
6. **Verify** — read activation messages in the result (HTTP 200 does not mean
   success), run `RunUnitTest` / `RunATCCheck`, re-read the object if in doubt.

## Rules that prevent most failures

- **Serialize every lock-taking call.** `WriteProgram`, `ManageDDIC`,
  `ManageMessageClass`, `ManageTransport action=assign_object`,
  `ActivateObjects rfc_enabled`, `UnlockObject`, `DeleteObject` share one ADT
  session cookie in the server process. Await each to completion; never run them in
  parallel, from parallel sub-agents, or from two MCP connections at once. Reads are
  safe to parallelize. A result starting `Blocked: a stateful SAP MCP operation`
  means another call holds the gate — wait and retry; it never reached SAP.
- **Never interrupt a lock-taking call or a test run** — no Ctrl-C, `pkill`, `kill` or
  `timeout` on `npm test`/Jest/Node while it writes. A write is LOCK → PUT → UNLOCK in one
  SAP session; cutting it between LOCK and UNLOCK leaves an edit lock and a session that
  no ADT call can clear (see "Recovering from orphaned sessions and locks").
- **After one failed stateful call, stop and diagnose.** Each retry that fails the same
  way leaves one more orphaned lock. Read the error text once, then follow the recovery
  section; do not loop.
- **Live tests write only to fixtures they own** (`$TMP`, `ZMCP_*` names created by the
  test itself). Never let a test pick its target by search pattern (`ZTEST*`): it will
  rewrite someone else's program. Before the first `npm test` on a new system, grep the
  tests for the object names they write to.
- **Unlock before activate.** Activation fails on a still-locked object. If a lock
  error says `User X is currently editing`, and X is the configured SAP user, it is
  usually a leftover session: run `UnlockObject` alone, then retry. Never force
  another developer's lock.
- **Always append `/source/main`** when you call raw source URLs; the tools do it for you.
- **Never overwrite a different transport silently.** `WriteProgram` refuses when the
  object is locked in another request than the one you named; use the transport it
  names.
- **Destructive tools need the user's go-ahead:** `DeleteObject`, `ManageTransport`
  `release`/`delete`/`merge`/`remove_object`.
- **Names:** PROG/INCL/CLAS/FUNC ≤ 30 chars, FUGR ≤ 26, DDIC objects ≤ 30. The tools
  reject longer names instead of letting SAP truncate them.
- **`HTTP 200 ≠ success`.** Activation, transport release and several writes report
  the real outcome inside the body; the tools turn that into `isError`, but always read
  the text.
- **Language-dependent writes** (message class texts, text pools): name the language
  explicitly and verify the result in the language-keyed table with `DataPreview`.
- **ABAP Unit rolls back.** A write that "passes" inside a unit test may not persist;
  prove persistence with a second call outside the test.

## Efficient database access in generated ABAP

Filter every `SELECT` with `WHERE`; no `SELECT` inside loops (collect keys, read
once with `FOR ALL ENTRIES`/join, then `READ TABLE ... BINARY SEARCH` or a hashed
table); guard and de-duplicate every `FOR ALL ENTRIES` driver table; use
`SELECT SINGLE` only with the full key, otherwise `SELECT ... UP TO 1 ROWS` + `EXIT`.
Verify column names with `GetMeta resource=TYPEINFO` / `DataPreview` before relying on them.

## Proving a change

- New logic: a `$TMP` class `FOR TESTING` (no transport) with real `cl_abap_unit_assert`
  assertions, run with `RunUnitTest`. Expected values must come from a source
  independent of the code under test (spec, worked example, `DataPreview`).
- Changed logic: assert the old and new implementation give identical results over the
  same inputs; for tables compare sorted, serialized output, not just row counts.
- Watch each assertion fail once (perturb an input) before trusting a green run.
- `RunUnitTest` runs as the connection's SAP user and only executes `FOR TESTING`
  classes; there is no way to run an arbitrary report and capture its list.

## When something fails

| Symptom | First move |
|---|---|
| `User X is currently editing …` | `UnlockObject` alone; if X is someone else, coordinate. If X is the configured user and `UnlockObject` answers "not a dead lock", an orphaned session holds it — SM12 (see below) |
| `HTTP 400` / `400 Session not found` on the PUT or UNLOCK right after a successful LOCK, plus "failed to release the lock" | The stateful ADT session was lost. Stop; follow "Recovering from orphaned sessions and locks" |
| Activation `E` messages | read them in the response; fix source; for cross-referencing objects use `ActivateObjects` with all names |
| `Blocked: a stateful SAP MCP operation …` | another mutation is running (maybe another window); wait and retry |
| Transport refuses delete "contains locked objects" | `ManageTransport remove_object` on the stale entry, then delete |
| Unknown/changed ADT behavior | probe with `curl` (stateless!) against the endpoint; see `docs/ADT_ENDPOINTS.md` |
| Tool says endpoint `/zmcp/…` not found (404) | the optional ABAP-side endpoint is not installed — see `abap-tasks/README.md` |

## Recovering from orphaned sessions and locks

Symptom: `WriteProgram`/`UnlockObject` lock the object fine, then the next request gets
`400 Session not found` (the raw page says "Service cannot be reached … 400 Session not
found"), the result adds "failed to release the lock", and the object stays locked by the
configured SAP user. **This is an intermittent fault of the SAP system, not of the object,
the tools or the tests**: with a bare HTTP client, LOCK → follow-up request → UNLOCK fails
on *every* object (including ones that worked an hour earlier) while the fault is active,
and works again when it ends, by itself and without any change on our side. Seen repeatedly
on the development system; SM04 showed sessions SAP no longer tracked. A restart of the MCP
server (`/mcp`) sometimes coincided with recovery, but a fresh process failed just the same
while the fault was active, so the restart is not the fix.

**Check before you write** (and before the test suite): `node scripts/adt-session-check.js
/sap/bc/adt/oo/classes/<one of your own objects>` replays LOCK → GET → UNLOCK with a bare
client and says HEALTHY or FAULT. It leaves a lock behind when the system is faulty — clear
it with `UnlockObject force=true`. On FAULT do not write and do not run `npm test`; wait, or
ask Basis to look at SM04/SM21 at that time.

1. **Stop writing.** Do not retry, do not run the test suite again, do not `pkill` anything.
2. **Run `scripts/adt-session-check.js`** to see whether the fault is still active. Then
   clear the leftover locks of the SAP user (a restart with `/mcp` is cheap but does not
   cure an active fault):
   - **`UnlockObject object_name=… force=true`** (needs the optional `lock_admin` endpoint †;
     it matches whole names only, so list locks by the exact name, never by a prefix —
     a prefix query answers "no lock" even when the object is locked):
     deletes the user's *own* SM12 entries for that object. Only after the user confirms
     that no SAP GUI/Eclipse session of theirs is editing it — the endpoint cannot tell an
     orphan from a live lock. Run `UnlockObject` again without `force` to confirm.
   - or the user deletes them in **SM12**.
   - **Locks and sessions are separate.** Every failed stateful call also leaves an ABAP
     session of that user in **SM04** (an ADT/HTTP session, usually marked as still in use).
     Deleting the lock — with `force` or in SM12 — does not end it; the session lingers until
     the HTTP session timeout. End the stale ones with `ManageSessions` (`list` first, then
     `end` with `server:tid` ids you recognize by client IP and age — never the user's own live
     Eclipse/GUI sessions), or in SM04. Count them if the fault repeats: they pile up.
   Plain `UnlockObject` cannot do this: it refuses while the owning session is alive, and an
   ADT lock whose session is gone stays enqueued until it is deleted.
3. **Verify with a brand-new `$TMP` name** (an existing object may still carry an orphan
   lock): `WriteProgram` create + write + activate. Only then retry the real work.
4. **To separate "SAP is faulty" from "the MCP server is stale"**, use the bare-client check
   from step 2. If it says HEALTHY but the MCP server still fails, restart the server with
   `/mcp`; if it says FAULT, nothing on our side will help.
5. Delete any probe objects you created, then report what you left behind.

If a run of the repo's own tests leaves locks, the same steps apply; run the suite again
only after they are gone, and only once. Repeated identical failures are not "flakiness"
to retry through: the first failing call in a run is the one to read.

## Closing a task

State what changed (objects, transport numbers, activation/test results) and anything
left undone. If the task taught a durable rule, propose the exact edit to this skill
for the user to approve rather than editing it silently.
