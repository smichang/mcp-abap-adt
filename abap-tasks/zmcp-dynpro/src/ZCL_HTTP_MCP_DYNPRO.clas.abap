************************************************************************
* SICF handler default_host/zmcp/dynpro - classic Dynpro read/write for the
* ManageDynpro MCP tool.
*   GET    ?program=X            -> JSON list of screens
*   GET    ?program=X&dynnr=NNNN -> JSON screen definition
*   POST   ?program=X&dynnr=NNNN&mode=create|update[&trkorr=T]
*          body = JSON screen definition
*   DELETE ?program=X&dynnr=NNNN[&trkorr=T]
*   GET    ?program=X&dynnr=NNNN&check=true -> SE51 consistency check
* POST and check=true set the response header x-mcp-check:
* errors | warnings | ok
************************************************************************
CLASS zcl_http_mcp_dynpro DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF token store - same DB-backed pattern as ZCL_HTTP_MCP_AUTH_OBJECT /
    " ZCL_HTTP_MCP_TEXTPOOL (EXPORT/IMPORT TO MEMORY ID was live-rejected
    " on this node family: not a genuinely stateful ICF session). Keyed by
    " sy-uname, already authenticated by the SICF node's logon.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

    CLASS-METHODS set_check_result
      IMPORTING
        server     TYPE REF TO if_http_server
        iv_program TYPE progname
        iv_dynnr   TYPE dynnr
        iv_prefix  TYPE string
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS map_exception
      IMPORTING
        ix_error TYPE REF TO zcx_mcp_dynpro
      EXPORTING
        ev_code  TYPE i
        ev_text  TYPE string.

ENDCLASS.


CLASS zcl_http_mcp_dynpro IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " NOTE ON AUTH: SICF enforces its Alternative Logon Procedure before this method
    " runs; sy-uname is already the authenticated user. Object-level
    " authorization (S_DEVELOP) is checked in ZCL_MCP_DYNPRO.

    DATA(lv_method) = server->request->get_header_field( name = '~request_method' ).

    " CSRF: identical protocol to ZCL_HTTP_MCP_AUTH_OBJECT / ZCL_HTTP_MCP_TEXTPOOL.
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
      " A TIMESTAMP is the number YYYYMMDDhhmmss, so "lv_now - lv_issued_at2"
      " is not a count of seconds (it jumps across minute/hour boundaries).
      " CL_ABAP_TSTMP=>SUBTRACT returns the real difference in seconds.
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

    " POST/DELETE added
    IF lv_method <> 'GET' AND lv_method <> 'POST' AND lv_method <> 'DELETE'.
      server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
      server->response->set_cdata( `supported methods: GET, POST, DELETE` ).
      RETURN.
    ENDIF.

    DATA(lv_program) = server->request->get_form_field( 'program' ).
    DATA(lv_dynnr)   = server->request->get_form_field( 'dynnr' ).
    DATA(lv_mode)    = server->request->get_form_field( 'mode' ).
    DATA(lv_trkorr)  = server->request->get_form_field( 'trkorr' ).
    DATA(lv_check)   = to_lower( server->request->get_form_field( 'check' ) ).
    TRANSLATE: lv_program TO UPPER CASE, lv_trkorr TO UPPER CASE.
    CONDENSE: lv_program NO-GAPS, lv_dynnr NO-GAPS, lv_trkorr NO-GAPS.

    IF lv_program IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `program is required` ).
      RETURN.
    ENDIF.
    IF strlen( lv_program ) > 40 OR strlen( lv_dynnr ) > 4.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `program max 40 characters, dynnr max 4 digits` ).
      RETURN.
    ENDIF.

    IF lv_method <> 'GET' AND lv_dynnr IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( |dynnr is required for { lv_method }| ).
      RETURN.
    ENDIF.
    IF strlen( lv_trkorr ) > 20.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `trkorr max 20 characters` ).
      RETURN.
    ENDIF.

    " accept "100" as well as "0100"
    DATA lv_dynnr_n TYPE n LENGTH 4.
    IF lv_dynnr IS NOT INITIAL.
      IF lv_dynnr CN '0123456789'.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( `dynnr must be numeric` ).
        RETURN.
      ENDIF.
      lv_dynnr_n = lv_dynnr.
    ENDIF.

    TRY.
        DATA lv_json TYPE string.
        IF lv_method = 'POST'.
          DATA(lv_info) = zcl_mcp_dynpro=>write(
            iv_program = CONV progname( lv_program )
            iv_dynnr   = CONV dynnr( lv_dynnr_n )
            is_dynpro  = zcl_mcp_dynpro=>from_json( server->request->get_cdata( ) )
            iv_mode    = lv_mode
            iv_trkorr  = CONV trkorr( lv_trkorr ) ).
          " SE51 consistency check on the saved screen. It
          "commits implicitly, so it can only run after the write is final -
          "a blocking finding is reported, not rolled back.
          set_check_result( server     = server
                            iv_program = CONV progname( lv_program )
                            iv_dynnr   = CONV dynnr( lv_dynnr_n )
                            iv_prefix  = lv_info ).
          RETURN.
        ELSEIF lv_method = 'DELETE'.
          lv_info = zcl_mcp_dynpro=>delete(
            iv_program = CONV progname( lv_program )
            iv_dynnr   = CONV dynnr( lv_dynnr_n )
            iv_trkorr  = CONV trkorr( lv_trkorr ) ).
          server->response->set_status( code = 200 reason = 'OK' ).
          server->response->set_cdata( lv_info ).
          RETURN.
        ENDIF.

        IF lv_check = 'true' OR lv_check = 'x'.
          IF lv_dynnr IS INITIAL.
            server->response->set_status( code = 400 reason = 'Bad Request' ).
            server->response->set_cdata( `dynnr is required for check=true` ).
            RETURN.
          ENDIF.
          set_check_result( server     = server
                            iv_program = CONV progname( lv_program )
                            iv_dynnr   = CONV dynnr( lv_dynnr_n )
                            iv_prefix  = |Consistency check of screen { lv_program } { lv_dynnr_n }:| ).
          RETURN.
        ENDIF.

        IF lv_dynnr IS INITIAL.
          lv_json = zcl_mcp_dynpro=>to_json(
            zcl_mcp_dynpro=>list( CONV progname( lv_program ) ) ).
        ELSE.
          lv_json = zcl_mcp_dynpro=>to_json(
            zcl_mcp_dynpro=>read( iv_program = CONV progname( lv_program )
                                  iv_dynnr   = CONV dynnr( lv_dynnr_n ) ) ).
        ENDIF.
        server->response->set_status( code = 200 reason = 'OK' ).
        server->response->set_header_field( name = 'content-type' value = 'application/json; charset=utf-8' ).
        server->response->set_cdata( lv_json ).
      CATCH zcx_mcp_dynpro INTO DATA(lx_error).
        DATA lv_code TYPE i.
        DATA lv_text TYPE string.
        map_exception( EXPORTING ix_error = lx_error
                       IMPORTING ev_code  = lv_code
                                 ev_text  = lv_text ).
        server->response->set_status( code = lv_code reason = 'Error' ).
        server->response->set_cdata( lv_text ).
    ENDTRY.

  ENDMETHOD.


  METHOD set_check_result.
    zcl_mcp_dynpro=>check( EXPORTING iv_program  = iv_program
                                     iv_dynnr    = iv_dynnr
                           IMPORTING ev_errors   = DATA(lv_errors)
                                     ev_warnings = DATA(lv_warnings) ).
    DATA(lv_text) = iv_prefix.
    IF lv_errors IS NOT INITIAL.
      lv_text = |{ lv_text }\nCONSISTENCY ERRORS - the screen is saved but will fail at runtime; | &&
                |fix them (e.g. add the MODULE to the program, add CALL SUBSCREEN) and check/update again:{ lv_errors }|.
    ENDIF.
    IF lv_warnings IS NOT INITIAL.
      lv_text = |{ lv_text }\nConsistency warnings:{ lv_warnings }|.
    ENDIF.
    IF lv_errors IS INITIAL AND lv_warnings IS INITIAL.
      lv_text = |{ lv_text }\nConsistency check: no findings.|.
    ENDIF.
    server->response->set_header_field(
      name  = 'x-mcp-check'
      value = COND string( WHEN lv_errors IS NOT INITIAL THEN `errors`
                           WHEN lv_warnings IS NOT INITIAL THEN `warnings`
                           ELSE `ok` ) ).
    server->response->set_status( code = 200 reason = 'OK' ).
    server->response->set_cdata( lv_text ).
  ENDMETHOD.


  METHOD map_exception.
    " Text is built here, not via get_text(): message class ZMCP_DYNPRO does
    " not exist, and T100 rendering would cut each placeholder at 50 chars -
    " same reason as ZCL_HTTP_MCP_AUTH_OBJECT / ZCL_HTTP_MCP_TRANSPORT_ADMIN.
    DATA(lv_screen) = condense( |{ ix_error->program } { ix_error->dynnr }| ).
    CASE ix_error->if_t100_message~t100key-msgno.
      WHEN zcx_mcp_dynpro=>bad_request-msgno.
        ev_code = 400. ev_text = `Bad request`.
      WHEN zcx_mcp_dynpro=>permission_denied-msgno.
        ev_code = 403. ev_text = |Not authorized for { lv_screen }|.
      WHEN zcx_mcp_dynpro=>program_not_found-msgno.
        ev_code = 404. ev_text = |Program { ix_error->program } not found|.
      WHEN zcx_mcp_dynpro=>screen_not_found-msgno.
        ev_code = 404. ev_text = |Screen { lv_screen } not found|.
      WHEN zcx_mcp_dynpro=>read_failed-msgno.
        ev_code = 500. ev_text = |Reading screen { lv_screen } failed|.
      WHEN zcx_mcp_dynpro=>already_exists-msgno.
        " 'mode' is this endpoint's HTTP parameter,
        "not the caller's - say what to do instead
        ev_code = 409. ev_text = |Screen { lv_screen } already exists - update it instead of creating it|.
      WHEN zcx_mcp_dynpro=>not_supported-msgno.
        ev_code = 400. ev_text = |Not supported for { lv_screen }|.
      WHEN zcx_mcp_dynpro=>transport_invalid-msgno.
        ev_code = 400. ev_text = |Transport problem for { lv_screen }|.
      WHEN zcx_mcp_dynpro=>write_failed-msgno.
        ev_code = 422. ev_text = |Writing screen { lv_screen } failed|.
      WHEN zcx_mcp_dynpro=>conflict-msgno.
        ev_code = 409. ev_text = |Conflict on screen { lv_screen }|.
      WHEN OTHERS.
        ev_code = 500. ev_text = ix_error->get_text( ).
    ENDCASE.
    IF ix_error->detail IS NOT INITIAL.
      ev_text = |{ ev_text }: { ix_error->detail }|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
