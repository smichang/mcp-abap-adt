CLASS zcl_mcp_session_admin DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_session,
        server  TYPE string,
        tid     TYPE i,
        kind    TYPE string,
        term    TYPE string,
        time    TYPE uzeit,
        age_min TYPE i,
        current TYPE abap_bool,
      END OF ty_session,
      tt_session TYPE STANDARD TABLE OF ty_session WITH DEFAULT KEY.

    "! Sessions of the logon user (sy-uname, sy-mandt) on every application server.
    "! An unreachable server is reported in ev_problems, it never fails the call.
    CLASS-METHODS list
      EXPORTING
        et_sessions TYPE tt_session
        ev_problems TYPE string.

    "! Readable list; ids for end_sessions are server:tid.
    CLASS-METHODS render
      RETURNING
        VALUE(rv_text) TYPE string.

    "! Ends HTTP sessions of the logon user by id (comma-separated server:tid).
    "! Every id is re-validated against a fresh list; tid -1 is never sent.
    CLASS-METHODS end_sessions
      IMPORTING
        iv_ids         TYPE csequence
        iv_min_age_min TYPE i DEFAULT 2
      RETURNING
        VALUE(rv_info) TYPE string
      RAISING
        zcx_mcp_dispatch.

ENDCLASS.


CLASS zcl_mcp_session_admin IMPLEMENTATION.

  METHOD list.

    DATA lt_srv   TYPE STANDARD TABLE OF msxxlist WITH DEFAULT KEY.
    DATA lt_users TYPE STANDARD TABLE OF uinfo WITH DEFAULT KEY.
    DATA lv_msg   TYPE c LENGTH 200.
    DATA lv_my_tid TYPE i.
    DATA lv_dest TYPE rfcdest.
    DATA lv_diff TYPE i.
    DATA lv_now_min TYPE i.
    DATA lv_ses_min TYPE i.

    CLEAR: et_sessions, ev_problems.

    CALL FUNCTION 'TH_SERVER_LIST'
      TABLES
        list   = lt_srv
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc <> 0.
      ev_problems = `TH_SERVER_LIST failed` && cl_abap_char_utilities=>newline.
      RETURN.
    ENDIF.

    CALL FUNCTION 'TH_USER_INFO'
      IMPORTING
        tid = lv_my_tid.

    LOOP AT lt_srv INTO DATA(ls_srv).
      CLEAR: lt_users, lv_msg.
      lv_dest = ls_srv-name.
      CALL FUNCTION 'TH_USER_LIST' DESTINATION lv_dest
        TABLES
          list                  = lt_users
        EXCEPTIONS
          system_failure        = 1 MESSAGE lv_msg
          communication_failure = 2 MESSAGE lv_msg
          OTHERS                = 3.
      IF sy-subrc <> 0.
        ev_problems = ev_problems && |server { ls_srv-name } unreachable (rc { sy-subrc }) { lv_msg }| && cl_abap_char_utilities=>newline.
        CONTINUE.
      ENDIF.
      LOOP AT lt_users INTO DATA(ls_u) WHERE bname = sy-uname AND mandt = sy-mandt.
        DATA(ls_s) = VALUE ty_session( server = ls_srv-name tid = ls_u-tid term = ls_u-term time = ls_u-zeit ).
        ls_s-kind = SWITCH #( ls_u-type WHEN 202 THEN `HTTP` WHEN 4 THEN `GUI` ELSE |type{ ls_u-type }| ).
        " ZEIT is time of day only (server clock); the day is unknown, so wrap at 24 h
        lv_now_min = sy-uzeit(2) * 60 + sy-uzeit+2(2).
        lv_ses_min = ls_u-zeit(2) * 60 + ls_u-zeit+2(2).
        lv_diff = lv_now_min - lv_ses_min.
        IF lv_diff < 0.
          lv_diff = lv_diff + 1440.
        ENDIF.
        ls_s-age_min = lv_diff.
        ls_s-current = xsdbool( ls_u-tid = lv_my_tid AND to_upper( ls_srv-host ) = to_upper( sy-host ) ).
        APPEND ls_s TO et_sessions.
      ENDLOOP.
    ENDLOOP.

  ENDMETHOD.


  METHOD render.

    list( IMPORTING et_sessions = DATA(lt_s) ev_problems = DATA(lv_prob) ).
    DATA(lv_nl) = cl_abap_char_utilities=>newline.
    rv_text = |Sessions of { sy-uname } (client { sy-mandt }): { lines( lt_s ) }. Id for "end" = server:tid. | &&
              |Age = minutes since last activity time of day (day unknown, wraps at 24 h).| && lv_nl.
    LOOP AT lt_s INTO DATA(ls_s).
      rv_text = rv_text && |{ ls_s-server }:{ ls_s-tid }  { ls_s-kind }  term={ ls_s-term }  | &&
                |time={ ls_s-time+0(2) }:{ ls_s-time+2(2) }:{ ls_s-time+4(2) }  age={ ls_s-age_min }min| &&
                COND #( WHEN ls_s-current = abap_true THEN `  CURRENT (carries this request)` ) && lv_nl.
    ENDLOOP.
    IF lv_prob IS NOT INITIAL.
      rv_text = rv_text && `PROBLEMS: ` && lv_nl && lv_prob.
    ENDIF.

  ENDMETHOD.


  METHOD end_sessions.

    DATA lt_ids TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA(lv_nl) = cl_abap_char_utilities=>newline.
    DATA lt_ended TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lv_msg TYPE c LENGTH 200.
    DATA lv_dest TYPE rfcdest.
    DATA lv_tid TYPE i.
    DATA lv_server TYPE string.

    SPLIT iv_ids AT ',' INTO TABLE lt_ids.
    DELETE lt_ids WHERE table_line IS INITIAL.
    IF lt_ids IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = `END`
          detail = `ids required (server:tid, comma-separated); there is no "end all"`.
    ENDIF.

    " validate every id's shape before anything is touched
    LOOP AT lt_ids ASSIGNING FIELD-SYMBOL(<id>).
      <id> = condense( <id> ).
      IF NOT matches( val = <id> regex = `[^:\s]+:[0-9]{1,9}` ).
        RAISE EXCEPTION TYPE zcx_mcp_dispatch
          EXPORTING
            textid = zcx_mcp_dispatch=>bad_request
            action = `END`
            detail = |malformed id '{ <id> }' (expected server:tid, tid a non-negative number)|.
      ENDIF.
    ENDLOOP.

    LOOP AT lt_ids INTO DATA(lv_id).
      " fresh list per id: never trust an id from an old list
      list( IMPORTING et_sessions = DATA(lt_s) ).
      lv_server = substring_before( val = lv_id sub = `:` ).
      lv_tid = substring_after( val = lv_id sub = `:` ).
      READ TABLE lt_s INTO DATA(ls_s) WITH KEY server = lv_server tid = lv_tid.
      IF sy-subrc <> 0.
        rv_info = rv_info && |{ lv_id }: not found (already gone)| && lv_nl.
        CONTINUE.
      ENDIF.
      IF ls_s-current = abap_true.
        rv_info = rv_info && |{ lv_id }: REFUSED - this is the session carrying the request| && lv_nl.
        CONTINUE.
      ENDIF.
      IF ls_s-kind <> `HTTP`.
        rv_info = rv_info && |{ lv_id }: REFUSED - kind { ls_s-kind } is not an HTTP session, use SM04| && lv_nl.
        CONTINUE.
      ENDIF.
      IF ls_s-age_min < iv_min_age_min.
        rv_info = rv_info && |{ lv_id }: REFUSED - younger than { iv_min_age_min } min (age { ls_s-age_min }); may be the in-flight session of a running client| && lv_nl.
        CONTINUE.
      ENDIF.
      IF lv_tid < 0.
        rv_info = rv_info && |{ lv_id }: REFUSED - invalid tid| && lv_nl.
        CONTINUE.
      ENDIF.
      CLEAR lv_msg.
      lv_dest = lv_server.
      CALL FUNCTION 'TH_DELETE_USER' DESTINATION lv_dest
        EXPORTING
          user                  = sy-uname
          client                = sy-mandt
          tid                   = lv_tid
        EXCEPTIONS
          authority_error       = 1
          system_failure        = 2 MESSAGE lv_msg
          communication_failure = 3 MESSAGE lv_msg
          OTHERS                = 4.
      CASE sy-subrc.
        WHEN 0.
          APPEND lv_id TO lt_ended.
        WHEN 1.
          rv_info = rv_info && |{ lv_id }: AUTHORITY_ERROR - TH_DELETE_USER refused the user, end it in SM04| && lv_nl.
        WHEN OTHERS.
          rv_info = rv_info && |{ lv_id }: FAILED (rc { sy-subrc }) { lv_msg }| && lv_nl.
      ENDCASE.
    ENDLOOP.

    " verify
    list( IMPORTING et_sessions = lt_s ).
    LOOP AT lt_ended INTO lv_id.
      lv_server = substring_before( val = lv_id sub = `:` ).
      lv_tid    = substring_after( val = lv_id sub = `:` ).
      READ TABLE lt_s WITH KEY server = lv_server tid = lv_tid TRANSPORTING NO FIELDS.
      rv_info = rv_info && |{ lv_id }: { COND string( WHEN sy-subrc = 0 THEN `still there` ELSE `ended` ) }| && lv_nl.
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.
