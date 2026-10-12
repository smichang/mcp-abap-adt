# Performance patterns — anti-pattern catalog, fixes, review workflow

Load for performance work or when reviewing a change. Examples use standard SAP tables.
Use `GetDiagnostics resource=TRACE`, `DataPreview` (row counts, key distribution) and
`GetCode resource=WHEREUSED` as evidence — diagnose before you fix.

## 1. The pattern that matters most — N+1 vs. pre-fetch

Validating or enriching each row of an internal table with one database hit per row.

```abap
" BEFORE — one DB call per row
LOOP AT lt_input ASSIGNING FIELD-SYMBOL(<ls>).
  SELECT SINGLE ekgrp INTO @<ls>-ekgrp FROM marc WHERE matnr = @<ls>-matnr
                                                   AND werks = @<ls>-werks.
  SELECT * INTO TABLE @lt_cfg FROM t685a.          " worst: full table, every row
ENDLOOP.
```

```abap
" AFTER — collect keys, ONE set-based read, then read in memory
LOOP AT lt_input ASSIGNING FIELD-SYMBOL(<ls>).
  gs_mat-matnr = <ls>-matnr. COLLECT gs_mat INTO lt_mat.
ENDLOOP.
IF lt_mat IS NOT INITIAL.
  SELECT mara~matnr, marc~werks, marc~ekgrp
    INTO CORRESPONDING FIELDS OF TABLE @lt_mat
    FROM mara INNER JOIN marc ON marc~matnr = mara~matnr
    FOR ALL ENTRIES IN @lt_mat
    WHERE mara~matnr = @lt_mat-matnr.
  SORT lt_mat BY matnr werks.
ENDIF.
LOOP AT lt_input ASSIGNING FIELD-SYMBOL(<ls2>).
  READ TABLE lt_mat INTO gs_mat WITH KEY matnr = <ls2>-matnr werks = <ls2>-werks BINARY SEARCH.
  IF sy-subrc = 0. <ls2>-ekgrp = gs_mat-ekgrp. ENDIF.
ENDLOOP.
```

Round trips fall from O(rows × lookups) to O(distinct keys) — typically two or more orders
of magnitude.

### Review rule — verify the fix is actually wired in

A "performance" change can add the buffer and helper routines and still leave the per-row
`SELECT`s running — call sites never switched over, or the new path is commented out or
behind a flag that is off. A large diff is often mostly reformatting. Confirm that

- the hot **call site actually reads the buffer**;
- the buffer is **populated on every executed path** (watch `CHECK`/`IF` guards that skip
  population for some modes or transaction codes);
- commented-out alternatives are dead code needing an owner and a removal date;
- you diffed the **behaviour**, not the line count.

## 2. Anti-pattern catalog

| # | Anti-pattern | Why it hurts | Fix |
|---|---|---|---|
| P1 | `SELECT` inside `LOOP/DO/WHILE` | one round trip per row | pre-fetch (FAE/JOIN) + `BINARY SEARCH`/hashed read |
| P2 | No-`WHERE` read or `SELECT *` inside a loop | full-table scan per row | hoist out; named fields, selective WHERE |
| P3 | Nested `LOOP AT itab WHERE` on STANDARD tables | in-memory O(n²)–O(n³) | SORTED/HASHED secondary key + `USING KEY`, or pre-group |
| P4 | `SELECT … ENDSELECT` for one row | cursor overhead, accidental loop | `SELECT SINGLE` (full key) or `UP TO 1 ROWS` |
| P5 | FAE without empty-check / dedup | empty driver reads *everything*; duplicates waste I/O | guard `IS NOT INITIAL`; `SORT` + `DELETE ADJACENT DUPLICATES` |
| P6 | `SELECT *` when few fields used | wide rows; on redirected tables defeats join pruning (§3) | explicit field list; CDS projection |
| P7 | Re-reading config/check tables per call | repeated identical I/O | buffer once (global/static itab) |
| P7b | Correct cache defeated by parallel-RFC fan-out | every `STARTING NEW TASK` is a fresh session = cold cache; SELECT count = tasks × keys per task | bulk FAE-prefill the cache **at the task entry point**; keep the per-key routine as guarded fallback (§4, `safe-caching.md` §6) |
| P8 | Per-row aggregation (`SELECT SUM` in a loop) | one aggregate query per row | one `GROUP BY` query, or `COLLECT` over a pre-read set |
| P9 | Chain of FAE selects assembled in ABAP | several round trips + manual join | single multi-table JOIN or CDS view |
| P10 | BDC / `CALL TRANSACTION` screen simulation | full dialog stack per step; fragile | direct BAPI/API — `bdc-to-bapi.md` |
| P11 | Unbounded `SELECT` on a growing transactional table | reads the entire history, slower every day; filtering happens in ABAP | date/org/status range **in the WHERE**; bounding screen fields `OBLIGATORY` or defaulted (§5) |
| P12 | Settling for the compat view — or hand-rolling the raw backing table | compat view pays a materialization cost per call; the raw table is unsupported and a correctness trap | find the fastest **supported** source (§3.2) |

## 3. S/4HANA redirect traps

Tables such as `MBEW → MBVMBEW`, `MSEG → NSDM_V_MSEG`, `MSKAH → NSDM_V_MSKAH` are redirected
to compatibility views that **re-aggregate MATDOC / Material Ledger data on every call**: a
"single-row read" can re-scan document history, and an N+1 loop over one is catastrophic.
Spot a redirect: the table's DDIC source carries `@AbapCatalog.replacementObject`.

### 3.1 P6 on redirected tables — the column list is half the fix

Fixing the N+1 shape (loop → one FAE) is not the same as fixing the column list. `SELECT *`
through a calculated/compat view forces the database to materialize every join branch; a
narrow named field list lets HANA's join pruning skip the branches the columns do not need.
In one measured case (`MBEW → MBVMBEW`, 5-table ML join) base-table-only fields were ~33×
faster than `SELECT *`, and a partial narrowing (8 fields, some ML-tied) still ~2.3×.

Review signals: `SELECT *` / unfielded `INTO CORRESPONDING FIELDS` against a redirected or
wide master-data table; a SELECT that survived an N+1 fix but whose column list was never
narrowed (the usual blind spot — the diff *looks* finished once round trips drop); a
receiving structure declared `LIKE <table>` (full width), which hides how wide the SELECT is.

**A dev/QA A/B measurement of a P6 fix is a floor, not the production gain** — the
materialization cost scales with the volume behind the view. Use the smaller system to prove
correctness (value parity per key); take the expected speedup from production per-call time
(SQLM `RTSUM/XCNT`, plan cache).

### 3.2 P12 — find the fastest *supported* source

Ranking: raw backing table (**never** — internal API, and one logical line can be several
physical rows: cancellations, reversals, account splits — you would re-implement the
collapse logic and get it wrong) < compatibility object (safe default) < released CDS view
on the backing table (fastest, once validated).

1. Check DDIC for `@AbapCatalog.replacementObject` — a redirect means headroom may exist.
2. Look for a released CDS view on the same business object: `lifecycle.contract.type:
   #PUBLIC_LOCAL_API` and **no** `lifecycle.status: #DEPRECATED` (the first hit is often the
   deprecated one — e.g. `I_MaterialDocumentItem` is deprecated in favour of
   `I_MaterialDocumentItem_2`). Read its `FROM` clause: a single-table select straight off
   the physical table does the compat view's row-collapse without its materialization cost.
3. Never hand-roll a SELECT on the raw backing table (`MATDOC` etc.).
4. **Benchmark before cutover** (`M_SQL_PLAN_CACHE`) and validate row-set parity **and** any
   DCL row-level authorization the CDS view enforces that the raw table never had — a table
   swap can silently change *which rows each user sees*.

**The released view can lose.** For `MBEW`, `I_MaterialValuation` (selects directly from
physical `mbew`) measured ~1.8× *slower* than a narrow field-list read through the compat
view. If the compat view's job is row-collapse **aggregation** (MSEG → MATDOC), that work runs
regardless of the column list, so a released view on the physical table wins. If its cost is
only **prunable join branches** (MBEW → MBVMBEW), a narrow compat read is already near
physical speed and a UNION-of-N released view adds probes on every call.
Rule of thumb: narrow the field list first (P6); if the residual cost is aggregation, hunt
for the released CDS view (P12); if it was only prunable joins, the narrow compat read wins.

## 4. Converting per-key single reads into a bulk FAE prefill — three traps

1. **Row multiplicity.** A per-key `SELECT … UP TO 1 ROWS … ORDER BY PRIMARY KEY` returns one
   *deterministic* row per key; an FAE on the same **partial** key returns **all** matching
   rows (`MBEW` under split valuation: one row per `BWTAR`). The naive prefill inserts an
   arbitrary row or dumps on a unique-key cache table. Replicate the single-read semantics:
   `SORT lt_res BY <full primary key>. DELETE ADJACENT DUPLICATES FROM lt_res COMPARING
   <cache key only>.` Small test data never exercises this — put a multi-row-per-key case
   in the validation set.
2. **Cache-key fidelity.** Prefill with **exactly the field the getter is called with** —
   same field, same length, same conversion state (18-char `MATERIAL` vs 40-char
   `MATERIAL_LONG`). A mismatch fails **no test** (the guarded per-key fallback still returns
   correct values); the hit rate just collapses and the N+1 survives. Read the getter's
   *call site*, not the structure definition.
3. **FAE driver ≠ INTO target.** Classic ABAP forbids `FOR ALL ENTRIES IN itab … INTO TABLE
   itab`, and trap 1 often forces the FAE result to carry key fields the cache row lacks —
   declare a local result type, dedup there, then move into the cache.

Validate by running old and new paths over the same key set and comparing **captured values
per key** (not row counts), including a multi-row-per-key case.

## 5. P11 — bound the range in the database, not in ABAP

Bad: `SELECT` everything, then `DELETE itab WHERE …` in memory — I/O scales with table
history. Good: put the restriction in the `WHERE` (date/time range on `erdat`/`budat`/
`fkdat`/fiscal period, org keys `bukrs`/`werks`/`vkorg`, status/document type) and make the
bounding selection-screen fields **`OBLIGATORY` or defaulted** (e.g. last 3 months) so an empty
screen cannot trigger a full read. `UP TO n ROWS` is a safety cap only — without `ORDER BY`
it returns arbitrary rows; never the sole restriction.

Review signals: a transactional-table `SELECT` with no `WHERE` (or only non-selective flags);
`DELETE itab WHERE` / `LOOP … CHECK` right after a broad `SELECT`; optional undefaulted
date/org fields; open-ended period ranges (`LFGJA < @year OR …`) reduced afterwards with
`DELETE ADJACENT DUPLICATES` — prefer exact period equality when only one slice is needed.

## 6. Positive patterns

- Pre-fetch + buffered read (§1); keep a guarded single-`SELECT` fallback only when a key can
  legitimately be absent.
- Collapse FAE chains into one JOIN or a CDS view; add a column via JOIN, not a per-row lookup.
- Push computation down: CDS views (parameters, `WHERE` push-down, `CASE` fields) and
  AMDP/SQLScript for heavy set logic.
- Roll out risky reworks behind a config switch with the old path as instant fallback — but a
  `TVARVC` switch is **client data**: not transported, silently clearable. Verify the gate is
  on in the target system before declaring the fix live, and ask why before re-enabling a
  switch someone turned off.
- Split oversized monolithic includes; de-hardcode with data (buffer the lookup in loops).
- Always read through the fastest **supported** source, not just a working one.

## 7. Review checklist

**Performance**
- [ ] No `SELECT` in `LOOP/DO/WHILE` (P1); no `WHERE`-less or `SELECT *` reads in loops (P2/P6).
- [ ] Master/check data pre-fetched once, read via `BINARY SEARCH`/hashed (P1/P7).
- [ ] "Performance" change: optimization wired into the call site, buffer populated on every path.
- [ ] FAE drivers empty-guarded and de-duplicated (P5); no nested `LOOP AT WHERE` on STANDARD tables (P3).
- [ ] Aggregation set-based (P8); WHERE clauses index-supportable; screen ranges passed to the DB.
- [ ] No unbounded transactional-table reads; bounding fields `OBLIGATORY`/defaulted (P11).
- [ ] Heavy/batch logic uses CDS push-down or AMDP where appropriate (P9).
- [ ] Redirected tables: released-CDS alternative evaluated; no raw backing-table reads (P12); named field lists (P6).

**Correctness**
- [ ] `sy-subrc` checked after every `SELECT`, `READ TABLE`, `CALL FUNCTION`, `CALL TRANSACTION`.
- [ ] `AUTHORITY-CHECK` with explicit `ACTVT` on sensitive actions.
- [ ] No double-counting of quantities/amounts across joins/loops.
- [ ] Exceptions handled, no silent failures, explicit `COMMIT`/`ROLLBACK` on writes.
- [ ] **Serialized payloads:** when a parser splits on delimiters, no free-text field can
      contain *any* of them (line, field, key/value) — not just the reported one. A read-back
      that compares against the parsed target cannot catch truncation; prove it with a value
      mixing every separator, re-read independently via `DataPreview`.
- [ ] FM signatures follow `fm-parameter-typing.md`.

**Maintainability**
- [ ] Commented-out code has an owner and removal plan; oversized includes split.

**Spec** — a separate axis (see `testing-and-diagnosis.md` §6): does the change do what was asked?

## 8. Reviewing a change request

1. Identify changed objects from the transport; keep the logic-bearing ones (programs,
   includes, FM includes, classes, enhancements, CDS).
2. `GetCode resource=VERSION` — pick the pre-change baseline and the post-change version.
3. Diff with `compare_to`; read **behavioural hunks**, ignore whitespace/case churn.
4. For very large includes locate the edit and run an N+1 detector over the saved source:

```bash
# flag SELECT statements running inside a LOOP (depth>0)
awk '/^[[:space:]]*LOOP[[:space:]]+AT/{d++} /^[[:space:]]*ENDLOOP/{if(d>0)d--} \
     /^[[:space:]]*SELECT/&&d>0{printf "L%-5s depth=%d: %s\n",NR,d,$0}' FILE.abap | grep -v ENDSELECT
```

5. Run the checklist above; record per object: what changed, performance verdict, notes.
