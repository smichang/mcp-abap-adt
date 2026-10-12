CLASS zcl_mcp_transport_admin DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "! Moves/reassigns one repository object to a target task or request.
    "!
    "! HISTORY: two dead ends tried and disproven before this one:
    "! (1) CTS_WBO_API_INSERT_OBJECTS (package SCTS_API, the same dialog-
    "!     free family CL_ICF_TREE=>DELETE_NODE's i_dark_transport path
    "!     uses) flatly REFUSES an object already checked out under a
    "!     different open request - "is already locked in request X of
    "!     user Y" - no reassignment semantics at all, and none of its
    "!     CTS_WBO_API_* siblings (CHECK/READ_*/RELEASE_REQ) offer one
    "!     either.
    "! (2) RS_CORR_INSERT (the FM CL_SUSO_APPL/CL_SUSO_CL use for their
    "!     OWN, create-only, transport registration) with its genuine
    "!     headless flag (suppress_dialog='X' -> TRINT_CORR_INSERT
    "!     iv_dialog='D') silently NO-OPS on a conflict instead of either
    "!     erring or reassigning - confirmed live via GetMeta(TRANSPORT)
    "!     on both sides, tried with mode=' ' and mode='I', neither moved
    "!     the object. The interactive dialog exists precisely to ask
    "!     "reassign from X to Y?" on this exact conflict; headless mode
    "!     deliberately declines to answer that question either way.
    "!
    "! The right feature is SE01/SE09's object-list right-click "Move"
    "! (target-task popup). Its real engine is
    "! TR_MOVE_OBJECTS (function group STRI, package SCTS_REQ) - a
    "! dedicated move/reassign API, not an "insert" one. It also has a
    "! genuine headless path: the CALL SCREEN 0300 target-picker only
    "! fires when the caller's own cs_request_to_header-trkorr is blank
    "! (see its source) - always supplying a real target here means that
    "! branch is structurally unreachable, not just suppressed by a flag.
    "!
    "! Strategy: try CTS_WBO_API_INSERT_OBJECTS first (cheap, already
    "! proven safe on both outcomes) - if it succeeds outright the object
    "! had no conflicting prior registration and is already done; if it
    "! reports a lock conflict, its object_locks output IS the object's
    "! current source transport (no separate TADIR/E071/E070 lookup
    "! needed), fed straight into TR_MOVE_OBJECTS as cs_request_from.
    "! iv_target_trkorr accepts either a request or a task number - CTS
    "! does not type-distinguish them at the field-type level.
    CLASS-METHODS move_object
      IMPORTING
        iv_pgmid         TYPE pgmid DEFAULT 'R3TR'
        iv_object_type   TYPE trobjtype
        iv_object_name   TYPE trobj_name
        iv_target_trkorr TYPE trkorr
      RETURNING
        VALUE(rv_info)   TYPE string
      RAISING
        zcx_mcp_dispatch.

    "! Removes ("deletes") a locked object entry from a transport
    "! request/task, without touching the underlying ABAP repository
    "! object itself - the headless equivalent of SE01/SE09's own
    "! object-list right-click "Delete Object" (remove-from-task) feature.
    "!
    "! No standard ADT REST endpoint reaches this. The transport's own
    "! object entry advertises a "removeobject" HATEOAS link
    "! (rel=http://www.sap.com/cts/relations/removeobject), and the
    "! constant backing it (IF_CTS_ADT_TM_CONSTANTS=>CO_SAP_REM_LOCKED_
    "! OBJECT) is genuinely registered with SAP - but CL_CTS_ADT_TM_REST_
    "! RES_CONT's own POST/PUT dispatch never actually branches on it
    "! (confirmed by reading its `post` method's CASE statement directly:
    "! only newtask/consistencychecks/preparerelease/release-variants/
    "! reassign/sortandcompress/lockobject/merge/moveobjects are wired -
    "! removeobject falls through to handle_action_not_supported). A
    "! vestigial/unimplemented link on this SAP release, not a caller
    "! mistake - multiple raw HTTP probes against every plausible verb/
    "! body/media-type combination against the advertised href all
    "! silently no-op'd before this was traced down to the actual
    "! dispatch source.
    "!
    "! TR_DELETE_COMM_OBJECT_KEYS (function group STRI, package SCTS_REQ
    "! - the same group as TR_MOVE_OBJECTS) IS the real mechanism: it's
    "! what SAP's own standard CTS REST API class
    "! (CL_CTS_REST_API_IMPL=>IF_CTS_REST_API~DELETE_OBJECT) calls
    "! internally, with IV_DIALOG_FLAG = ' ' for headless mode (default
    "! 'X' is the interactive/dialog variant) - and independently, it's
    "! used directly (not through any REST wrapper) by ~18 other SAP
    "! standard programs, including the classic Transport Organizer's own
    "! dynpro include LSTRHF05. Unlike that REST API class, calling the
    "! FM directly needs none of its extra CTS_SET_TRKORR_CONTEXT/
    "! lock_handle machinery - the FM handles its own CTS_LOCK_TRKORR/
    "! CTS_UNLOCK_TRKORR locking internally.
    CLASS-METHODS delete_object
      IMPORTING
        iv_pgmid       TYPE pgmid DEFAULT 'R3TR'
        iv_object_type TYPE trobjtype
        iv_object_name TYPE trobj_name
        iv_trkorr      TYPE trkorr
      RETURNING
        VALUE(rv_info) TYPE string
      RAISING
        zcx_mcp_dispatch.

  PRIVATE SECTION.
    CLASS-METHODS try_direct_insert
      IMPORTING
        iv_pgmid          TYPE pgmid
        iv_object_type    TYPE trobjtype
        iv_object_name    TYPE trobj_name
        iv_target_trkorr  TYPE trkorr
        iv_devclass       TYPE devclass
      EXPORTING
        ev_done           TYPE abap_bool
        ev_source_trkorr  TYPE trkorr
        ev_detail         TYPE string.

    CLASS-METHODS move_between_requests
      IMPORTING
        iv_pgmid          TYPE pgmid
        iv_object_type    TYPE trobjtype
        iv_object_name    TYPE trobj_name
        iv_source_trkorr  TYPE trkorr
        iv_target_trkorr  TYPE trkorr
      RAISING
        zcx_mcp_dispatch.

    "! Resolves a caller-supplied request/task number down to the actual
    "! TASK that holds (or would hold) the E071 entry for one object -
    "! shared by move_between_requests' source-side resolution and
    "! delete_object (same task-vs-request trap TR_MOVE_OBJECTS hit:
    "! a bare parent-request number fails against APIs that need the
    "! task). Falls back to the input unchanged if no task row is found
    "! (e.g. caller already passed an exact task, or there's genuinely no
    "! E071 row yet).
    CLASS-METHODS resolve_task
      IMPORTING
        iv_pgmid           TYPE pgmid
        iv_object_type     TYPE trobjtype
        iv_object_name     TYPE trobj_name
        iv_trkorr          TYPE trkorr
      RETURNING
        VALUE(rv_task)     TYPE trkorr.

ENDCLASS.


CLASS zcl_mcp_transport_admin IMPLEMENTATION.

  METHOD move_object.

    " LIMU sub-objects (e.g. LIMU FUNC) have no TADIR row of their own -
    " TR_CHECK_TYPE maps any E071 key to its owning R3TR TADIR key
    " (LIMU FUNC -> R3TR FUGR <group>); R3TR keys pass through unchanged.
    DATA ls_tadir TYPE tadir.
    CALL FUNCTION 'TR_CHECK_TYPE'
      EXPORTING
        wi_e071  = VALUE e071( pgmid = iv_pgmid object = iv_object_type obj_name = iv_object_name )
      IMPORTING
        we_tadir = ls_tadir.
    IF ls_tadir-obj_name IS INITIAL.
      ls_tadir = VALUE #( pgmid = iv_pgmid object = iv_object_type obj_name = iv_object_name ).
    ENDIF.

    SELECT SINGLE devclass FROM tadir INTO @DATA(lv_devclass)
      WHERE pgmid = @ls_tadir-pgmid AND object = @ls_tadir-object AND obj_name = @ls_tadir-obj_name.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'move_object'
          detail = |object not found in TADIR: { iv_pgmid } { iv_object_type } { iv_object_name }| &&
                   | (TADIR key { ls_tadir-pgmid } { ls_tadir-object } { ls_tadir-obj_name })|.
    ENDIF.

    try_direct_insert(
      EXPORTING
        iv_pgmid         = iv_pgmid
        iv_object_type   = iv_object_type
        iv_object_name   = iv_object_name
        iv_target_trkorr = iv_target_trkorr
        iv_devclass      = lv_devclass
      IMPORTING
        ev_done          = DATA(lv_done)
        ev_source_trkorr = DATA(lv_source_trkorr)
        ev_detail        = DATA(lv_detail) ).

    IF lv_done = abap_true.
      rv_info = |moved { iv_pgmid } { iv_object_type } { iv_object_name } to { iv_target_trkorr } (direct insert, no prior registration)|.
      RETURN.
    ENDIF.

    IF lv_source_trkorr IS INITIAL.
      " try_direct_insert failed for a reason OTHER than a lock conflict
      " (no object_locks to recover a source from) - a real error, not a
      " move-vs-insert branch decision.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'move_object'
          detail = |move failed: { lv_detail }|.
    ENDIF.

    IF lv_source_trkorr = iv_target_trkorr.
      rv_info = |{ iv_pgmid } { iv_object_type } { iv_object_name } already in { iv_target_trkorr } - nothing to do|.
      RETURN.
    ENDIF.

    move_between_requests(
      iv_pgmid         = iv_pgmid
      iv_object_type   = iv_object_type
      iv_object_name   = iv_object_name
      iv_source_trkorr = lv_source_trkorr
      iv_target_trkorr = iv_target_trkorr ).

    rv_info = |moved { iv_pgmid } { iv_object_type } { iv_object_name } from { lv_source_trkorr } to { iv_target_trkorr }|.

  ENDMETHOD.


  METHOD delete_object.

    DATA(lv_task_trkorr) = resolve_task(
      iv_pgmid       = iv_pgmid
      iv_object_type = iv_object_type
      iv_object_name = iv_object_name
      iv_trkorr      = iv_trkorr ).

    DATA ls_e071 TYPE e071.
    ls_e071-pgmid    = iv_pgmid.
    ls_e071-object   = iv_object_type.
    ls_e071-obj_name = iv_object_name.
    ls_e071-trkorr   = lv_task_trkorr.

    DATA ls_request TYPE trwbo_request.
    ls_request-h-trkorr = lv_task_trkorr.

    DATA lt_new_locks TYPE trwbo_t_locktab.

    CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'
      EXPORTING
        is_e071_delete              = ls_e071
        iv_dialog_flag               = ' '
      IMPORTING
        et_new_locks                 = lt_new_locks
      CHANGING
        cs_request                    = ls_request
      EXCEPTIONS
        e_database_access_error     = 1
        e_empty_lockkey               = 2
        e_bad_target_request          = 3
        e_wrong_source_client          = 4
        n_no_deletion_of_c_objects      = 5
        n_no_deletion_of_corr_entry      = 6
        n_object_entry_doesnt_exist       = 7
        n_request_already_released         = 8
        n_request_from_other_system         = 9
        r_action_aborted_by_user             = 10
        r_foreign_lock                        = 11
        w_bigger_lock_in_same_order            = 12
        w_duplicate_entry                       = 13
        w_no_authorization                       = 14
        w_user_not_owner                          = 15
        OTHERS                                     = 16.

    IF sy-subrc <> 0.
      DATA(lv_reason) = SWITCH string( sy-subrc
        WHEN 1  THEN 'database_access_error'
        WHEN 2  THEN 'empty_lockkey'
        WHEN 3  THEN 'bad_target_request'
        WHEN 4  THEN 'wrong_source_client'
        WHEN 5  THEN 'no_deletion_of_c_objects'
        WHEN 6  THEN 'no_deletion_of_corr_entry'
        WHEN 7  THEN 'object_entry_doesnt_exist'
        WHEN 8  THEN 'request_already_released'
        WHEN 9  THEN 'request_from_other_system'
        WHEN 10 THEN 'action_aborted_by_user'
        WHEN 11 THEN 'foreign_lock'
        WHEN 12 THEN 'bigger_lock_in_same_order'
        WHEN 13 THEN 'duplicate_entry'
        WHEN 14 THEN 'no_authorization'
        WHEN 15 THEN 'user_not_owner'
        ELSE         |unexpected rc { sy-subrc }| ) &&
        | ({ sy-msgid }{ sy-msgno }: { sy-msgv1 } { sy-msgv2 } { sy-msgv3 } { sy-msgv4 })|.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'delete_object'
          detail = |delete failed: { lv_reason }|.
    ENDIF.

    rv_info = |removed { iv_pgmid } { iv_object_type } { iv_object_name } from { lv_task_trkorr }|.

  ENDMETHOD.


  METHOD resolve_task.
    SELECT SINGLE e071~trkorr FROM e071
      INNER JOIN e070 ON e070~trkorr = e071~trkorr
      INTO @rv_task
      WHERE e071~pgmid = @iv_pgmid AND e071~object = @iv_object_type AND e071~obj_name = @iv_object_name
        AND ( e070~trkorr = @iv_trkorr OR e070~strkorr = @iv_trkorr ).
    IF sy-subrc <> 0.
      rv_task = iv_trkorr.
    ENDIF.
  ENDMETHOD.


  METHOD try_direct_insert.
    CLEAR: ev_done, ev_source_trkorr, ev_detail.

    DATA(lt_entries) = VALUE cts_recording_entries(
      ( object_entry = VALUE cts_object_entry(
          object_key = VALUE cts_object_key(
            pgmid    = iv_pgmid
            object   = iv_object_type
            obj_name = iv_object_name ) )
        operation = 'I'
        devclass  = iv_devclass ) ).

    DATA ls_result   TYPE cts_result.
    DATA lt_messages TYPE cts_messages.
    DATA ls_request  TYPE cts_request.
    DATA lt_locks    TYPE cts_object_locks.

    CALL FUNCTION 'CTS_WBO_API_INSERT_OBJECTS'
      EXPORTING
        recording_entries  = lt_entries
        trkorr              = iv_target_trkorr
        no_standard_editor = abap_true
      IMPORTING
        result       = ls_result
        messages     = lt_messages
        request      = ls_request
        object_locks = lt_locks.

    IF ls_result = 'S'.
      ev_done = abap_true.
      RETURN.
    ENDIF.

    READ TABLE lt_locks INTO DATA(ls_lock) INDEX 1.
    IF sy-subrc = 0.
      ev_source_trkorr = ls_lock-lock_holder-req_header-trkorr.
      RETURN.
    ENDIF.

    " Failed, and not because of a recoverable lock conflict - surface the
    " real message instead of silently falling through to move_between_requests
    " with an initial (and therefore misleading) source.
    DATA(lv_msgtext) = ``.
    LOOP AT lt_messages INTO DATA(ls_msg).
      lv_msgtext = lv_msgtext && |[{ ls_msg-severity }] { ls_msg-text }{ cl_abap_char_utilities=>newline }|.
    ENDLOOP.
    ev_detail = lv_msgtext.
  ENDMETHOD.


  METHOD move_between_requests.
    DATA(lt_e071) = VALUE tr_objects(
      ( pgmid = iv_pgmid object = iv_object_type obj_name = iv_object_name ) ).

    " TR_MOVE_OBJECTS's cs_request_from must be the TASK that actually holds
    " the E071 entry, not the parent request - live-found ("object_entry_
    " doesnt_exist" when passed the bare request number returned by
    " CTS_WBO_API_INSERT_OBJECTS's object_locks). Shared with delete_object
    " via resolve_task().
    DATA(lv_task_trkorr) = resolve_task(
      iv_pgmid       = iv_pgmid
      iv_object_type = iv_object_type
      iv_object_name = iv_object_name
      iv_trkorr      = iv_source_trkorr ).

    " Same task-vs-request mismatch on the target side - live-found
    " ("request_types_not_consistent", TR712) mixing a task-level source
    " with a bare request-level target. If iv_target_trkorr is a request
    " with its own task(s), move into its (first) task instead - if it's
    " already a task, or has none, use it as given.
    DATA(lv_target_task) = iv_target_trkorr.
    SELECT trkorr FROM e070 INTO TABLE @DATA(lt_target_tasks)
      UP TO 1 ROWS
      WHERE strkorr = @iv_target_trkorr
      ORDER BY trkorr.
    IF sy-subrc = 0 AND lines( lt_target_tasks ) > 0.
      lv_target_task = lt_target_tasks[ 1 ].
    ENDIF.

    DATA ls_request_from     TYPE trwbo_request.
    DATA ls_request_to_head  TYPE trwbo_request_header.

    ls_request_from-h-trkorr = lv_task_trkorr.
    ls_request_to_head-trkorr = lv_target_task.

    CALL FUNCTION 'TR_MOVE_OBJECTS'
      EXPORTING
        it_e071             = lt_e071
        iv_suppress_dialog  = 'X'
      CHANGING
        cs_request_from       = ls_request_from
        cs_request_to_header  = ls_request_to_head
      EXCEPTIONS
        database_access_error    = 1
        no_authorization          = 2
        request_from_other_system = 3
        request_already_released  = 4
        wrong_source_client        = 5
        user_not_owner              = 6
        no_move_of_corr_entry       = 7
        object_entry_doesnt_exist   = 8
        duplicate_entry              = 9
        empty_lockkey                 = 10
        foreign_lock                   = 11
        request_types_not_consistent    = 12
        OTHERS                            = 13.

    IF sy-subrc <> 0.
      DATA(lv_reason) = SWITCH string( sy-subrc
        WHEN 1  THEN 'database_access_error'
        WHEN 2  THEN 'no_authorization'
        WHEN 3  THEN 'request_from_other_system'
        WHEN 4  THEN 'request_already_released'
        WHEN 5  THEN 'wrong_source_client'
        WHEN 6  THEN 'user_not_owner'
        WHEN 7  THEN 'no_move_of_corr_entry'
        WHEN 8  THEN 'object_entry_doesnt_exist'
        WHEN 9  THEN 'duplicate_entry'
        WHEN 10 THEN 'empty_lockkey'
        WHEN 11 THEN 'foreign_lock'
        WHEN 12 THEN 'request_types_not_consistent'
        ELSE         |unexpected rc { sy-subrc }| ) &&
        | ({ sy-msgid }{ sy-msgno }: { sy-msgv1 } { sy-msgv2 } { sy-msgv3 } { sy-msgv4 })|.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'move_object'
          detail = |move (task-to-task) failed: { lv_reason }|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
