# BDC → BAPI migration

Load when replacing `CALL TRANSACTION` + `BDCDATA` with a BAPI/API.

**Why migrate.** BDC drives a transaction by *simulating its screens*:

- **Slow** — every step runs the full dialog stack (PBO/PAI, conversion exits, locks) as if a
  user were typing; a BAPI call is typically several times faster (one production-order
  create measured ~9×).
- **Fragile** — tied to screen layouts, field names, tab order, GUI status; any support
  pack, enhancement or variant change breaks it silently.
- **Hard to control** — errors are post-hoc (parse `MESSTAB`); dialog-only side effects
  (memory IDs, screen-flow enhancements) are easy to miss.

BAPIs and standard API function modules call the business logic directly, return structured
messages and are contract-stable.

## 1. Method

1. **Inventory the flow.** `grep -nE "CALL TRANSACTION|BDC_DYNPRO|BDC_FIELD|BDC_OKCODE|MESSTAB|CTU_PARAM" FILE.abap`.
   Record transaction, create/change/release, OK-codes (`=BU`, `=FREI`, `=DEL`), update mode
   and any per-screen business logic.
2. **Map each transaction to its BAPI/API FM** (§3). Prefer released BAPIs; where none exists
   use the internal API family (`CO_XT_*` …). Never guess a BAPI name by analogy — look it up
   with `SearchObject`.
3. **Map the fields.** Screen field → BAPI field, watching type/length (a `CHAR(40)` source
   into a `CHAR(16)` BAPI field truncates silently).
4. **Custom (Z/CI) fields** via `EXTENSIONIN` (§4).
5. **Fields the BAPI does not expose:** a targeted `UPDATE` (or the FM the standard code
   uses) *after* the BAPI commit, commented "not exposed by BAPI".
6. **Transaction control:** check the return after **every** BAPI and after the commit;
   `ROLLBACK` on error. If step A committed and step B fails you have an **orphan** — add
   explicit cleanup (delete/reverse).
7. **Replace implicit screen timing** with an explicit bounded wait only where needed (§5.7).
8. **Keep the legacy program as fallback.** Ship the BAPI version as a *new* program or
   transaction and leave the BDC one runnable until the new path is proven in production.

## 2. Before / after

```abap
" BEFORE — screen simulation
PERFORM bdc_dynpro USING 'SAPLxxxx' '0100'.
PERFORM bdc_field  USING 'BDC_OKCODE' '=ENT'.
PERFORM bdc_field  USING 'STRUCT-FIELD1' lv_val1.
PERFORM bdc_field  USING 'BDC_OKCODE' '=BU'.
ctu_parameters-dismode = 'N'.
ctu_parameters-updmode = 'S'.
CALL TRANSACTION 'CO01' USING bdcdata OPTIONS FROM ctu_parameters MESSAGES INTO messtab.
READ TABLE messtab WITH KEY msgtyp = 'E'.        " error handling = parse afterwards
```

```abap
" AFTER — direct API call
ls_orderdata-material   = lv_matnr.
ls_orderdata-plant      = lv_werks.
ls_orderdata-order_type = lv_auart.
ls_orderdata-quantity   = lv_qty.
CALL FUNCTION 'BAPI_PRODORD_CREATE'
  EXPORTING orderdata    = ls_orderdata
  IMPORTING return       = ls_return
            order_number = lv_aufnr
  TABLES    extension_in = lt_extension_in.
IF ls_return-type CA 'EA'.                       " structured error up front
  CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
  PERFORM safe_bapi_msg ... CHANGING pc_msg. RETURN.
ENDIF.
PERFORM safe_bapi_commit CHANGING pc_msg.        " checked commit (§5.2)
```

## 3. Transaction → BAPI

| Area | Legacy | Replace with |
|---|---|---|
| Production order create | CO01 / CO08 | `BAPI_PRODORD_CREATE` (picks the CO01/CO08 path from sales-order presence) |
| Production order change (header) | CO02 | `BAPI_PRODORD_CHANGE` |
| Production order release | CO02 `=FREI` | `BAPI_PRODORD_RELEASE` (`release_control='1'`) |
| Order components | CO02 component screen | `CO_XT_COMPONENTS_GET_ALL` / `CO_XT_COMPONENT_ADD` / `_CHANGE` / `CO_XT_COMPONENTS_DELETE` |
| Order operation change | CO02 operation screen | `CO_XT_OPERATION_CHANGE` |
| Order delete (rollback) | — | `CO_XT_ORDER_DELETE` |
| Sales order | VA01 / VA02 | `BAPI_SALESORDER_CREATEFROMDAT2` / `BAPI_SALESORDER_CHANGE` |
| Purchase order | ME21N / ME22N | `BAPI_PO_CREATE1` / `BAPI_PO_CHANGE` |
| Purchase requisition | ME51N / ME52N | `BAPI_PR_CREATE` / `BAPI_REQUISITION_CHANGE` |
| Goods movement | MIGO / MB1* | `BAPI_GOODSMVT_CREATE` |
| Accounting document | FB01 | `BAPI_ACC_DOCUMENT_POST` |
| Material master | MM01 / MM02 | `BAPI_MATERIAL_SAVEDATA` |
| Reservation custom fields | — | `MB_CHANGE_RESERVATION_ARRAY` / targeted `UPDATE` |
| Commit / rollback | implicit `UPDMODE` | `BAPI_TRANSACTION_COMMIT` (`wait='X'`) / `BAPI_TRANSACTION_ROLLBACK` |

Rule of thumb: classic BAPI for create/change/release; the internal API family (`CO_XT_*`,
`MB_*`) for sub-objects a BAPI does not fully cover; a direct `UPDATE` only for the last few
fields no API exposes. Verify every name with `SearchObject`/`GetCode` before designing
around it.

## 4. Custom fields via `EXTENSIONIN`

Append-structure fields (`CI_*`/Z-fields on AUFK, VBAK, EKKO …) are not in the BAPI's typed
parameters; pass them through `EXTENSIONIN` with the matching `BAPI_TE_*` structure.
**Packed-decimal fields must go through a char container** — assigning a typed structure with
`P` fields directly to `VALUEPART1` fails:

```abap
DATA: ls_te       TYPE bapi_te_aufk,      " the append structure's BAPI twin
      ls_ext      TYPE bapiparex,
      lw_val(960) TYPE c.
ls_te-zzcustom_a = lv_a.
ls_te-zzqty      = lv_qty.                " packed decimal
lw_val = ls_te.                           " implicit struct → char
ls_ext-structure  = 'BAPI_TE_AUFK'.
ls_ext-valuepart1 = lw_val(240).
ls_ext-valuepart2 = lw_val+240(240).
ls_ext-valuepart3 = lw_val+480(240).
ls_ext-valuepart4 = lw_val+720(240).
APPEND ls_ext TO lt_extension_in.
```

Verify explicitly: a long value must reach the long BAPI field too (or it truncates);
quantities — header vs component level (the BDC may have used the *header* quantity); dates —
which date drives behaviour (BOM-explosion date may be a selection-screen parameter, not the
order start date).

## 5. Pitfalls and defensive patterns

1. **`MESSAGE ID ' '` dumps.** A BAPI return can have a blank `id`. Centralize message
   building and synthesize text from `v1..v4` when `id` is blank:
   ```abap
   IF uv_id IS INITIAL.
     CONCATENATE 'BAPI:' uv_v1 uv_v2 uv_v3 uv_v4 INTO pc_msg SEPARATED BY space.
   ELSE.
     MESSAGE ID uv_id TYPE uv_type NUMBER uv_number INTO pc_msg WITH uv_v1 uv_v2 uv_v3 uv_v4.
   ENDIF.
   ```
2. **Always check the commit return.** `BAPI_TRANSACTION_COMMIT` returns a `bapiret2`; a raw
   call discards it. Use `wait='X'` and inspect `return-type CA 'EA'` — a "success" that was
   not durable is worse than an error.
3. **Orphan cleanup in multi-step flows.** Header committed, later step failed → the object
   exists but is incomplete. Delete/reverse explicitly (e.g. `CO_XT_ORDER_DELETE`) and clear
   the returned key so the caller sees a full failure.
4. **`LOOP AT itab WHERE <own field symbol>` dumps** — `abap-coding-rules.md` §4.2.
5. **Internal vs display keys.** Component/operation APIs key on the internal operation number
   (`AFVC-APLZL`), not the displayed `VORNR`. Build a `VORNR → APLZL` map
   (`SELECT … FROM afvc WHERE aufpl = …`) and translate.
6. **Replicate dialog-only enhancements.** Screen-flow exits and memory-ID hacks
   (`EXPORT/IMPORT … MEMORY ID`) the transaction relied on **do not fire** under a BAPI —
   re-implement their intent explicitly (authority guards, cross-plant material resolution).
7. **Asynchronous visibility.** Even with `wait='X'` a fresh row may not be immediately visible
   to a `SELECT`. Replace BDC's implicit timing with a short bounded poll:
   ```abap
   DO 50 TIMES.
     SELECT SINGLE aufnr FROM afko INTO @lv_dummy WHERE aufnr = @pv_aufnr.
     IF sy-subrc = 0. EXIT. ENDIF.
     WAIT UP TO '0.1' SECONDS.
   ENDDO.
   ```
8. **Keep parity behaviour** — e.g. set delivery-complete `ELIKZ` only on the main item — and
   reuse the success message numbers the BDC produced, so downstream callers and logs are
   unaffected.

## 6. Review checklist

- [ ] Every `CALL TRANSACTION` of the old flow has a mapped BAPI/API — no BDC left on the hot path.
- [ ] Field mapping reviewed for type/length truncation; quantities and dates verified semantically.
- [ ] Z/CI fields via `EXTENSIONIN` (packed fields through a char container).
- [ ] Non-exposed fields set by a targeted, commented `UPDATE`/standard FM **after** commit.
- [ ] Return checked after every BAPI **and** after `BAPI_TRANSACTION_COMMIT` (`wait='X'`); `ROLLBACK` on error.
- [ ] Orphan cleanup if a later step fails after an earlier commit.
- [ ] Blank-`id` messages handled; dialog-only enhancements re-implemented.
- [ ] Internal keys (`APLZL`) resolved, not display keys (`VORNR`).
- [ ] Legacy program retained as fallback until proven in production.
- [ ] Before/after runtime measured.
