# Writing source and transports — the details that bite

Load when `WriteProgram`, `ManageDDIC`, `ManageTransport` or `ActivateObjects` behaves
unexpectedly, when creating new objects, or when sequencing several writes. The tool table is
in `tool-reference.md`; this file is the reasoning and the traps behind it.

## 1. Transport order — check first, create second

For an *existing* object outside `$TMP`:

```
SearchObject / GetCode resource=OBJECT      read the current active source
UnlockObject object_name=…                  is it already in an open request?
ManageTransport action=create               only if it reported none
WriteProgram transport_number=…             write + activate
RunATCCheck on the transport                before handover
ManageTransport action=release              only when explicitly asked
```

`WriteProgram` refuses a `transport_number` different from the request the object is already
locked under (SAP would otherwise *silently* move the object between requests). Create first
and get refused, and you leave an empty duplicate request behind.

**Use `UnlockObject`, not `GetMeta resource=TRANSPORT`, for the check.** The transport list
defaults to the connection's own user and shows headers only, so an object sitting in
*another user's* request reads as "no open transport". `UnlockObject` takes a real ADT lock
and reads `CORRNR`/`CORRTEXT` from the lock result — a property of the object's own CTS
registration, not filtered by who asks — then releases the lock again. Its report names the
request you can pass straight to `WriteProgram`.

**Cleanup after a refused write.** The refusal names the right request (`existingCorrNr` /
`existingCorrText`). The one you just created is an empty orphan: delete it with
`ManageTransport action=delete` (works on an empty request) before retrying.

**Brand-new objects: never let SAP auto-name the request.** `ManageTransport action=create`
needs an object URI, which a not-yet-created object lacks. Skipping the transport and calling
`WriteProgram` with no `transport_number` works, but SAP creates "Generated Request for Change
Recording", and a released request cannot be renamed — the bad name is permanent. Two ways:

- **Preferred:** `WriteProgram transport_description=… package_name=…` creates a properly
  titled request itself (the package is used as `DEVCLASS`).
- **Equivalent:** `ManageTransport action=create` with `object_type` + `object_name` instead
  of `object_url` builds the future object's URI (SAP derives the transport layer from the
  package and URL shape, not from the object existing). No `FUNC` value — a function module
  has no collection path; pass `object_type=FUGR` + the containing group.
- **Rescue** if the generic request exists and is unreleased: `action=set_text` renames it.

Both come out as **one request + one task** (SAP creates the task with the request; the
response reports it). `action=add_task` is only for a *second* developer on a shared request.

## 2. `WriteProgram`

- The name parameter is always **`program_name`**, for every `object_type` (`PROG`, `INCL`,
  `CLAS`, `FUGR`, `FUNC`). `object_name` fails immediately with `program_name is required`.
- `source_file` wins over `source_code`. Prefer it for anything large: the tool reads the file
  server-side, so the source never costs context. The write **replaces the whole source** —
  always start from the current `GetCode` output, never from memory.
- Create needs `description` + `package_name`; give the transport up front
  (`transport_description`, §1).
- **Class:** the file holds the full `CLASS … DEFINITION … ENDCLASS.` + `IMPLEMENTATION`.
- **Patch mode:** to change part of an existing object send `edits=[{old_string,new_string,replace_all?}]`
  instead of the whole source (unique exact anchor, atomic, max 20, existing objects only). A passing
  `check_only` dry run prints `apply_patch="p-…"`; apply it with `WriteProgram(program_name, apply_patch=…)`
  without resending the edits. Every write keeps the replaced text as a local snapshot
  (`Previous source kept as local snapshot <id>`); diff or recover it with
  `GetCode(resource=VERSION, compare_to=snapshot:<id>)` — the only history a `$TMP` object has.
- **Class unit tests and other local parts are not part of the main source.** Write the global class
  with `WriteProgram`, then `WriteProgram(program_name=<class>, class_include=testclasses, source_code=…)`
  (also `implementations` = local classes, `definitions` = local types, `macros`), then `RunUnitTest`.
  The include is created on the first write and the class activated; patch it later with
  `class_include` + `edits[]`. Pasting `CLASS ltc_… FOR TESTING` into the main source fails in the
  source splitter (`OO_SOURCE_BASED011`). The class is syntax-checked with the new include before the
  lock (errors in that include refuse the write; `check_only=true` dry-runs, `syntax_check=false` opts
  out); the first write of a new include cannot be pre-checked and says `NOT CHECKED`.
  A new class starts as `PUBLIC CREATE PRIVATE` with empty sections; visibility, `FINAL`,
  `ABSTRACT`, `CREATE …` live in the `DEFINITION` text, so write the header you want on the
  first call. Text elements are not supported for classes (PROG/P only).
  **First activation:** prove the complete source in a disposable `$TMP` class first — AUnit
  proves behaviour, not that the source activates. If the productive first activation fails,
  correct the full source and write again while the inactive object still exists. If SAP
  rejects the corrective write, keep the local source and inspect the PUT diagnostics
  (`include_raw_sap_response=true`) before touching CTS state; SAP GUI/Eclipse cleanup only
  when the returned evidence shows an inactive/deletion state that blocks recovery. Do not
  invent a new name just to bypass incomplete cleanup.
- **A failed source PUT is not an activation failure.** *"An error occurred during the save
  operation. The changes were not stored."* means SAP rejected the source before activation:
  nothing was stored and there is no line-level diagnostic yet. Keep the local source,
  read the returned diagnostics, retry with `include_raw_sap_response=true` before deleting or
  recreating anything. A generic PUT failure proves neither a CTS/inactive-object condition
  nor a source-parser defect.
- **Class source splitter errors** are pre-activation parser errors: `OO_SOURCE_BASED011`
  ("can't be separated into its different source parts") — check `CLASS-METHODS` parameter
  order (`IMPORTING`, `EXPORTING`, `CHANGING`, `RETURNING`) and bisect the definition;
  `OO_SOURCE_BASED012` (unknown comments) — usually banner/section comments outside method
  implementations: remove comments before the definition or between definition and
  implementation, keep explanations inside `METHOD … ENDMETHOD`.
- **Line length is preflighted** (255 characters); fix the reported line locally. A large total
  size alone is not proof of a payload limit.
- **Activation failure is a separate, useful phase.** A successful PUT followed by
  `Activation FAILED` means SAP stored the source and returned compiler messages: fix the
  named object/line and retry; the object may be inactive, but that alone is no CTS diagnosis.
  Re-read the source and `GetMeta resource=INACTIVE_OBJECTS` afterwards to see the real state.
- `FUGR` is create-only (SAP generates TOP/UXX). `FUNC` needs `function_group` (created if
  missing) and the inline signature (`abap-coding-rules.md` §4.3, `fm-parameter-typing.md`).
  The **Remote-Enabled** checkbox is object metadata, not source — only
  `ActivateObjects rfc_enabled={"FM": true}` sets it, checking RFC compatibility at that
  moment.
- **Text elements** (`text_symbols`/`selection_texts`/`list_headings`, or `_file`): PROG/P
  only. Symbols: `@MaxLength:N` line, then `KEY=VALUE`, blocks separated by a blank line;
  selection texts: parameter name padded to 8 characters, then `=Text`.
- **Multi-include programs:** write every include with `activate=false`, then one
  `ActivateObjects(names=[…])`. One-by-one activation fails on references to not-yet-active
  siblings. `GetMeta resource=INACTIVE_OBJECTS` shows what is queued if a write's `activate`
  result was ambiguous. Cloned code activates under the **current** strict syntax even if the
  original is grandfathered (`abap-coding-rules.md` §4.1).
- **Lock conflict (`User X is currently editing Y`):** an edit session — yours or someone's —
  holds the object. `UnlockObject` first; it says whether X is your configured user (a leftover
  session, or a lock orphaned by an interrupted write) or another developer (coordinate,
  escalate to Basis/SM12 — never force another user's lock).
- **`Blocked: another MCP connection … holding token sap-contextid=…`** is a *local* message:
  the stateful-operation gate turned the call away before it reached SAP. `UnlockObject` has
  nothing to clear. Wait and retry; it self-clears when the holder finishes or its process died
  (dead PID detected on the next attempt, 2-minute age fallback otherwise).

## 3. Concurrency — what "serialize" means

The server holds the stateful ADT session cookie (`sap-contextid`) at process scope. A lock
flow captures and reuses it across LOCK, PUT and UNLOCK; a parallel flow can replace or clear
it mid-way, giving a self-conflict (`User <configured user> is currently editing`), a failed
save, or an unlock for the wrong flow.

- Treat each lock-taking tool call as one critical section including its activation/unlock
  tail: `WriteProgram` (also text-element writes), `ManageDDIC` create/update,
  `ManageMessageClass` (every action), `ManageTransport assign_object`,
  `ActivateObjects rfc_enabled`, `UnlockObject`, `DeleteObject`. Do not use `Promise.all`,
  parallel sub-agents, batched concurrent tool calls, or a background wrapper for them.
- **Only the parent/orchestrating agent calls mutation tools.** Sub-agents may run read-only
  discovery in parallel and return facts, plans or local-file edits, but never a mutation.
  Different sub-agents can get different stdio MCP connections (different server processes,
  same SAP user); SAP then reports their collision as that user editing the object.
  A plan that merely *describes* writes in order is not enough — wait for each full response.
- `ActivateObjects` without `rfc_enabled` takes no object lock but still runs after all related
  writes have finished; never overlap it with a write to the same objects.
- Safe in parallel: `SearchObject`, `GetCode`, `GetMeta`, `GetDiagnostics`, `DataPreview`,
  `RunUnitTest`, local-file work. After the read phase, switch to one serial mutation lane. On
  a lock conflict stop that lane, run `UnlockObject` alone, retry after it finishes.
- The local gate does not replace the sequencing rule: it is machine-local (temp directory),
  scoped per SAP URL+client, and cannot protect separate machines, Windows logins, SAP GUI,
  Eclipse or another client using the same SAP account.

## 4. `ManageDDIC` per type

`WriteProgram` cannot create or change any DDIC object. All five types follow the normal
workflow (transport check, ATC, validation).

- **STRUCTURE / CDS_VIEW** — DDL source like any other object (`source_file`, full
  `define structure NAME { … }` / `define view NAME as select from …`). `create` needs
  `description` + `package_name`. Only classic `define view` syntax is verified; avoid the
  deprecated `@AbapCatalog.preserveKey` (harmless activation warning).
- **TABLE_TYPE** — metadata only; `row_type_name` names an existing structure/table. Only
  `standard` access with the default key (sorted/hashed and explicit keys were probed; the
  request shape that sets them was never found — don't hand-build one). `update` can only
  change `row_type_name`; a supplied `description` is rejected (it cannot be read back after
  creation). Treat table-type descriptions as write-once.
- **DATA_ELEMENT** — metadata only, different document shape from TABLE_TYPE. `domain_name`
  names an existing, active domain (its technical type is read live and embedded);
  `short_label`/`medium_label`/`long_label`/`heading_label` default to `description`,
  truncated to each limit. Unlike the other two, `description` changes on `update` work.
- **DOMAIN** — simplest. `data_type` + `length` required, `decimals` default 0. Shares
  TABLE_TYPE's description trap. No fixed values or value-table reference.
- Order when both are new: `DOMAIN` first, then the `DATA_ELEMENT` that references it. To pair
  a structure with a named table type: create the `STRUCTURE`, activate/read it back, then the
  `TABLE_TYPE` with `row_type_name`.
- Not covered by the gateway at all: transparent tables, append structures, search helps,
  classic views, lock objects — their live contract was never proven. Don't route around the
  gap with a custom endpoint without checking with the user first.

## 5. Looking things up before designing

- A plausible-sounding standard/framework class is not proof it is the general-purpose API:
  run `GetCode resource=WHEREUSED` on it first (a class scoped to one internal framework with no
  general callers is easy to mistake for the entry point).
- `GetCode resource=OBJECT` on a function module does not show its group's other includes
  (`LZ<GROUP>Fxx` forms with the logic). Find them with `SearchObject query='LZ<GROUP>*'`.
- Before concluding a blocker is unsolved here, search the codebase for an existing precedent
  solving the same problem. A precedent is a starting point for the *mechanism* only —
  re-verify it against this task's requirements; it may carry its own shortcuts (an unguarded
  `SELECT SINGLE`, a silent fallback).
- When a plan revision reverses an earlier decision, re-check the code already written against
  the revision line by line before writing more — code drafted under the old approach survives
  a rewrite that only touched the plan text.
- A tool server listed with zero tools: a new or edited `.mcp.json` entry is only picked up on
  the next session start or `/mcp` reload — ask for that before debugging the server process.
  When several tool schemas are still deferred, load everything you will need in one
  `ToolSearch` call.
