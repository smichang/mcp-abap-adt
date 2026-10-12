---
name: mcp-abap-adt
metadata:
  version: "1.0"
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
| `User X is currently editing …` | `UnlockObject` alone; if X is someone else, coordinate |
| Activation `E` messages | read them in the response; fix source; for cross-referencing objects use `ActivateObjects` with all names |
| `Blocked: a stateful SAP MCP operation …` | another mutation is running (maybe another window); wait and retry |
| Transport refuses delete "contains locked objects" | `ManageTransport remove_object` on the stale entry, then delete |
| Unknown/changed ADT behavior | probe with `curl` (stateless!) against the endpoint; see `docs/ADT_ENDPOINTS.md` |
| Tool says endpoint `/zmcp/…` not found (404) | the optional ABAP-side endpoint is not installed — see `abap-tasks/README.md` |

## Closing a task

State what changed (objects, transport numbers, activation/test results) and anything
left undone. If the task taught a durable rule, propose the exact edit to this skill
for the user to approve rather than editing it silently.
