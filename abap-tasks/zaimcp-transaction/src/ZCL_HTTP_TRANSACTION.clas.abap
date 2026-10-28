CLASS zcl_http_transaction DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF token store - same DB-backed pattern as ZCL_HTTP_AUTH_OBJECT.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

    TYPES: BEGIN OF ty_req,
             tcode       TYPE tstc-tcode,
             program     TYPE tstc-pgmna,
             dynpro      TYPE tstc-dypno,
             description TYPE tstct-ttext,
             type        TYPE c LENGTH 1,
             devclass    TYPE devclass,
             trkorr      TYPE trkorr,
             web_gui     TYPE c LENGTH 1,
             java_gui    TYPE c LENGTH 1,
             win_gui     TYPE c LENGTH 1,
           END OF ty_req.

    METHODS validate_name
      IMPORTING iv_tcode TYPE tstc-tcode
      EXPORTING ev_code  TYPE i
                ev_text  TYPE string.

    METHODS do_create
      IMPORTING is_req  TYPE ty_req
      EXPORTING ev_code TYPE i
                ev_text TYPE string.

    METHODS do_update
      IMPORTING is_req  TYPE ty_req
                iv_set_program TYPE abap_bool
                iv_set_dynpro  TYPE abap_bool
                iv_set_descr   TYPE abap_bool
                iv_set_gui     TYPE abap_bool
      EXPORTING ev_code TYPE i
                ev_text TYPE string.

    METHODS do_delete
      IMPORTING is_req  TYPE ty_req
      EXPORTING ev_code TYPE i
                ev_text TYPE string.

    METHODS msg_text
      RETURNING VALUE(rv_text) TYPE string.

ENDCLASS.


CLASS zcl_http_transaction IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " Auth: SICF logon procedure runs before this method; sy-uname is the
    " authenticated user (see ZCL_HTTP_AUTH_OBJECT).
    DATA(lv_method) = server->request->get_header_field( name = '~request_method' ).

    DATA(lv_csrf_hdr) = server->request->get_header_field( name = 'x-csrf-token' ).
    DATA lv_csrf_id TYPE c LENGTH 20.
    lv_csrf_id = |CSRF_{ sy-uname }|.

    IF to_upper( lv_csrf_hdr ) = 'FETCH'.
      DATA lv_new_token TYPE string.
      TRY.
          lv_new_token = cl_system_uuid=>create_uuid_c32_static( ).
        CATCH cx_uuid_error.
          server->response->set_status( code = 500 reason = 'Internal Server Error' ).
          server->response->set_cdata( `CSRF token generation failed` ).
          RETURN.
      ENDTRY.
      DATA lv_issued_at TYPE timestamp.
      GET TIME STAMP FIELD lv_issued_at.
      EXPORT csrf_token = lv_new_token issued_at = lv_issued_at TO DATABASE indx(zt) ID lv_csrf_id.
      COMMIT WORK.
      server->response->set_header_field( name = 'x-csrf-token' value = lv_new_token ).
      server->response->set_status( code = 200 reason = 'OK' ).
      RETURN.
    ENDIF.

    IF lv_method <> 'GET'.
      DATA lv_expected_token TYPE string.
      DATA lv_issued_at2 TYPE timestamp.
      DATA lv_now TYPE timestamp.
      IMPORT csrf_token TO lv_expected_token issued_at = lv_issued_at2 FROM DATABASE indx(zt) ID lv_csrf_id.
      DATA(lv_import_rc) = sy-subrc.
      GET TIME STAMP FIELD lv_now.
      DATA lv_age TYPE tzntstmpl.
      lv_age = co_csrf_ttl_sec + 1.
      IF lv_import_rc = 0.
        TRY.
            lv_age = cl_abap_tstmp=>subtract( tstmp1 = lv_now tstmp2 = lv_issued_at2 ).
          CATCH cx_parameter_invalid_range cx_parameter_invalid_type.
            lv_age = co_csrf_ttl_sec + 1.
        ENDTRY.
      ENDIF.
      IF lv_import_rc <> 0 OR lv_expected_token IS INITIAL OR lv_csrf_hdr <> lv_expected_token
         OR lv_age > co_csrf_ttl_sec.
        server->response->set_status( code = 403 reason = 'Forbidden' ).
        server->response->set_cdata( `CSRF token validation failed` ).
        RETURN.
      ENDIF.
    ENDIF.

    IF lv_method <> 'POST'.
      server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
      RETURN.
    ENDIF.

    DATA(lv_action) = to_lower( server->request->get_form_field( 'action' ) ).
    DATA ls_req TYPE ty_req.
    ls_req-tcode       = to_upper( server->request->get_form_field( 'tcode' ) ).
    ls_req-program     = to_upper( server->request->get_form_field( 'program' ) ).
    ls_req-description = server->request->get_form_field( 'description' ).
    ls_req-type        = to_upper( server->request->get_form_field( 'type' ) ).
    ls_req-devclass    = to_upper( server->request->get_form_field( 'devclass' ) ).
    ls_req-trkorr      = to_upper( server->request->get_form_field( 'trkorr' ) ).
    ls_req-web_gui     = to_upper( server->request->get_form_field( 'web_gui' ) ).
    ls_req-java_gui    = to_upper( server->request->get_form_field( 'java_gui' ) ).
    ls_req-win_gui     = to_upper( server->request->get_form_field( 'win_gui' ) ).
    DATA(lv_dynpro) = server->request->get_form_field( 'dynpro' ).
    IF lv_dynpro IS NOT INITIAL.
      IF lv_dynpro CN '0123456789' OR strlen( lv_dynpro ) > 4.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( `dynpro must be a screen number of up to 4 digits` ).
        RETURN.
      ENDIF.
      ls_req-dynpro = lv_dynpro.
    ENDIF.

    DATA lv_code TYPE i.
    DATA lv_text TYPE string.

    IF lv_action <> 'create' AND lv_action <> 'update' AND lv_action <> 'delete'.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `action must be "create", "update" or "delete"` ).
      RETURN.
    ENDIF.

    validate_name( EXPORTING iv_tcode = ls_req-tcode IMPORTING ev_code = lv_code ev_text = lv_text ).
    IF lv_code <> 0.
      server->response->set_status( code = lv_code reason = 'Error' ).
      server->response->set_cdata( lv_text ).
      RETURN.
    ENDIF.

    CASE lv_action.
      WHEN 'create'.
        do_create( EXPORTING is_req = ls_req IMPORTING ev_code = lv_code ev_text = lv_text ).
      WHEN 'update'.
        " Only fields actually sent are changed; an absent param keeps the
        " current value. Present-but-empty is not a valid "clear".
        do_update( EXPORTING is_req          = ls_req
                             iv_set_program  = boolc( ls_req-program IS NOT INITIAL )
                             iv_set_dynpro   = boolc( lv_dynpro IS NOT INITIAL )
                             iv_set_descr    = boolc( ls_req-description IS NOT INITIAL )
                             iv_set_gui      = boolc( ls_req-web_gui IS NOT INITIAL
                                                   OR ls_req-java_gui IS NOT INITIAL
                                                   OR ls_req-win_gui IS NOT INITIAL )
                   IMPORTING ev_code = lv_code ev_text = lv_text ).
      WHEN 'delete'.
        do_delete( EXPORTING is_req = ls_req IMPORTING ev_code = lv_code ev_text = lv_text ).
    ENDCASE.

    server->response->set_status( code = lv_code reason = 'Status' ).
    server->response->set_cdata( lv_text ).

  ENDMETHOD.


  METHOD validate_name.
    ev_code = 0.
    IF iv_tcode IS INITIAL.
      ev_code = 400. ev_text = `tcode is required`. RETURN.
    ENDIF.
    IF iv_tcode(1) <> 'Z' AND iv_tcode(1) <> 'Y'.
      ev_code = 400. ev_text = |Transaction { iv_tcode } must be in the customer namespace (Y/Z)|. RETURN.
    ENDIF.
  ENDMETHOD.


  METHOD msg_text.
    " Text of the last MESSAGE ... RAISING / sy-msg* set by a called FM.
    MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO rv_text.
  ENDMETHOD.


  METHOD do_create.
    DATA lv_type TYPE rglif-docutype.

    IF is_req-description IS INITIAL.
      ev_code = 400. ev_text = `description is required for create`. RETURN.
    ENDIF.
    IF is_req-program IS INITIAL.
      ev_code = 400. ev_text = `program is required for create`. RETURN.
    ENDIF.
    IF is_req-devclass IS INITIAL.
      ev_code = 400. ev_text = `devclass is required for create`. RETURN.
    ENDIF.
    lv_type = COND #( WHEN is_req-type IS INITIAL THEN 'D' ELSE is_req-type ).
    IF lv_type <> 'D' AND lv_type <> 'R'.
      ev_code = 400. ev_text = `type must be "D" (dialog) or "R" (report)`. RETURN.
    ENDIF.
    IF lv_type = 'D' AND is_req-dynpro IS INITIAL.
      ev_code = 400. ev_text = `dynpro is required for a dialog transaction`. RETURN.
    ENDIF.

    SELECT SINGLE name FROM trdir WHERE name = @is_req-program INTO @DATA(lv_prog).
    IF sy-subrc <> 0.
      ev_code = 400. ev_text = |Program { is_req-program } does not exist|. RETURN.
    ENDIF.

    CALL FUNCTION 'RPY_TRANSACTION_INSERT'
      EXPORTING
        transaction        = is_req-tcode
        program            = is_req-program
        dynpro             = CONV d020s-dnum( is_req-dynpro )
        development_class  = is_req-devclass
        transport_number   = is_req-trkorr
        transaction_type   = lv_type
        shorttext          = is_req-description
        html_enabled       = is_req-web_gui
        java_enabled       = is_req-java_gui
        wingui_enabled     = is_req-win_gui
      EXCEPTIONS
        cancelled           = 1
        already_exist       = 2
        permission_error    = 3
        name_not_allowed    = 4
        name_conflict       = 5
        illegal_type        = 6
        object_inconsistent = 7
        db_access_error     = 8
        OTHERS              = 9.
    DATA(lv_rc) = sy-subrc.
    IF lv_rc <> 0.
      ROLLBACK WORK.
      ev_text = msg_text( ).
      ev_code = SWITCH #( lv_rc WHEN 2 THEN 409 WHEN 3 THEN 403 WHEN 1 THEN 400 WHEN 4 THEN 400
                                WHEN 5 THEN 409 WHEN 6 THEN 400 ELSE 422 ).
      IF ev_text IS INITIAL.
        ev_text = |RPY_TRANSACTION_INSERT failed (exception { lv_rc }) for { is_req-tcode }|.
      ENDIF.
      RETURN.
    ENDIF.
    COMMIT WORK.
    ev_code = 201. ev_text = |Created { is_req-tcode }|.
  ENDMETHOD.


  METHOD do_update.
    DATA ls_tstc  TYPE tstc.
    DATA ls_tstcc TYPE tstcc.

    SELECT SINGLE * FROM tstc WHERE tcode = @is_req-tcode INTO @ls_tstc.
    IF sy-subrc <> 0.
      ev_code = 404. ev_text = |Transaction { is_req-tcode } not found|. RETURN.
    ENDIF.
    IF iv_set_program = abap_false AND iv_set_dynpro = abap_false
       AND iv_set_descr = abap_false AND iv_set_gui = abap_false.
      ev_code = 400. ev_text = `nothing to update: pass program, dynpro, description or a *_gui flag`. RETURN.
    ENDIF.
    IF iv_set_program = abap_true.
      SELECT SINGLE name FROM trdir WHERE name = @is_req-program INTO @DATA(lv_prog).
      IF sy-subrc <> 0.
        ev_code = 400. ev_text = |Program { is_req-program } does not exist|. RETURN.
      ENDIF.
    ENDIF.

    CALL FUNCTION 'RS_ACCESS_PERMISSION'
      EXPORTING
        authority_check = abap_true
        global_lock     = abap_true
        mode            = 'MODIFY'
        object          = is_req-tcode
        object_class    = 'TRAN'
      EXCEPTIONS
        OTHERS          = 1.
    IF sy-subrc <> 0.
      ev_code = 403. ev_text = msg_text( ). RETURN.
    ENDIF.

    " Registers the change in the request. DEVCLASS must be passed (from the
    " object's TADIR entry) or RS_CORR_INSERT opens a package dialog, which
    " dumps in an HTTP session (DYNPRO_SEND_IN_BACKGROUND). Local objects
    " ($...) need no request.
    SELECT SINGLE devclass FROM tadir
      WHERE pgmid = 'R3TR' AND object = 'TRAN' AND obj_name = @is_req-tcode
      INTO @DATA(lv_devclass).
    IF lv_devclass IS NOT INITIAL AND lv_devclass(1) <> '$'.
      CALL FUNCTION 'RS_CORR_INSERT'
        EXPORTING
          global_lock  = abap_true
          devclass     = lv_devclass
          object       = is_req-tcode
          object_class = 'TRAN'
          korrnum      = is_req-trkorr
          mode         = 'INSERT'
        EXCEPTIONS
          cancelled           = 1
          permission_failure  = 2
          unknown_objectclass = 3
          OTHERS              = 4.
      IF sy-subrc <> 0.
        DATA(lv_err) = msg_text( ).
        CALL FUNCTION 'RS_ACCESS_PERMISSION'
          EXPORTING mode = 'FREE' object = is_req-tcode object_class = 'TRAN'.
        ev_code = 422. ev_text = COND #( WHEN lv_err IS NOT INITIAL THEN lv_err ELSE |Transport registration failed for { is_req-tcode }| ).
        RETURN.
      ENDIF.
    ENDIF.

    IF iv_set_program = abap_true.
      UPDATE tstc SET pgmna = @is_req-program WHERE tcode = @is_req-tcode.
    ENDIF.
    IF iv_set_dynpro = abap_true.
      UPDATE tstc SET dypno = @is_req-dynpro WHERE tcode = @is_req-tcode.
    ENDIF.
    IF iv_set_descr = abap_true.
      " Master-language text row (the logon language row if that is the one).
      UPDATE tstct SET ttext = @is_req-description
        WHERE tcode = @is_req-tcode AND sprsl = @sy-langu.
      IF sy-subrc <> 0.
        INSERT tstct FROM @( VALUE #( tcode = is_req-tcode sprsl = sy-langu ttext = is_req-description ) ).
      ENDIF.
    ENDIF.
    IF iv_set_gui = abap_true.
      SELECT SINGLE * FROM tstcc WHERE tcode = @is_req-tcode INTO @ls_tstcc.
      DATA(lv_exists) = xsdbool( sy-subrc = 0 ).
      ls_tstcc-tcode = is_req-tcode.
      IF is_req-web_gui IS NOT INITIAL.
        ls_tstcc-s_webgui = COND #( WHEN is_req-web_gui = 'N' THEN space ELSE '1' ).
      ENDIF.
      IF is_req-java_gui IS NOT INITIAL.
        ls_tstcc-s_platin = COND #( WHEN is_req-java_gui = 'N' THEN space ELSE abap_true ).
      ENDIF.
      IF is_req-win_gui IS NOT INITIAL.
        ls_tstcc-s_win32 = COND #( WHEN is_req-win_gui = 'N' THEN space ELSE abap_true ).
      ENDIF.
      IF lv_exists = abap_true.
        UPDATE tstcc FROM @ls_tstcc.
      ELSE.
        INSERT tstcc FROM @ls_tstcc.
      ENDIF.
    ENDIF.

    CALL FUNCTION 'RS_ACCESS_PERMISSION'
      EXPORTING mode = 'FREE' object = is_req-tcode object_class = 'TRAN'.
    COMMIT WORK.
    ev_code = 200. ev_text = |Updated { is_req-tcode }|.
  ENDMETHOD.


  METHOD do_delete.
    CALL FUNCTION 'RPY_TRANSACTION_DELETE'
      EXPORTING
        transaction      = is_req-tcode
        transport_number = is_req-trkorr
      EXCEPTIONS
        not_excecuted    = 1
        object_not_found = 2
        OTHERS           = 3.
    DATA(lv_rc) = sy-subrc.
    IF lv_rc <> 0.
      ROLLBACK WORK.
      ev_text = msg_text( ).
      ev_code = SWITCH #( lv_rc WHEN 2 THEN 404 ELSE 422 ).
      IF ev_text IS INITIAL.
        ev_text = |RPY_TRANSACTION_DELETE failed (exception { lv_rc }) for { is_req-tcode }|.
      ENDIF.
      RETURN.
    ENDIF.
    COMMIT WORK.
    ev_code = 200. ev_text = |Deleted { is_req-tcode }|.
  ENDMETHOD.

ENDCLASS.
