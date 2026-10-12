# TODO

State at hand-off: initial public commit pushed to `main` (https://github.com/smichang/mcp-abap-adt). TypeScript compiles; nothing else has been verified against a clean system.

## 1. Verify on a clean SAP system (in progress — user deploys and connects)

Follow `abap-tasks/README.md` steps 1–6 and record what breaks.

- [x] Package `ZMCP` and parent SICF node `zmcp` created manually
- [x] Dispatcher classes written with `WriteProgram` and activated together: `ZCX_MCP_DISPATCH`, `ZCL_MCP_SICF_ADMIN`, `ZCL_MCP_DISPATCH`, `ZCL_HTTP_MCP_DISPATCH` (+ optional `ZCL_MCP_DISPATCH_TEST`, run with `RunUnitTest`) — all activated without errors, test class 8/8 passed
- [x] Manual node `dispatch` works: `ManageSicfNode action=ping method=GET` returns `pong`
  - [x] logon-data wording in the README corrected: Logon Procedure = *Alternative Logon Procedure*; "Basic Authentication ticked" removed
  - [x] `ZCL_MCP_SICF_ADMIN` set only `LOGIN_PROCESS = 'L'`, so generated nodes showed *Standard* in SICF; it now also sets `LOG_FLAG = 'X'` (as `dispatch` and `/sap/bc/adt` have). `textpool`, `auth_object`, `transport_admin`, `dynpro` were deleted and recreated; `ICFSERVICE` now identical to `dispatch` on the logon fields
  - [x] ABAP comments in `ZCL_HTTP_MCP_DISPATCH` / `ZCL_HTTP_MCP_TEXTPOOL` reworded to "Alternative Logon Procedure", rewritten on SAP and re-activated
- [x] `create_sicf_node` creates `textpool` under `default_host/zmcp` (created + activated; the logon procedure was not compared against `dispatch` in SICF)
- [x] Each remaining endpoint installs and answers: `textpool`, `auth_object`, `transport_admin`, `dynpro` (`textpool` and `dynpro` verified with a read; `auth_object` and `transport_admin` only with an error probe — no successful write run yet)
- [x] Fix `abap-tasks/README.md` wherever the steps differ from reality (parameter names, class order, message-class texts) — steps held up; added `source_file` path note, test-class commands and per-endpoint checks (step 4 logon wording still unchecked, see above)
- [x] Missing message classes: **not** all cosmetic. `ZMCP_DISPATCH` and `ZMCP_TEXTPOOL` are needed (their handlers use `get_text()`; without them errors read `I:ZMCP_DISPATCH:001 <action>`) — created, README now lists their texts. `ZMCP_AUTH_OBJECT` / `ZMCP_DYNPRO` are cosmetic (handlers build their own text) and stay optional
  - [x] `ZMCP_DYNPRO`: success paths exercised by `npm test` (`ManageDynpro` create / update / delete / check all passed on the live system)
  - [x] `ZMCP_AUTH_OBJECT` / `ManageAuthObject`: success path and error paths exercised live (2026-10-12) with the permanent anchor object `ZMCP_E2E01` (SU21 objects cannot be deleted); 3 integration tests added in `src/index.test.ts` (input validation, duplicate create, description update with restore)

Note: the renamed classes (`ZCL_HTTP_MCP_*`, `ZCL_MCP_*`, `ZCX_MCP_*`, `/zmcp/<node>`) have never run; only the original names on the system they were developed on were exercised.

## 2. Review the ABAP sources

- [x] Read `abap-tasks/zmcp-dynpro/` and `abap-tasks/zmcp-transport-admin/` line by line (all 7 classes). No logic bugs in the dynpro or transport-admin cores; findings are the CSRF expiry check and comment leftovers listed below
- [x] Review `abap-tasks/zmcp-auth-object/` (all 3 classes). Sound; only the shared findings below, plus: `validate_activities` matches `ACTVT` case-sensitively (callers upper-case it, so harmless); a two-phase create can leave a header-only object if phase 2 fails (validated up front to make that unlikely)
- [x] Re-check comments for leftover system-specific or dated remarks — scanned all 20 sources: no company or system identifiers. Leftovers to scrub:
  - [x] `ZCL_MCP_DYNPRO` / `ZCL_HTTP_MCP_DYNPRO` / `ZCX_MCP_DYNPRO` (scrubbed and rewritten on SAP): file headers with `Author: MCP`, `Created 2026/10/02`, an empty `RequestNo` column and a change log; `"20261002 MCP write phase - begin/end` markers in the code; a broken sentence `(see\n ).` (a reference lost in the scrub) at the top of `ZCL_MCP_DYNPRO`; a stray `!.` line in the screen-type doc comment
  - [x] `ZCL_MCP_TRANSPORT_ADMIN` (scrubbed and rewritten on SAP): "see the git history for the full account" (the public repo has one commit) and "The user pointed at the actual right feature"
  - [x] `ZCL_MCP_AUTH_OBJECT` (scrubbed and rewritten on SAP): "the way WriteProgram's CLAS/FUGR/FUNC names once did before that bug was fixed" refers to project history
  - [x] decided to keep: many "confirmed/verified live" comments refer to the original system; they are accurate provenance but read oddly in a public repo
- [x] **CSRF expiry check was wrong in all 5 handlers** — FIXED and live-verified (a token fetched at 13:11:54 and used at 13:12:06, across a minute boundary, is accepted with HTTP 200; wrong/missing token still 403; `ZCL_MCP_DISPATCH_TEST` 8/8). The old behaviour was found by reading the code and was not reproduced before the fix. (`ZCL_HTTP_MCP_DISPATCH/TEXTPOOL/AUTH_OBJECT/TRANSPORT_ADMIN/DYNPRO`): `lv_now - lv_issued_at2 > co_csrf_ttl_sec` subtracts two `TIMESTAMP` values (`YYYYMMDDhhmmss` as a number), which is not a count of seconds. Across a minute or hour boundary the difference jumps (a token 40 s old can read as ~4000), so a valid token is rejected with 403; within an hour the 900 limit is really about 9 minutes. The MCP client refetches the token on 403, so it works but wastes a round trip. Fix: `cl_abap_tstmp=>subtract( tstmp1 = lv_now tstmp2 = lv_issued_at2 )` (returns seconds; raises `cx_parameter_invalid_*`), only when the token was found. Found by reading the code; not reproduced live
- [ ] Design note, not a bug: one CSRF token per user (`INDX` row `CSRF_<user>`), so two clients logged in as the same SAP user invalidate each other's token (each then refetches)
- [x] `ManageTransport move_object` / `remove_object` success paths — verified live 2026-10-12: a disposable class in `ZMCP` moved from request A to B (a separate request listed it in B, not in A), removed from B's task (B's object list empty), then the class and both requests were deleted. No explicit `COMMIT WORK` is needed: the HTTP request's implicit commit persists the change

## 3. Tests

- [x] Run `npm test` against the clean system (93 tests: 92 passed, 1 skipped = opt-in transport release); anchor class defaults to `ZCL_MCP_TRANSPORT_E2E` in package `ZMCP` (override with `MCP_TEST_ANCHOR_CLASS` / `MCP_TEST_ANCHOR_PACKAGE`) — create it once, empty
- [x] Dynpro ABAP Unit class `ZCL_MCP_DYNPRO_TEST` written against standard screens (`SAPMSYST` 0070, `SAPLSPO1` 0100): list/read/JSON round trip/refusals, read-only; 15 tests, all passing on the live system (`abap-tasks/zmcp-dynpro/src/`)
- [x] Dynpro integration tests reworked: they hardcoded a customer program from the origin system; they now read `SAPMSYST` (standard) and copy its screen 0070 into the `$TMP` fixture `ZMCP_DYNP_W_E2E`, which the test creates itself in `beforeAll`. Also fixed `exception.test.ts` 2c (stale transport number in a regex). Dropped the type-`J` assertion — `SAPMSYST` has no selection-screen subscreen

- [x] **`npm test` failures with `400 Session not found` — cause found: an intermittent fault of the SAP system.** Proof (2026-10-12): `scripts/adt-session-check.js`, a bare HTTP client (no MCP server, no project code), replays LOCK → follow-up GET → UNLOCK; while the fault was active it failed on every object, including `ZCL_MCP_DISPATCH_TEST` that had locked/unlocked cleanly an hour earlier, and a fully green `npm test` (95 passed, 1 skipped) happened while the system was healthy. The fault comes and goes by itself (the original project documents the same in `plan/TODO.md`). Consequences: (1) each failed write leaves an edit lock, cleaned with `UnlockObject force=true`; (2) earlier theories — parallel Jest workers, a stale MCP-server cookie/CSRF cache, mixing ADT and `/zmcp/*` calls in one process — were wrong or unproven and are dropped; (3) the lock report matches whole names, so my "no locks" checks with the prefix `ZMCP` proved nothing; (4) before running `npm test` run `node scripts/adt-session-check.js /sap/bc/adt/oo/classes/<own class>`. Still open for Basis: why SAP loses stateful sessions (SM04 sessions marked R=3, `dev_icm`, SM21 at the failure times)
- [x] `UnlockObject force=true` — DONE, now identical in code to the original project's committed version (`ZCL_MCP_LOCK_ADMIN`: whole-name match, padding stripped, `ENQUE_DELETE`; `handleUnlockObject.ts`: success wording; CSRF check block copied verbatim from the original in all 6 HTTP handlers). Live-verified twice: on 5 orphan locks (programs, class, message class) and on a lock held by a live session (plain unlock refused, force deleted it, plain unlock then free); (ported from the original project; the original called a function module that does not exist — `ENQUEUE_DELETE` — so the delete step failed with HTTP 500 on first contact; fixed to `ENQUE_DELETE`, redeployed after SM12 cleared the lock the failed write left): classes `ZCL_MCP_LOCK_ADMIN` / `ZCL_HTTP_MCP_LOCK_ADMIN` deployed and active, node `default_host/zmcp/lock_admin` created, endpoint verified in report mode (it listed exactly the orphan `TRDIR ZMCP_WRITE_E2E`); still to verify through the tool after an `/mcp` reload: a real delete of that orphan, then `UnlockObject` without force reports it free. Docs updated (CLAUDE.md, abap-tasks/README.md, skill). Also fixed the `UnlockObject` schema: `object_type` sat outside `properties`
- [x] **`ManageSessions` (list / end own ABAP sessions)** — cloned from the original project (plan: `plan/20261012-manage-sessions.md` there), deployed (`ZCL_MCP_SESSION_ADMIN`, `ZCL_HTTP_MCP_SESSION_ADMIN`, node `session_admin`), 4 integration tests, and a real `end` verified live on a throwaway session (see CLAUDE.md → ManageSessions Tool). Still unverified: a second application server (only one here) and the effect on a client mid-sequence. Open follow-up: the two `regex =` POSIX warnings at activation (`pcre =`); and the `still there` false alarm — the end verification compares only `server:tid`, and a reused slot makes a successful end look failed (first real use through the MCP tool: ended tid 28, reported `still there`, the next list showed the slot taken by the request's own new session). Fix in the original first: compare tid + logon time (+ term)
- [x] Robustness: `makeAdtRequest` now handles `400 Session not found`: it drops the stored cookies and CSRF token, and retries once unless the request carried a `sap-contextid` (a stateful sequence must fail, its lock lived in the dead session). Built; **not exercised live** — the fault could not be provoked on demand, and a stale cookie without a context id normally just gets a new session
- [x] **`exception.test.ts` overwrote someone else's program**: test 4f took the first `ZTEST*` hit (a program owned by another developer) and 4g–4i rewrote it (same source, syntax-error source, then restored). Earlier `npm test` runs did this at least twice on this system. Now the suite creates and uses its own `$TMP` fixture `ZMCP_WRITE_E2E`.

- [x] Skill content ported from the private project's in-house skill (read in full): 8 new files in `.claude/skills/mcp-abap-adt/references/` (`abap-coding-rules`, `fm-parameter-typing`, `performance-patterns`, `safe-caching`, `bdc-to-bapi`, `testing-and-diagnosis`, `write-and-transport-details`, `custom-endpoints`) plus a routing table in `SKILL.md`. Dropped as house policy: naming prefixes/module codes, header banner and change markers, transport-description pattern, plan/lessons-learned protocol, system and object names. Not taken: the vendored GPL SQLScript extras
- [x] Older internal references (message class name, private repo name, old package name, another developer's program) scrubbed from `CLAUDE.md` and `TODO.md`; they still exist in earlier git commits
- [x] **Agent skill on a size budget** — `SKILL.md` body 942 words (limit 1,100; was 1,910), every bullet ≤ 40 words, description 354/400 characters, each reference ≤ 2,200 words. The recovery procedure moved to `references/recovery.md` (about 330 words) and `SKILL.md` keeps a pointer; `npm run check:skill` (`scripts/check-skill-size.js`) fails when a limit is exceeded. Open: the same trim in the original project's skill, and running the check from CI or a test

## 4. Release hygiene

- [ ] GitHub description and topics
- [ ] Tag `v3.5.0` (matches `package.json`; same version number as the private sibling project, whose 3.5.0 contains the same ManageSessions work) and write release notes from `CHANGELOG.md`
- [ ] Decide on npm publishing (package name is `mcp-abap-adt`, unpublished)
- [ ] Verify `Dockerfile` and `smithery.yaml` (inherited from upstream, untested here)
- [ ] Trim `CLAUDE.md` if it is too internal for a public repo
- [ ] Optional: add `README.zh-TW.md` again, scrubbed (the private repo has one)

## 5. Keeping the private and public repos in sync

The public copy diverged from its private origin project: endpoints renamed to the `ZMCP` scheme, no transport-description naming check, no git history, no `plan/` or `reference/` folders, and no in-house skill (its technical content is ported).

- [ ] Decide the direction of future changes (public first, or private first)
- [ ] If private first: script the scrub (rename map in `abap-tasks/README.md`, remove the naming check, strip company identifiers) instead of redoing it by hand

## Notes

- GitHub SSH (port 22) times out on the dev machine; `origin` uses HTTPS.
- The skill lives in `.claude/skills/mcp-abap-adt/`; update it when tool behavior changes.
