---
name: mcp-abap-adt
metadata:
  version: "1.4"
description: >-
  How to work on an SAP ABAP system through the mcp-abap-adt MCP server: find and
  read objects, change source safely (lock → write → unlock → activate), manage
  transports, DDIC objects, message classes, packages, auth objects, transaction codes and screens, run ABAP Unit and ATC,
  and debug lock/transport/activation problems. Use for any task that reads or
  changes ABAP objects via these MCP tools.
---

# Working with SAP through `mcp-abap-adt`

All access goes through ADT (ABAP Development Tools) REST APIs. There is no shared
filesystem with SAP: reading returns text into the conversation, writing sends it
back. Local files are only working copies.

Load `references/tool-reference.md` for the tool table, parameters and traps, and
`abap-tasks/README.md` (repo root) only when a tool needs an ABAP-side endpoint that
is not installed yet. Load other references only when the task needs them:

| The task is… | Read (in `references/`) |
|---|---|
| A write failed with `400 Session not found`, or locks/sessions are left behind | `recovery.md` |
| Writing or changing ABAP: style, strict-mode and activation traps, exceptions, wide changes | `abap-coding-rules.md` |
| A function-module signature (TYPE vs LIKE, `TABLES`, RFC-enabled) | `fm-parameter-typing.md` |
| Performance work or reviewing a change (N+1, redirected S/4 tables, bounded reads) | `performance-patterns.md` |
| Adding a cache or memoizing a hot routine | `safe-caching.md` |
| Replacing BDC `CALL TRANSACTION` with a BAPI | `bdc-to-bapi.md` |
| Proving a change, chasing a hard bug, reviewing a transport | `testing-and-diagnosis.md` |
| A write, transport or DDIC call misbehaving; new objects; sequencing writes | `write-and-transport-details.md` |
| A capability ADT lacks and you consider a custom SICF endpoint | `custom-endpoints.md` |

## Workflow for any change

1. **Find** — `SearchObject` (`*` wildcards). Never guess a standard name from analogy
   (`BAPI_COMPANYCODE_GETDETAIL` does not imply `BAPI_GLACC_GETDETAIL`).
2. **Read** — `GetCode resource=OBJECT`; save it unchanged as `[ObjectName].[type].abap`
   (e.g. `ZCL_FOO.clas.abap`) as the baseline for diffs.
3. **Edit locally**, then `WriteProgram source_file=<path>` instead of inline `source_code`.
4. **Transport** — before writing outside `$TMP`, run `UnlockObject`: it reports the
   object's current request (`CORRNR`), whoever owns it. Reuse it; create one only if none fits.
5. **Write** — `WriteProgram` does lock → PUT → unlock → activate. Pass `transport_number`.
   For mutually dependent objects write each with `activate=false`, then one `ActivateObjects`.
6. **Verify** — read the activation messages, run `RunUnitTest` / `RunATCCheck`, re-read if in doubt.

## Rules that prevent most failures

- **Serialize lock-taking calls** (`WriteProgram`, `ManageDDIC`, `ManageObject MESSAGE_CLASS`/`PACKAGE update`,
  `UnlockObject`, `DeleteObject`, `ManageTransport assign_object`, `ActivateObjects rfc_enabled`):
  they share one session cookie, so await each; reads may run in parallel.
- **`Blocked: a stateful SAP MCP operation`** means another call holds the local gate; it never
  reached SAP. Wait and retry.
- **Never interrupt a lock-taking call or a test run** (no Ctrl-C, `kill`, `pkill`, `timeout`
  on Jest/Node): a write cut between LOCK and UNLOCK leaves a lock and a session.
- **After one failed stateful call, stop.** Each failing retry leaves another orphaned lock. Read
  the error once, then follow `references/recovery.md`.
- **Tests write only to fixtures they own** (`$TMP`, `ZMCP_*`). Never pick a target by search
  pattern (`ZTEST*`): it rewrites someone else's program. Grep the tests' object names first.
- **Unlock before activate.** For `User X is currently editing`, run `UnlockObject` alone and
  retry. If X is another developer, coordinate; never force their lock.
- **Never overwrite a different transport silently:** `WriteProgram` refuses; use the request it names.
- **Destructive calls need the user's go-ahead:** `DeleteObject`, `ManageTransport`
  `release`/`delete`/`merge`/`remove_object`.
- **Name limits:** PROG/INCL/CLAS/FUNC and DDIC objects ≤ 30 characters, FUGR ≤ 26. The tools
  reject longer names instead of letting SAP truncate them.
- **`HTTP 200` is not success.** Activation, release and several writes report the outcome in the
  body; read the text even though the tools set `isError`.
- **Language-dependent writes** (message texts, text pools): name the language and verify in the
  language-keyed table with `DataPreview`.
- **ABAP Unit rolls back.** A write that passes inside a test may not persist; prove it with a
  second call outside the test.
- **Never retype a field list that must match another** (copied structure, bulk rename): fetch
  the live object, edit only differing lines or script it, and diff the names.

## Efficient database access in generated ABAP

Filter every `SELECT` with `WHERE`. No `SELECT` inside loops: collect keys, read once with
`FOR ALL ENTRIES` or a join, then `READ TABLE … BINARY SEARCH` or a hashed table. Guard and
de-duplicate every `FOR ALL ENTRIES` driver. `SELECT SINGLE` only with the full key, otherwise
`SELECT … UP TO 1 ROWS` + `EXIT`. Check column names with `GetMeta resource=TYPEINFO` first.

## Proving a change

- New logic: a `$TMP` class `FOR TESTING` (no transport), run with `RunUnitTest`; expected
  values come from a source independent of the code under test.
- Changed logic: assert old and new give identical results over the same inputs; compare
  tables sorted and serialized, not by row count.
- Watch each assertion fail once (perturb an input) before trusting a green run.
- `RunUnitTest` runs as the connection's SAP user and executes only `FOR TESTING` classes.

## When something fails

| Symptom | First move |
|---|---|
| `User X is currently editing …` | `UnlockObject` alone; if X is someone else, coordinate. If X is the configured user and it answers "not a dead lock", see `recovery.md` |
| `400 Session not found` after a successful LOCK, "failed to release the lock" | Stop; follow `recovery.md` |
| Activation `E` messages | Fix the source; for cross-referencing objects use `ActivateObjects` with all names |
| Transport refuses delete "contains locked objects" | `ManageTransport remove_object` on the stale entry, then delete |
| Unknown or changed ADT behavior | Probe stateless with `curl`; see `docs/ADT_ENDPOINTS.md` |
| `/zmcp/…` endpoint not found (404) | The optional ABAP endpoint is not installed — `abap-tasks/README.md` |

## Closing a task

State what changed (objects, transport numbers, activation and test results) and what is left
undone. If the task taught a durable rule, propose the exact edit to this skill for approval.
