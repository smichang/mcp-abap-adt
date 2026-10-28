# ABAP coding rules — style, strict-mode traps, exceptions, wide changes

Load when you write or change ABAP source. These are general SAP/ABAP practices plus
traps verified through this toolset. If the system already has its own conventions
(naming, headers, change markers, transport descriptions), follow those — **match the
object you are editing**.

## 1. Style

- Names: stay inside the customer namespace (`Z*`/`Y*`); meaningful names, no `f1`/`i1`;
  SAP's usual local prefixes (`lv_`, `ls_`, `lt_`, `lr_`, `lo_`) and `zcl_`/`zif_`/`zcx_` for
  classes, interfaces, exceptions. Methods start with a verb; types in classes `ty_`.
- **30-character identifier limit applies to more than object names.** The tools reject
  an over-long top-level object name on create, but they cannot see identifiers *inside*
  the source: method names, attributes and ABAP Unit test methods share the 30-character
  ceiling and fail only at activation (`The name "…" is longer than the allowed 30
  characters.`). Count them before writing.
- Indent 2 spaces, run Pretty Print. Readable negation: `IF var IS NOT INITIAL.`
- Modern type syntax: `TYPES tv_type TYPE c LENGTH 3.` not `TYPES tv_type(3) TYPE c.`
- No hardcoded texts (use text symbols so they can be translated) and no hardcoded
  plant/company/tax values — read them from Customizing tables (buffer the lookup if it
  lands in a loop).
- Modern ABAP (inline declarations, `VALUE`, `CORRESPONDING`, `LOOP … GROUP BY`, SALV) is
  welcome where it makes code clearer; keep it consistent with the object you are in.
- Classic reports: keep the main program thin and put code into includes by role (data,
  selection screen, events, forms, PBO/PAI, local classes); SAP's own wizards use
  `TOP`/`F01`/`O01`/`I01`. Order forms in call sequence.
- Comments: explain *why*. Commented-out old code needs an owner and a removal plan,
  otherwise delete it.

## 2. Database and internal tables

- Open SQL with an explicit field list; avoid `SELECT *` (see `performance-patterns.md`).
- `FOR ALL ENTRIES` only after `IF itab IS NOT INITIAL` — an empty driver table reads the
  whole table. De-duplicate the driver.
- `SORT` before `READ TABLE … BINARY SEARCH`; clear tables and work areas before filling.
- Check `sy-subrc` after every `SELECT`, `READ TABLE`, `CALL FUNCTION`, `CALL TRANSACTION`.
- **Do not write standard application tables directly** (`UPDATE`/`MODIFY`/`INSERT`/
  `DELETE` on AFVC, AFPO, AFKO, RESB, AUFK, VBAK, MKPF …): it bypasses status management
  (JEST), field derivations and locking and can leave documents inconsistent. Use the
  BAPI/API family (`BAPI_*`, `CO_XT_*`). If a field is truly not exposed: comment why,
  restrict the `WHERE` tightly, verify consistency afterwards. For whole BDC flows see
  `bdc-to-bapi.md`.

## 3. Output, forms, authorization

- ALV: `CL_GUI_ALV_GRID`/SALV for interactive reports; `REUSE_ALV_GRID_DISPLAY` only for
  simple lists.
- Smartforms: no business logic in the form — the driver program fetches and processes
  data. `SSF_OPEN`/`SSF_CLOSE` around a loop that prints many forms (avoids repeated
  spool dialogs). Amounts/quantities need valid reference fields; one form ↔ one style.
- Authorization: `AUTHORITY-CHECK` with the real `ACTVT` (not `DUMMY`) before sensitive
  actions; handle `sy-subrc <> 0` with a proper message. Create the authorization object
  with its final field list *before* writing the check (see `ManageObject AUTH_OBJECT`).

## 4. Traps that bite on activation or at runtime

### 4.1 Strict mode on newly activated objects

A freshly activated program is checked under **current** Unicode/strict rules even if the
code was cloned from an old, grandfathered program. Expect to fix:

- Comma-separated `SELECT` field lists (`SELECT a, b, c`) whenever `@` host variables /
  `INTO TABLE @itab` are used.
- Prefix **every** ABAP host variable with `@` in modern Open SQL — local variable, class
  attribute, formal parameter, classic `TABLES` parameter alike
  (`WHERE werks IN @pt_plant_list`).
- No `LIKE LINE OF` on a `TABLES` parameter — reference the DDIC structure.
- `FORM` parameter order is `TABLES → USING → CHANGING`.
- Operators and literals need surrounding spaces (`= 'X' OR`, not `'X'OR`).
- A column named like a variable/keyword (`LOW`/`HIGH` of `AGR_1251`) is fine in a select
  list but inside a `WHERE` expression or `BETWEEN` strict mode reads it as an unescaped
  host variable (`The variable "LOW" must be escaped using "@"`). Qualify it:
  `agr_1251~low`.

### 4.2 `LOOP … ASSIGNING … WHERE` dump

Never reference the loop's own field symbol in its `WHERE` clause — the `WHERE` is
evaluated before the symbol is assigned: `GETWA_NOT_ASSIGNED`. Bare column names are fine;
move the comparison into the body:

```abap
LOOP AT lt_tab ASSIGNING <fs> WHERE col_a IS NOT INITIAL.
  CHECK <fs>-col_a <> <fs>-col_b.
ENDLOOP.
```

### 4.3 New function module through ADT

The SE37 display format (`FUNCTION name.` + a `*"----` comment block listing the
parameters) is **rejected** for a new FM ("Parameter comment blocks are not allowed").
Use the inline signature, one period before the body, no comment block:

```abap
FUNCTION z_my_new_fm
  IMPORTING
    pi_matnr  TYPE matnr
  EXPORTING
    pe_result TYPE char10.

  " body
ENDFUNCTION.
```

Typing rules: `fm-parameter-typing.md`.

### 4.4 `SUBMIT` targets a program, never a function module

`SUBMIT` runs an executable report (`PROG/P`); only `CALL FUNCTION` runs an FM. When a
design pairs an RFC-callable FM with something run via `SUBMIT … VIA JOB` (background
step, run-as user), the piece that is submitted must be a **program** and follow program
naming — check the convention matches the object *type*, not the nearest existing name.

### 4.5 String templates drop an all-blank `CHAR` constant

`|{ co_prefix }{ lv_value }|` right-trims trailing blanks. If the constant is **entirely**
blank (an 8-space marker), it collapses to nothing, silently — for ASCII and double-byte
alike, so it is easily misdiagnosed as a codepage problem. Fixes that do **not** work:
`DATA(lv_entry) = co_prefix.` (infers CHAR8, later concatenation truncates) and
`lv_entry = co_prefix.` into a `STRING` (assignment drops the blanks). Concatenate the
constant directly into a `STRING` target:

```abap
DATA lv_entry TYPE string.
CONCATENATE co_prefix lv_value INTO lv_entry RESPECTING BLANKS.
```

Isolate this kind of bug with a pure string-logic ABAP Unit test (no SAP data) before
touching the real object again.

### 4.6 Internal language code ≠ ISO code

`SY-LANGU`/`SPRAS` is 1 character; ADT and modern APIs show the 2-character ISO code
(`adtcore:masterLanguage`). The mapping is a lookup (table `T002`, columns `SPRAS`/`LAISO`;
or `CONVERSION_EXIT_ISOLA_INPUT`/`_OUTPUT`), not a pattern: Traditional Chinese is `M` ↔
`ZF`. Passing the 2-char code where a 1-char field is expected silently truncates to a
*different, real* language (`ZF` → `Z`).

### 4.7 CHAR ↔ STRING at a method boundary

A DDIC-typed formal parameter can silently truncate an over-long actual value, and some
`CHAR` ↔ `STRING` combinations are not even compatible — a `CHAR4` constant passed to a
`TYPE string` parameter fails activation (`not type-compatible with formal parameter`).
When a parameter needs an explicit over-length guard (reject, don't truncate), type it
`TYPE string` on the public interface, convert after the length check, and wrap call
sites (including tests) in `CONV string( … )`.

### 4.8 Classic FM `TYPE C` parameters reject an inline expression

`suppress_exist_checks = xsdbool( … )` on `RPY_DYNPRO_INSERT` compiled and then dumped
`CX_SY_DYN_CALL_ILLEGAL_TYPE`. Pass a `CHAR1` variable. Only a test that really calls the
FM finds this.

## 5. Copying or duplicating a field list — verbatim only

LLMs reliably drop or shear characters when retyping long blocks of short, similar tokens
(`DATPER` → `DAT`, `LLFLG` → `FLG`), and merge or drop whole lines. The shape stays
intact, only the identifier is wrong, so a quick read misses it.

- **The live object is the source of truth**, never a screenshot or pasted excerpt. Fetch it
  (`GetCode resource=OBJECT`, `kind=STRU|TABL` for DDIC) and make the second version a
  **surgical edit** of the fetched text — `Edit` with literal `old_string`/`new_string` —
  so untouched lines are copied by the machine. Applies inside one object too: inserting
  rows into a field list must not touch the other rows' text.
- **Batch rename/move/relayout across many fields is a script's job.** Past a couple of
  lines, regex-extract the identifiers and apply the transform with Python/awk/sed.
- **Chunk long lists** (10–15 lines per pass); keep names in a code block and say they are
  preserved character for character.
- **Verify with a tool**, not by eye: extract all field names from before and after
  (`grep -oP '^\s*\K\S+(?=\s+TYPE)'` or a Python `set()`) and diff the lists. A line whose
  neighbours match but whose own name lost a prefix is this failure — a bug, not a rename.

## 6. Wide changes — expand → migrate → contract

A change whose blast radius spans many callers (FM signature, Z-table field, shared include
globals) cannot land atomically: every caller breaks at once and each transport must
activate green on its own. Size it first with `GetCode resource=WHEREUSED`, then:

1. **Expand** — add the new form beside the old (optional parameter, new field, parallel FM).
   Nothing breaks. One transport.
2. **Migrate** — move callers in batches sized by the where-used list. Each batch is its own
   transport with its own proof and activates green because the old form still exists.
3. **Contract** — delete the old form only when where-used shows **zero** callers.

The same sequencing governs BDC → BAPI migrations with many call sites.

## 7. Class-based exceptions

New object-oriented code uses class-based exceptions; `sy-subrc` checks remain where the
called API forces them (classic FM/BAPI, `AUTHORITY-CHECK`).

- Name `ZCX_<area>_<name>`. **One root exception per functional area** inheriting from
  `CX_STATIC_CHECK`; every specific error inherits from that root, so callers can catch
  broadly or narrowly.
- Default `CX_STATIC_CHECK` (must be in the method's `RAISING`, forces callers to decide).
  `CX_NO_CHECK` only for programming errors that are not part of the contract. Avoid
  `CX_DYNAMIC_CHECK` without a specific reason.
- Message-class-backed text via `IF_T100_MESSAGE` keeps error text translatable. **Check the
  hierarchy live** (`GetCode` on `CX_ROOT`/`IF_T100_MESSAGE`): on some systems the interface
  is not inherited and must be declared with `INTERFACES if_t100_message`. A non-final
  global exception class needs a (possibly empty) `PROTECTED SECTION`/`PRIVATE SECTION` —
  missing, it is an activation error.
- Create the message class too; otherwise every error reads like `I:ZMYCLASS:008`.
- **`get_text( )` truncates each placeholder to 50 characters** when rendered through the
  T100 template, even if the message class does not exist. For long diagnostics read the
  exception's own `TYPE string` attribute instead.

```abap
RAISE EXCEPTION TYPE zcx_sd_pricing_error
  EXPORTING
    textid   = zcx_sd_pricing_error=>condition_not_found
    gv_matnr = lv_matnr.
```

A foreign exception (BAPI, another class's `CX_*`) is caught and re-raised as this layer's
type with `previous` set, never leaked through a public interface:

```abap
TRY.
    lo_dao->read_stock( iv_matnr = lv_matnr ).
  CATCH cx_sy_open_sql_db INTO DATA(lx_db_error).
    RAISE EXCEPTION TYPE zcx_mm_stock_error
      EXPORTING textid = zcx_mm_stock_error=>db_read_failed previous = lx_db_error.
ENDTRY.
```

Don'ts:
- Don't catch what you cannot handle — a `CATCH` with no recovery/mapping/logging only to
  silence the syntax check hides the failure; add it to `RAISING` instead.
- Don't raise for expected outcomes ("record not found" in a lookup): return empty /
  `abap_false`.
- `CLEANUP` releases resources (locks, cursors, partial `MODIFY`s), it is not business
  recovery.
- Never swallow silently: at least application log (`BAL_LOG_*`) or `MESSAGE … INTO` with
  `lx->get_text( )`; an empty `CATCH … ENDTRY.` is a review finding.
- Don't use a generic/foreign exception class as your public contract.

**Test the failure path too**: one test with `cl_abap_unit_assert=>fail( )` inside
`TRY … CATCH INTO` for the happy case, and one asserting the specific exception subtype or
text for the error case. A `RAISING` clause no test exercises is unverified.
