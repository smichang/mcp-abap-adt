CLASS zcl_mcp_lock_admin DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "! SM12 lock cleanup for the connection's OWN user only.
    "!
    "! Reads the enqueue table (ENQUEUE_READ, guname = sy-uname, current client)
    "! and keeps entries whose lock argument contains iv_object_name. With
    "! iv_delete = abap_false it only reports them; with abap_true it deletes
    "! each via ENQUE_DELETE (what SM12 "Delete" calls). Locks of other
    "! users are never read, so they can never be deleted from here.
    CLASS-METHODS clear_own_locks
      IMPORTING
        iv_object_name TYPE csequence
        iv_delete      TYPE abap_bool DEFAULT abap_false
      RETURNING
        VALUE(rv_info) TYPE string
      RAISING
        zcx_mcp_dispatch.

ENDCLASS.


CLASS zcl_mcp_lock_admin IMPLEMENTATION.

  METHOD clear_own_locks.

    DATA lt_enq TYPE STANDARD TABLE OF seqg3 WITH DEFAULT KEY.
    DATA lv_name TYPE string.
    DATA lv_deleted TYPE i.
    DATA lv_found TYPE i.

    lv_name = to_upper( condense( iv_object_name ) ).
    IF lv_name IS INITIAL OR strlen( lv_name ) < 3.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = `UNLOCK`
          detail = `object_name too short to match locks safely`.
    ENDIF.

    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gclient = sy-mandt
        guname  = sy-uname
      TABLES
        enq     = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                = 3.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = `UNLOCK`
          detail = |ENQUEUE_READ failed (subrc { sy-subrc })|.
    ENDIF.

    LOOP AT lt_enq INTO DATA(ls_enq).
      " garg is padded with U+FFFF (and blanks) - strip everything non-printable.
      DATA(lv_arg) = to_upper( CONV string( ls_enq-garg ) ).
      lv_arg = replace( val = lv_arg regex = `[^[:print:]]` with = `` occ = 0 ).
      IF lv_arg CP |{ sy-mandt }*|.
        lv_arg = substring( val = lv_arg off = 3 ).
      ENDIF.
      " whole-name match only: ZMCP_X must not hit ZMCP_X2, nor a longer name containing it
      IF NOT ( matches( val = lv_arg regex = |{ lv_name }([^A-Z0-9_].*)?| )
            OR contains( val = lv_arg regex = |[^A-Z0-9_]{ lv_name }([^A-Z0-9_]\|$)| ) ).
        CONTINUE.
      ENDIF.
      lv_found = lv_found + 1.
      DATA(lv_line) = |{ ls_enq-gname } { lv_arg } mode={ ls_enq-gmode } user={ ls_enq-guname }|.
      IF ls_enq-guname <> sy-uname OR ls_enq-gclient <> sy-mandt.
        rv_info = rv_info && |SKIPPED (not own user/client): { lv_line }| && cl_abap_char_utilities=>newline.
        CONTINUE.
      ENDIF.
      IF iv_delete = abap_true.
        " ENQUE_DELETE (one U) is the FM behind SM12 "Delete"; ENQUEUE_DELETE does not exist.
        DATA lt_one TYPE STANDARD TABLE OF seqg3 WITH DEFAULT KEY.
        DATA lv_rc TYPE sy-subrc.
        CLEAR lt_one.
        APPEND ls_enq TO lt_one.
        CALL FUNCTION 'ENQUE_DELETE'
          IMPORTING
            subrc = lv_rc
          TABLES
            enq   = lt_one.
        IF lv_rc = 0.
          lv_deleted = lv_deleted + 1.
          rv_info = rv_info && |deleted: { lv_line }| && cl_abap_char_utilities=>newline.
        ELSE.
          rv_info = rv_info && |FAILED (rc { lv_rc }): { lv_line }| && cl_abap_char_utilities=>newline.
        ENDIF.
      ELSE.
        rv_info = rv_info && |found: { lv_line }| && cl_abap_char_utilities=>newline.
      ENDIF.
    ENDLOOP.

    IF lv_found = 0.
      rv_info = |no SM12 lock of user { sy-uname } matches { lv_name }|.
    ELSE.
      rv_info = rv_info && |{ lv_deleted } of { lv_found } lock(s) deleted|.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
