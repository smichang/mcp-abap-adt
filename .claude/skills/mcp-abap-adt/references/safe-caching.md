# Safe caching — removing redundant DB access without blowing memory

Load before adding a cache or memoizing a hot routine. The goal: fix "the same query runs N
times with the same inputs" without turning a slow program into one that **dumps**
(`TSV_TNEW_PAGE_ALLOC_FAILED`). Check your system's memory limits (`ST02`, profile
parameters `em/initial_size_MB`, `abap/heap_area_total`, `abap/heap_area_dia`); the numbers
below assume a typical 2 GB extended-memory quota and 4 GB heap per work process — replace
them with yours.

## 0. The 6 rules

1. **Diagnose first.** Cache only what a trace or SQLM proves redundant. Never on a hunch.
2. **Cache the call, not the table.** Memoize the *result* of an expensive FM/FORM/SELECT keyed
   by its *inputs* (`STATICS HASHED TABLE`).
3. **The key is the complete input set.** Miss one input and you serve wrong results.
4. **Watch for hidden side effects.** If the routine also writes module-global state, replay
   that effect on every hit — or do not cache.
5. **Bound every cache.** Cap entries, estimate worst-case bytes, evict when full.
6. **Budget the whole program against extended memory.** Sum all caches; keep the total a
   small fraction (~25%) — the program's working data competes for the same memory.

## 1. Diagnosis — when does this apply?

Confirm from a trace, not from reading code:

| Where | What flags it |
|---|---|
| ST12/ST05 SQL summary | "Redundant Identical Selects" **> 50%** on a statement that costs real time |
| ST05 value-identical statements | the exact same SELECT (same values) returning the same rows repeatedly |
| ABAP trace per module | a FORM/FM with high net-DB-time % and a high call count |
| ABAP trace per call | the redundant call sits inside a LOOP (BOM components, line items) |

Redundancy ≥ 50% **and** total ≥ ~1 s → worth caching; ≥ 80% → almost always a cache or
bulk-fetch win; < 30% → caching adds risk for little gain, skip.

## 2. Pick the technique

| Situation | Technique |
|---|---|
| Same FM/FORM called repeatedly with a small distinct-input set | memoization (`STATICS HASHED`) |
| SELECT in a loop over keys known up front | **bulk pre-fetch** (FAE/range once before the loop) — lowest memory risk |
| Small stable config/master table read many times | load once into a HASHED lookup table |
| Unbounded/unique inputs (GUID, timestamp) | **do not cache** — hit rate ≈ 0, memory grows forever |

**Prefer bulk pre-fetch when the keys are enumerable**: one FAE is more predictable than a
cache that grows as the loop discovers keys. Memoize only for keys known as you go, or FMs
you cannot restructure.

**Check who else calls the routine** (`GetCode resource=WHEREUSED`) before caching inside a
shared FM/FORM. Other callers have input patterns your redundancy analysis never saw. When
they exist, prefer a call-site-local cache in the hot program.

## 3. Memoization reference pattern

```abap
FORM get_expensive_data TABLES pt_result STRUCTURE <result_struct>
                         USING uv_in1 uv_in2 uv_in3.
  TYPES: BEGIN OF lty_cache,
           in1 TYPE <type1>, in2 TYPE <type2>, in3 TYPE <type3>,   " KEY: every input
           result TYPE STANDARD TABLE OF <result_struct> WITH DEFAULT KEY,   " VALUE
         END OF lty_cache.
  STATICS st_cache TYPE HASHED TABLE OF lty_cache WITH UNIQUE KEY in1 in2 in3.
  STATICS sv_count TYPE i.
  DATA ls_cache TYPE lty_cache.
  FIELD-SYMBOLS <ls_hit> TYPE lty_cache.

  REFRESH pt_result.
  READ TABLE st_cache ASSIGNING <ls_hit> WITH TABLE KEY in1 = uv_in1 in2 = uv_in2 in3 = uv_in3.
  IF sy-subrc = 0.
    pt_result[] = <ls_hit>-result.          " HIT — zero DB
    RETURN.
  ENDIF.

  PERFORM do_the_real_select TABLES pt_result USING uv_in1 uv_in2 uv_in3.   " MISS

  IF sv_count >= c_cache_max_entries.       " bound check (§6)
    CLEAR: st_cache, sv_count.              " simplest eviction: flush all
  ENDIF.
  ls_cache-in1 = uv_in1. ls_cache-in2 = uv_in2. ls_cache-in3 = uv_in3.
  ls_cache-result = pt_result[].
  INSERT ls_cache INTO TABLE st_cache.
  sv_count = sv_count + 1.
ENDFORM.
```

Every input that can change the output goes in the key. Selection-screen parameters constant
for the whole session may be excluded (pointless, not wrong). If you cannot list the inputs
with certainty, **do not cache yet** — a missing key field serves stale or wrong data, far
worse than slowness.

## 4. Hidden side effects

A routine's output is not only its exporting/`TABLES` parameter. If it also mutates global
state (`APPEND` to a global itab, `EXPORT TO MEMORY`, `SET PARAMETER`, `ENQUEUE`, DB writes),
a naive cache loses that on every hit. On a miss measure the delta (`DESCRIBE TABLE gt_global
LINES` before/after), store it in the cache value, and **replay it on every hit**
(`APPEND LINES OF <hit>-delta TO gt_global`). If it cannot be replayed faithfully, do not
cache.

## 5. The cache that lies — three hit/miss traps

The caller must not be able to tell whether the cache hit or missed. Each of these broke
that contract in production (wrong results; the cache had to be switched off):

1. **The miss path must return what it just stored.** A FORM that selects into a local table,
   copies it into the cache and ends — without filling its output parameter — returns
   **empty on the first call per key** and data on repeats (the same material at two BOM
   nodes shows two results). A single-pass smoke test never sees it: validation must call
   **every key at least twice** so miss and hit are both diffed.
2. **The hit path replays stored rows as-is — never re-derive the filter.** A hit branch that
   re-applies a "simplified" WHERE drops rows that qualified through a join-side predicate
   (`EXISTS … OR parent-item` cannot be re-evaluated from the stored row). Filter **once, at
   store time**; the hit returns rows unfiltered except structural exclusions (trap 3). Any
   parameter that shaped the filter must be in the key or provably constant for the cache's
   lifetime.
3. **Exclude the negative-cache marker structurally.** The blank "no result" marker row must
   be excluded by a field a real row always has (`CHECK …-AUFNR IS NOT INITIAL`), never by a
   caller-dependent business condition — otherwise some callers get the blank marker as data.

Comparator nuance: if the cache row type lacks `MANDT`, hit rows carry a blank client field
while a direct `SELECT *` fills it — harmless, but clear it before byte-diffing.

## 6. Memory safety

```
Roll area → Extended memory (quota) → Heap (PRIV mode) → DUMP
```

An unbounded cache does not degrade gracefully: it exhausts extended memory, forces PRIV mode
(pinning the work process, hurting the instance), then dumps. A cache that survives test data
can dump in production where the data set is 50× bigger.

**Size before you write:** `cache_bytes ≈ N_unique_keys × (key_width + avg_rows_per_entry ×
row_width)`, plus ~30–40% table overhead; `STRING`/`XSTRING` at real average length. A
realistic case may be a few MB while the pathological one (wildcard selection, bad
master-data day) is tens of GB — hence the cap is mandatory.

**Bound it** (increasing effort): hard cap + flush-all (fine when hits cluster locally);
hard cap + stop inserting (degrades to "no cache" for the long tail); LRU (best hit rate,
most code, usually overkill for a dialog step). Set the cap from the **byte budget**, rounded
down: `~200 MB budget, ~25 KB/entry → 8,000 → CONSTANTS c_cache_max_entries TYPE i VALUE 5000.`

**Lifetime, both directions**
- `STATICS`/`CLASS-DATA` live for the whole internal session and are not freed between dialog
  steps. Budget for the session peak; `CLEAR` at natural boundaries (start of each new
  `GET_DATA` run).
- **Lifetime also bounds the hit rate:** every `CALL FUNCTION … STARTING NEW TASK` opens a
  fresh internal session — all `STATICS`/global caches start **empty in every task**. A
  workload split into K parallel chunks pays the cold-miss cost K times; the cache code can
  be perfect while the trace shows `SELECT count ≈ tasks × keys per task`. Diagnosis: SQLM
  execution count far above any plausible key cardinality *although a correct cache exists*.
  Fix: bulk pre-fetch **at the task entry point** — the chunk's key set is known as soon as
  its driver data is selected; FAE-prefill the cache table once per task and keep the per-key
  routine as guarded fallback. Typical gain 40–70× and it **grows with N**, so a small A/B
  set understates the production gain. Memory is safe by construction (bounded by the task's
  own slice). Mind the three conversion traps in `performance-patterns.md` §4.

**Detect trouble:** ST22 `TSV_TNEW_PAGE_ALLOC_FAILED` (the smoking gun); SM50/SM66 work
process in PRIV mode; ST02 extended-memory/heap peaks and swaps; programmatically
`cl_abap_memory_utilities=>get_total_used_size( )`. Cheap test-time self-defence:
`DESCRIBE TABLE st_cache LINES DATA(lv_n). ASSERT lv_n <= c_cache_max_entries.`

## 7. Validate the fix

1. **Functional equivalence:** cached vs original on the same input — **byte-identical**.
2. **Re-trace:** same scenario; the redundant call's net time collapsed and redundancy %
   dropped.
3. **Memory check:** no PRIV mode / dump on the *largest realistic* data set.

Until re-trace and diff pass, the saving is projected, not measured. If the fix ships behind
a `TVARVC`/STVARV switch: that switch is client data — not transported, silently clearable.
Check the gate, not just the import status.

## 8. Pre-flight checklist

**Should I cache at all?** ≥ 50% redundancy and ≥ ~1 s total; inputs from a bounded set (not
GUID/timestamp); bulk pre-fetch is not a simpler fit.

**Correctness:** key = every input that affects the result; side effects replayed on hit (or
none); output byte-identical to the uncached version; miss path returns what it stored; hit
path returns stored rows as-is; negative marker excluded structurally; every key called at
least twice in validation.

**Memory:** worst case estimated; hard cap + eviction; all caches in the program sum to
< ~25% of extended memory; strings counted at real length; cleared at a session boundary; no
PRIV/dump on the largest realistic data set.

**Proof:** re-traced, redundancy and net time dropped as predicted; status flips from
*projected* to *validated* only after all of the above.
