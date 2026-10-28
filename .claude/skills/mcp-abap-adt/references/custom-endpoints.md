# Building a custom ABAP-side endpoint — lessons for a real ADT gap

Load when a capability has no ADT REST surface and you consider adding a tool backed by a
standalone SICF service (the pattern behind `TextPoolLang`, `ManageObject AUTH_OBJECT`/`TRANSACTION`,
`ManageDynpro`, `ManageSicfNode`, `ManageSessions`, `UnlockObject force=true`, and the
`move_object`/`merge`/`remove_object` actions of `ManageTransport`; sources in `abap-tasks/`).
First make sure it is a *genuine* gap, not an inconvenient existing endpoint (§3).

## 1. The pattern

- **A plain `IF_HTTP_EXTENSION` class bound to its own SICF node** (`default_host/zmcp/<name>`),
  not an ADT resource extension — ADT's resource framework (`CL_ADT_WB_RES_APP`) has no customer
  extension point; don't look for one. Only the *first* node under a package needs a human:
  `CL_ICF_TREE=>IF_ICF_TREE~INSERT_NODE`/`DELETE_NODE` (not the simplified
  `HTTPTREE_INSERT_NODE`/`HTTPTREE_DELETE_NODE`) create and delete child nodes programmatically.
  Alternative Logon Procedure needs `LOG_FLAG = 'X'` together with `LOGIN_PROCESS = 'L'`.
- **A simplified FM can silently ignore a field its underlying class method honours.**
  `HTTPTREE_INSERT_NODE` never copies `icfserdesc-login_process`; the class method does.
  When an FM does not do what a parameter implies, look for a richer class method, and verify by
  re-reading the persisted value, not the return code.
- **Reuse the standard FMs as local calls; never reinvent.** Look at what SE38/SE80's own
  reload/insert tool calls (here `RPY_TEXTELEMENTS_INSERT`) and call it. Read the FM's source for
  hidden preconditions: its own `RS_ACCESS_PERMISSION` call may be gated on a lifecycle manager a
  plain API caller never binds, so the authorization + enqueue check is silently skipped unless
  you do it yourself before calling it.
- **A full-replace-per-call FM needs a read-merge-write wrapper**, and the merge granularity must
  be right the first time: match on **every** field that identifies one row (id **and** key), not
  just the outer grouping — otherwise a single-entry edit silently destroys its siblings.
- **CSRF is not automatic** on a custom `IF_HTTP_EXTENSION`: add it explicitly (`X-CSRF-Token:
  Fetch` issuance, validation on every mutating request) when the client's fetch flow will be
  used. A session cookie being issued proves routing stickiness only, not that session-scoped ABAP
  state (`EXPORT/IMPORT TO MEMORY ID`, SPA/GPA) survives across requests. Verify that live, or
  use `EXPORT/IMPORT TO DATABASE indx(<relid>) ID <key>` keyed by user, which sidesteps the question.
  Compute token age with `CL_ABAP_TSTMP=>SUBTRACT` — subtracting two `TIMESTAMP` values is not a
  number of seconds.
- **`TR_OBJECT_CHECK`/`TR_OBJECT_INSERT` can dump (`DYNPRO_SEND_IN_BACKGROUND`)** from a stateless
  HTTP handler: the path can pop an interactive Transport Organizer dialog with no screen. Look
  for an `i_dark_transport`-style parameter first; it routes through a headless CTS API with
  the same authority checks.
- **Give the TypeScript tool the ergonomics of a built-in one:** an `action` parameter rather than
  separate get/write tools; deletion as its own explicit signal, distinct from "write an empty
  value" (a blanked row and a deleted row differ); `offset`/`limit` paging on the read side —
  doable purely client-side (split the rendered text) when the ABAP side renders one entry per block.

## 2. Verifying what the engine really did

- **A headless/dialog-suppressed flag does not guarantee the outcome a human gets from the
  dialog.** `RS_CORR_INSERT` with `suppress_dialog='X'` avoids `CALL SCREEN`, but on exactly the
  conflict the dialog exists to resolve (an object already in a different open request) it silently
  no-ops — a "success" that changed nothing. Re-read the object/table afterwards (for
  `move_object`: `GetMeta resource=TRANSPORT` on both sides).
- **A UI engine can partly skip a save and still report success.** `CL_SUSO_APPL` makes an in-use
  object's fields display-only but still saves the rest and returns 0. Read the engine's edit
  modes up front (`GET_DATA_SUSO` `ED_EDIT_MODE_F`), check every setter's return code
  (`SET_DATA_SUSO` returns 8 on an empty field buffer and applies nothing), and re-read every table
  the save should have touched.
- **An engine built for an interactive UI may have no single-call path for a new record with
  content** — the UI owns the "new row" state. `CL_SUSO_APPL` only fills `TOBJ-FIEL1..FIEL0` when its
  private edit mode resolves to "change", never on a pure create. Sequence around it: create the
  bare record, then a second "change" pass attaching content — the same multi-step shape the UI
  produces.
- **If the engine's message log is private, run its checks yourself before the first save.**
  Otherwise a two-phase create fails in phase 2 with a bare "returned 8" and leaves a half-built
  record (`CHECK_SUSO`: `ACTVT` needs a `TACTZ` list). Create the exception's message class too, or
  every error is a bare `I:ZMYCLASS:008`.
- **A "check" FM can commit implicitly — prove the rollback before relying on it.**
  `ManageDynpro` first wrote the screen uncommitted, ran SE51's consistency check
  (`RS_SCRP_CONS_CHECK_TODO_SINGLE`) and rolled back on a finding; the tool said "nothing saved"
  while the screen was in the database: the check commits on its own, and so does a *successful*
  `GENERATE DYNPRO` (only a failed generation rolls back). Found with a two-case probe in one test
  method: insert → `ROLLBACK` (gone) vs. insert → check → `ROLLBACK` (survived), each verified with
  a fresh `SELECT`. Design that follows: validate everything you can *before* the first write; a
  check that commits can only *report* afterwards ("saved, but …" with an error flag). A standard
  check can also be unreliable in a particular sequence (SE51's missing-`CALL SUBSCREEN` finding was
  not reported for a screen created earlier in the same session) — re-implement a rule you depend on.
- **Two "lock" concepts can share a name in one API family — name which one a symptom points
  at.** A transport's stuck object entry carries `tm:lock_status="X"` and the same resource
  advertises a `lockobject` link titled "Lock Objects". It is unrelated: it toggles the regular ADT
  edit/enqueue lock, not the CTS registration flag that blocks deletion. A third lock
  (`IF_CTS_REST_API~LOCK`'s own `lock_handle`) was irrelevant as well; the real fix called
  `TR_DELETE_COMM_OBJECT_KEYS`, which handles its own `CTS_LOCK_TRKORR`/`CTS_UNLOCK_TRKORR`.
- **`get_text( )` of a `cx_static_check`-family exception truncates each placeholder to 50
  characters** through the T100 template. Read the exception's own `TYPE string` attribute instead
  whenever the text must carry more than a short label.

## 3. Before concluding "ADT cannot do this"

- **Read the resource controller.** Black-box probing said single message deletion was impossible
  (the PUT ignored omitted messages, the per-message URL rejected DELETE). Reading the code took
  minutes: `REGISTER_RESOURCES` in the package's `*_REST_RFC_APPLICATION` class maps each URL template
  to its handler class; `CL_ADT_MC_RES_CONTROLLER->DO_UPDATE` deletes only rows listed as
  `<mc:deletedmessages>` (element name from the simple transformation `ST_ADT_MESSAGE_CLASS`, readable
  at `/sap/bc/adt/xslt/transformations/{name}/source/main`). The same reading showed what is really
  missing (no long-text write) and a trap (`selfexplainatory="true"` + `documented="true"` deletes the
  long text). Use `GetCode resource=OBJECT` with `background=true` + `output_file` to keep large classes
  out of context and grep the file. Only then build an endpoint.
- **An advertised HATEOAS link can be registered (constant, title, relation URI) and still be wired
  to nothing.** `removeobject` on a transport's object entry looked like every working action
  (`moveobjects`, `lockobject`, `merge` …), but every probe silently no-op'd (HTTP 200, no effect)
  for all verbs, bodies and media types — which first looks like "wrong request shape". Only reading
  the dispatch class (`CL_CTS_ADT_TM_REST_RES_CONT`, the `CASE lv_action` in `post`/`put`) showed it
  never branches on that constant. When a plausible link no-ops on every shape tried, read the real
  dispatch source instead of trying more bodies; the metadata can lie about what is implemented.
- **When replicating a GUI feature, find the FM the feature itself calls.** `CTS_WBO_API_INSERT_OBJECTS`
  and `RS_CORR_INSERT` both "insert" into a request and have no reassignment capability; SE01/SE09's
  object-list "Move" calls a distinct FM, `TR_MOVE_OBJECTS`. A `SearchObject` for a name close to the
  feature's label (`*MOVE*`) found it in one query once the assumption "insert and move share a
  mechanism" was dropped.

## 4. Language-keyed writes

An ADT write that omits the target language does not fail — SAP fills the language key with blank.
`ManageObject MESSAGE_CLASS` 3.4.0 never sent `adtcore:language`, so an English correction wrote every
message of the class into `T100-SPRSL = ' '` while the tool reported "updated" (only the read-back
warning hinted at it). The true state showed only in a `T100` query over **all** languages, not in a
read of the target language. For any text object (messages, text pools, DDIC labels, documentation)
verify with `DataPreview` over the language-keyed table including the blank key, and expect ADT's own
metadata to be wrong about the master language (a class reported `EN` while `T100A` says `M`).

## 5. Probing without leaving sessions behind

Don't probe ADT with `X-sap-adt-sessiontype: stateful` requests. Each opens an ABAP session on the
instance (SM04) that only an ADT `UNLOCK` closes; a later stateless request carrying the
`sap-contextid` does not end it, so it lingers until the HTTP session timeout, and ad-hoc stateful
liveness probes plus force-killed test runs leave dozens behind for Basis to end by hand. The tools'
own write flows leave nothing behind. Sessions that do pile up are listed and ended with
`ManageSessions`. An UNLOCK's `Set-Cookie: sap-contextid=0; expires=1980…` *deletes* the cookie —
sending `0` back as a stateful request opens a new session. Probe stateless.
