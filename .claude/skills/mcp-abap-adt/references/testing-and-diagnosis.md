# Proving a change, diagnosing bugs, reviewing a change request

Load when you need evidence that a change is right, are chasing a hard bug or performance
regression, or are reviewing a transport.

## 1. The `$TMP` proof

Before a change reaches a productive package, prove the logic in a throwaway object. Create
a `FOR TESTING` class (e.g. `ZAB_<OBJECT>`, or a program with a local test class) with
`WriteProgram package_name=$TMP` and **no transport** — `$TMP` is local, so no request
exists or is needed — and run it with `RunUnitTest`. SAP executes the methods server-side
and returns PASS/FAIL per method with expected/actual values and the failing line; no GUI.
Move the logic into the real object only after all-PASS; never attach the test object to
the productive transport.

- **Changing existing logic — A/B.** One test method per case calls the original (A) and
  the new (B) logic over the same input and asserts equality. For tables a row-count match
  is not enough (a swapped value on a same-length table passes it): sort each side by its
  natural key, JSON-serialize and hash both (SHA-256) for an unambiguous identical /
  not-identical check. With a cache involved, call every key at least twice.
- **New logic — A-only.** Assert the output against expected values that come from a source
  **independent of the code under test**: the specification, a hand-worked example, a
  `DataPreview` cross-check of real data. A test that recomputes the expectation with the
  same algorithm passes by construction (a *tautological test*) and can never disagree with
  the code.
- **Watch each assertion go red once.** A test that never failed proves nothing — a wiring
  bug can make it pass vacuously (the classic case: A and B call the same code path).
  Perturb one input or expected value, run `RunUnitTest`, confirm the failure shows the
  perturbed value in expected/actual, restore, and only then trust the green.
- **Harvesting an unknown expected value from a red run — only for external facts.** When
  the value is an opaque fact you cannot look up (a standard BAPI's error message text),
  assert a deliberately wrong value, run it, read the real value from the failure detail
  and pin it. Never do this with the output of the logic being proven: that asserts what
  the code *does*, not what it *should do*.
- **Persistence is not proven by a test.** Each ABAP Unit test method runs inside an
  automatic rollback. A write (`INSERT TEXTPOOL`, a BAPI …) that is read back in the same
  method passes even if it never survives. To prove persistence use a second independent
  call, or a live round trip through the real caller (an HTTP endpoint, another tool call).
  Corollary: a probe FM that does not commit itself (e.g. `RS_SCRP_DELETE`) *appears* to
  work and is silently undone — commit explicitly in the probe and read results back with
  `DataPreview`.
- **Make sure the test exercises the layer the bug lives in.** When a live symptom
  contradicts an all-PASS suite, check which code path the tests actually run: a direct unit
  test of a class method can pass while the failure sits in another layer (an HTTP request
  parser the unit test never touches). Isolate with a pure logic test at the *suspect* layer —
  zero SAP calls if possible — before redeploying a guessed fix.
- **Identity.** `RunUnitTest` runs as the SAP user the MCP connection is bound to, never a
  user you name. For anything that depends on *which* account runs (authority checks,
  user-specific data, run-as designs) a green run proves only the connection user — treat the
  target account as unproven and test it under its own logon.
- **Scope.** Only `FOR TESTING` classes using `cl_abap_unit_assert` execute; there is no
  endpoint to run a plain report and capture its list. Structure the proof as assertions, not
  as a report that prints results. Tests run at risk level HARMLESS by default.
- **No test data in the connected client?** First make the proof self-contained (hardcoded
  fixtures, no DB reads). If it genuinely needs data the client lacks (check with
  `DataPreview`), deliver a `$TMP` test **program** (`WRITE`-based A/B output) for a person
  to run with F8 in a data-bearing client, and record the program name, the client and the
  expected result per case. This must not block the productive write; the proof moves to the
  validation step and is still owed before the change counts as done.
- **Pure-logic tests are cheap.** Three or four `RunUnitTest` rounds against a two-line test
  method beat repeatedly writing and activating the real object to see whether a guess took.

## 2. Validation gate for a performance or cache change

Identical output old vs new (every key twice when a cache is involved) → re-measure at
realistic volume → no memory dump at the largest realistic data set → sign-off by the owner
of the business process. Until all pass, the fix is *projected*, not done.

## 3. Diagnosis loop — hard bugs and performance regressions

Fixed order; each step gates the next. Use `GetDiagnostics resource=DUMP` for short dumps
(this is where `GETWA_NOT_ASSIGNED` and `TSV_TNEW_PAGE_ALLOC_FAILED` show up) and
`resource=TRACE` for SAT/SQL traces. `resource=GW_ERRORLOG` is the only tool reaching
Fiori/OData errors ("the tile won't load"); that buffer is short-lived and system-wide, so
capture the `entry_id` promptly.

1. **Feedback loop first — before any theory.** Build one repeatable check that goes **red on
   this exact bug**: a `$TMP` ABAP Unit method reproducing the symptom, run via
   `RunUnitTest`. For performance the red signal is a measurement — a `TRACE` baseline of the
   slow statement. If you catch yourself reading source to build a theory before the check
   exists, stop. If no check can be built (symptom only on production data you cannot reach),
   say so and ask for a captured artifact (dump id, trace id, concrete input values) instead of
   guessing. A symptom about *persistence* cannot go red in AUnit (§1) — use a live round trip.
2. **Minimise.** Shrink the red case — inputs, steps, data — one element at a time, re-running
   the check after each cut, until every remaining element is load-bearing. The minimal case
   becomes the regression test.
3. **Hypothesise — 3 to 5 ranked, each falsifiable.** Each states its prediction: "if X is the
   cause, changing Y turns the check green." A hypothesis with no stateable prediction is a
   vibe — sharpen or discard it. Show the ranked list to the user before probing; domain
   knowledge often re-ranks it instantly.
4. **Probe one variable at a time.** Each probe maps to one prediction. Tag every temporary
   debug statement with one unique marker (`"DBG-<slug>`) so cleanup is a single search. For
   performance do not probe with logs: measure with `TRACE`, bisect, measure again.
   *When probing over raw `curl`, rule out the curl invocation first:* a body passed with
   `-d`/`--data-binary '@…'` that happens to begin with a literal `@` (a wire format using
   `@MaxLength:N` framing) is read as "load this filename" and sent empty — 200 OK, read-back
   unchanged, which looks exactly like a server-side persistence bug. Pipe such payloads
   through stdin: `printf '…' | curl --data-binary @-`.
5. **Regression test before the fix**, at the seam where the bug occurs (a test that cannot
   reproduce the triggering call chain gives false confidence — if no honest seam exists,
   record that as a finding). Watch it fail → fix → watch it pass → re-run the original,
   un-minimised scenario.
6. **Cleanup.** All tagged probes removed (search the marker), `$TMP` scaffolds deleted or kept
   deliberately, and the *confirmed* hypothesis stated in the change comment / transport
   description so the next debugger inherits the answer, not just the diff.

## 4. ABAP Unit as a server-side probe harness — traps

1. Every test method ends with a rollback (see §1) — commit explicitly if the thing probed
   does not, and verify with `DataPreview`.
2. `RunUnitTest` runs harmless-risk / short tests by default (`risk_levels`/`durations` change
   that). A class with a higher risk level can therefore look exactly like "no test methods
   found" — declare probes `RISK LEVEL HARMLESS DURATION SHORT` (as this repo's own test classes do).
3. A probe is a convenient way to read system facts the ADT surface does not expose
   (`TH_SERVER_LIST`, `TH_USER_LIST`, FM behaviour): `cl_abap_unit_assert=>fail( msg = … )`
   returns arbitrary text. Delete the probe object afterwards.
4. Don't re-create a name you just deleted in the same session: an ADT `DELETE` removes the
   object but not the enqueue entry its `LOCK` set, so the name stays locked by the orphaned
   session until it times out ("User … is currently editing …"). An explicit `UNLOCK` after
   the delete releases it (`ManageObject MESSAGE_CLASS` does that). Use a new name for the next probe.

## 5. Slow calls and short-timeout clients

Some MCP clients kill a tool call after a few seconds. `RunATCCheck`, `GetCode`
(`WHEREUSED`, `ENHANCEMENTS scan_all=true`), `GetMeta resource=PACKAGE` and `DataPreview`
accept `background=true` + `output_file`: the call returns instantly with the file path and
the result (or the error — never lost) lands there when done. Read the file a few seconds
later. `output_file` also works synchronously on the fast getters — handy to put SAP's source
on disk for a byte-level diff. Never use background mode for writes: `WriteProgram` and
`ActivateObjects` stay synchronous so success or failure is never hidden.

**Oversized include?** A multi-thousand-line include can exceed the client's inline output
limit (a client-side limit, not the server's). Use `output_file`, or copy the overflow file
the client names straight into your working-copy folder, then read the ranges that need
judgement yourself and hand large independent ranges to a background sub-agent with an
explicit anti-pattern checklist — and spot-check its top claims against real line numbers
before trusting them.

## 6. Reviewing a change request

1. `GetMeta resource=TRANSPORT transport_number=…` — the object list.
2. Per object `GetCode resource=VERSION` list → pick the version *before* the change →
   `compare_to` for a unified diff. For a **class**, diff every include that has a version
   from the change (`class_include=implementations` for local classes, `testclasses`, …);
   `main` alone misses changes made only in local or test classes.
3. Read behavioural hunks against the checklist in `performance-patterns.md` §7;
   `GetCode resource=WHEREUSED` on changed FMs/classes sizes the blast radius.
4. Review **two axes and report them separately**:
   - **Standards** — performance, correctness, maintainability.
   - **Spec** — against the request or requirement (ask for it if not provided): requirements
     missing or partial, behaviour nobody asked for (scope creep), requirements implemented
     wrongly.
   Code can follow every rule yet implement the wrong thing, or do exactly what was asked while
   breaking conventions. Never let one axis mask the other.
5. `RunATCCheck transport_numbers=[…]` — several transports in ONE call (findings aggregate);
   priority 1 = error; a missing transport is reported as missing, never as a clean pass.
   Default `scope="transport"` keeps only findings on objects registered in the transport:
   ATC checks the whole compilation unit, so one new FM in a function group otherwise drags
   in every pre-existing finding of its siblings (one measured case: 388 lines for a single new
   FM, none on that FM). Use `scope="full"` only to assess the whole unit's health.
6. Report findings as `OBJECT(:include):line — severity — rule violated — fix`.

---
The diagnosis loop, the tautological-test and red-once rules, and the two-axis review are
adapted, rewritten in ABAP/ADT terms, from the `diagnosing-bugs`, `tdd` and `code-review`
skills of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT license).
