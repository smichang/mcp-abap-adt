************************************************************************
* Program Type : Class (SICF handler)
* Description  : SICF handler default_host/zmcp/dynpro_transl - language-
*                dependent texts of a classic Dynpro (what SE63 does for a
*                screen) for the ManageDynpro MCP bridge.
*                GET  ?program=X&dynnr=NNNN&language=L -> JSON: translatable
*                     elements with source text, current target text, max length
*                POST ?program=X&dynnr=NNNN&language=L, body
*                     {"texts":[{"element":"NAME","text":"..."}]} -> writes the
*                     target-language texts; the master language is untouched
*                language: SAP key (M), ISO code (ZF) or LXE code (zhTW)
* Author       : SSCR (MCP)
* Created Date : 2026/10/16
* Modifications:
************************************************************************
* Date        Author      RequestNo   Description
* ---------   ---------   ----------  ----------------------------------
* 2026/10/16  SSCR                    Initial version
************************************************************************
CLASS zcl_http_dynpro_transl DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF token store - same DB-backed pattern as ZCL_HTTP_MCP_DYNPRO.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

    CLASS-METHODS map_exception
      IMPORTING
        ix_error TYPE REF TO zcx_mcp_dynpro
      EXPORTING
        ev_code  TYPE i
        ev_text  TYPE string.

ENDCLASS.


CLASS zcl_http_dynpro_transl IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " NOTE ON AUTH: SICF enforces its Alternative Logon Procedure before this method
    " runs; sy-uname is already the authenticated user. Object-level
    " authorization (S_DEVELOP, S_TRANSLAT) is checked in ZCL_MCP_DYNPRO_TRANSL.

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

    IF lv_method <> 'GET' AND lv_method <> 'POST'.
      server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
      server->response->set_cdata( `supported methods: GET, POST` ).
      RETURN.
    ENDIF.

    DATA(lv_program)  = server->request->get_form_field( 'program' ).
    DATA(lv_dynnr)    = server->request->get_form_field( 'dynnr' ).
    DATA(lv_language) = server->request->get_form_field( 'language' ).
    TRANSLATE lv_program TO UPPER CASE.
    CONDENSE: lv_program NO-GAPS, lv_dynnr NO-GAPS, lv_language NO-GAPS.

    IF lv_program IS INITIAL OR lv_dynnr IS INITIAL OR lv_language IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `program, dynnr and language are required` ).
      RETURN.
    ENDIF.
    IF strlen( lv_program ) > 40 OR strlen( lv_dynnr ) > 4 OR strlen( lv_language ) > 4.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `program max 40 characters, dynnr max 4 digits, language max 4 characters` ).
      RETURN.
    ENDIF.
    IF lv_dynnr CN '0123456789'.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `dynnr must be numeric` ).
      RETURN.
    ENDIF.
    DATA lv_dynnr_n TYPE n LENGTH 4.
    lv_dynnr_n = lv_dynnr.

    TRY.
        IF lv_method = 'POST'.
          DATA(lv_info) = zcl_mcp_dynpro_transl=>write(
            iv_program  = CONV progname( lv_program )
            iv_dynnr    = CONV dynnr( lv_dynnr_n )
            iv_language = CONV string( lv_language )
            iv_json     = server->request->get_cdata( ) ).
          server->response->set_status( code = 200 reason = 'OK' ).
          server->response->set_cdata( lv_info ).
          RETURN.
        ENDIF.

        DATA(lv_json) = zcl_mcp_dynpro_transl=>to_json(
          zcl_mcp_dynpro_transl=>list( iv_program  = CONV progname( lv_program )
                                       iv_dynnr    = CONV dynnr( lv_dynnr_n )
                                       iv_language = CONV string( lv_language ) ) ).
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
        "20261002 SSCR eval finding 3: 'mode' is this endpoint's HTTP parameter,
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
