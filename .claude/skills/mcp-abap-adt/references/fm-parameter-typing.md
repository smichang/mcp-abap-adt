# Function module parameters — TYPE vs LIKE, TABLES, RFC

Load when you write or change a function-module signature, or flip a module to
remote-enabled with `ActivateObjects rfc_enabled`. (The inline header requirement is in
`abap-coding-rules.md` §4.3.)

## 1. The rule

`TYPE` binds a parameter to a *type* (data element, domain, structure, table type, local
`TYPES`). `LIKE` binds it to the type of an existing *data object* (a table field, a
variable, an earlier parameter, a system field) and silently follows it. **Default to
`TYPE` with the real DDIC type.** Confirm a field's data element with
`GetMeta resource=TYPEINFO|DDIC` instead of guessing from the field name.

| Scenario | Use | Example |
|---|---|---|
| Field has a data element/domain (normal case) | `TYPE <data element>` | `pi_matnr TYPE matnr` |
| DDIC structure or table type | `TYPE <structure/table type>` | `pi_data TYPE zst_data` |
| Must always equal another parameter of the *same* interface (copy/echo FMs) | `LIKE <other parameter>` | `EXPORTING pe_copy LIKE pi_original` |
| Field has no data element — last resort | `LIKE <table>-<field>` | `LIKE bapiret2-message` (first check a data element exists, e.g. `BAPI_MSG`; then use `TYPE`) |
| Generic/utility parameter, FM never called over RFC | `TYPE ANY` / `STANDARD TABLE` / `ANY TABLE` / `CLIKE` — `LIKE` cannot reference a generic type | `pc_data TYPE ANY` |
| Object reference, never RFC | `TYPE REF TO <class/interface>` | `pi_handler TYPE REF TO zif_handler` |
| Classic `TABLES` row type | `LIKE <DDIC structure>` (§2) | `TABLES pt_vbap LIKE vbap` |

`LIKE <data element>` is invalid ABAP (`LIKE matnr` → must be `TYPE matnr`); only a
component (`LIKE tab-field`) or a data object is a legal `LIKE` target.

## 2. `TABLES` parameters: `LIKE <DDIC structure>`

Written through ADT's inline signature, the row type **must** be `LIKE <dbtab-or-structure>`:

```abap
FUNCTION z_mm_get_open_pos
  IMPORTING
    pi_werks TYPE werks_d
  TABLES
    pt_ekpo LIKE ekpo.
```

- **`STRUCTURE` is rejected** in ADT inline signatures: `TABLES pt_x STRUCTURE bapiret2` →
  `WriteProgram` fails with *"Parameter PT_X declares no type"*; `LIKE bapiret2` activates
  (live-verified twice; ADT's own read-back of `BAPI_USER_GET_DETAIL` uses `return like
  bapiret2`). `STRUCTURE` survives only in SE37's form-based tab and in `FORM … TABLES`.
- `TYPE` is not accepted on a `TABLES` parameter at all, and `LIKE LINE OF <itab>` is
  rejected here: the type must be anchored in the DDIC.
- Internal-only FMs may use `IMPORTING/EXPORTING/CHANGING … TYPE STANDARD TABLE OF <line>`;
  `TABLES … LIKE <flat structure>` stays the most compatible form for RFC clients,
  including non-ABAP ones.

## 3. RFC-enabled FMs

`ActivateObjects(rfc_enabled={…})` flips the Remote-Enabled flag and activates in the
same call. SAP checks RFC-compatibility **there**, not at `WriteProgram` — a badly typed FM
writes and syntax-checks clean and fails only when flipped. Check before toggling:

- Every `IMPORTING/EXPORTING/CHANGING` parameter: `TYPE` of a flat elementary type or a flat
  (non-nested) structure. Deep structures, generic types and object references are rejected.
- `TABLES`: `LIKE <flat structure>` — but see §5 before reusing a wide standard structure.
- `LIKE` hides whether the type is flat; resolve it, or write `TYPE` with the flat type.
- **Every `IMPORTING/EXPORTING/CHANGING` parameter must be `VALUE(…)`** — pass-by-reference
  on *any one* fails activation (live-verified):
  `RFC/UPDATE: In RFC modules, only parameters with pass by value are allowed`. The message
  does not name the parameter, and `VALUE()` on EXPORTING alone is not enough. `TABLES`
  takes no `VALUE()`.

  ```abap
  FUNCTION z_my_rfc_fm
    IMPORTING
      VALUE(pi_input)  TYPE string
    EXPORTING
      VALUE(pe_output) TYPE string
    CHANGING
      VALUE(pc_data)   TYPE string
    TABLES
      pt_items         LIKE zst_item.
  ```

  `VALUE()` parameters copy back only on normal return, so an uncaught exception discards
  what was written — never signal partial success through one; use a status/return structure.
- **A classic `EXCEPTIONS` list loses the exception's text.** `CATCH cx_x. RAISE some_name.`
  only sets `sy-subrc` for the caller; a JCo/non-ABAP caller sees an opaque code. Use
  `CATCH cx_x INTO DATA(lo_cx).` and return `lo_cx->get_text( )` through a normal
  result/message `EXPORTING` parameter. (This is how a missing-authorization cause became
  visible in an RFC FM wrapping a kernel API.) Write it this way from the start.
- **A wrapper that mirrors a GUI action may not be RFC-safe.** A correctly named FM can
  forward to the underlying logic with a dialog parameter at its unsafe default
  (`dialog = 'X'` → `POPUP_TO_CONFIRM`/`CALL SELECTION-SCREEN`, no screen under RFC). Read
  its body for dialog/interactive parameters and check the default, not just the signature.

## 4. Classes and methods: `TYPE` only

FMs and `FORM`s accept `TYPE` and `LIKE`; **method signatures accept `TYPE` only**. When
moving logic from an FM into a method, resolve every `LIKE` to a concrete `TYPE` first.

## 5. Reusing a standard DDIC structure — internal FMs only

For an FM that is **never RFC-enabled**, check whether a standard structure already has the
field set needed (e.g. `T158B`, `T156N`, `T150` for movement-type lookups) and reuse it
rather than creating a custom structure with its own transport and lifecycle.

**Not for an RFC-enabled FM consumed over JCo/non-ABAP.** The `SELECT` field list bounds
what is *populated*, not what is *serialized*: RFC marshals the row by its declared type, so
every column of the reused structure crosses the wire, and a non-ABAP caller sees the
full schema of an internal configuration table (and, if the `SELECT` is later widened, its
data). For RFC-facing results design the narrow shape first: explicit, bounded scalar
`EXPORTING` parameters naming only the approved fields.

## 6. Worked example

```abap
FUNCTION z_sd_copy_order_header
  IMPORTING
    pi_vbeln      TYPE vbeln_va           " data element -> TYPE
    pi_werks      TYPE werks_d OPTIONAL
  EXPORTING
    pe_vbeln_copy LIKE pi_vbeln           " mirrors pi_vbeln -> LIKE
    pe_return     TYPE bapiret2           " DDIC structure -> TYPE
  TABLES
    pt_vbap       LIKE vbap               " classic TABLES row -> LIKE
  EXCEPTIONS
    not_found.
  " body
ENDFUNCTION.
```

Plain (non-RFC) FM, so pass-by-reference is fine. Before flipping it to `rfc_enabled`, add
`VALUE()` to `pi_vbeln`, `pi_werks`, `pe_vbeln_copy` and `pe_return`.

## 7. Traps seen in review

- `LIKE <data element>` instead of `TYPE` (invalid); `LIKE LINE OF` on `TABLES`; `TABLES …
  STRUCTURE` in an ADT signature.
- A valid, syntax-checked FM that fails only at `rfc_enabled`: deep structure, generic
  type, object reference, or a parameter still by reference.
- `VALUE()` added to EXPORTING only.
- `TYPE` copied from a same-named data element for a field that was renamed or redirected
  at DDIC level — verify with `GetMeta`.
- A new custom structure for an internal, never-RFC result that matches an existing
  standard structure (§5) — starts its own lifecycle and drifts from the standard one.
- A wide standard structure as the `TABLES` row of an RFC-enabled FM, trusting the `SELECT`
  list to bound the output (§5).
