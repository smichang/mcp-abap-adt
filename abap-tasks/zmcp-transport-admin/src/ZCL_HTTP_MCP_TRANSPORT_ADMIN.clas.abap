CLASS zcl_http_mcp_transport_admin DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF token store - same DB-backed pattern as ZCL_HTTP_MCP_TEXTPOOL /
    " ZCL_HTTP_MCP_AUTH_OBJECT (EXPORT/IMPORT TO MEMORY ID was live-rejected on
    " this node family: it issues a session cookie but is not running a
    " genuinely stateful ICF session). Keyed by sy-uname, already
    " Basic-Auth verified by the SICF node's own logon procedure.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

ENDCLASS.


CLASS zcl_http_mcp_transport_admin IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " NOTE ON AUTH: nothing to do here - see ZCL_HTTP_MCP_AUTH_OBJECT's own
    " note. SICF enforces Basic Authentication before this method runs;
    " sy-uname is already the authenticated user.

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
      GET TIME STAMP FIELD lv_now.
      IF sy-subrc <> 0 OR lv_expected_token IS INITIAL OR lv_csrf_hdr <> lv_expected_token
         OR lv_now - lv_issued_at2 > co_csrf_ttl_sec.
        server->response->set_status( code = 403 reason = 'Forbidden' ).
        server->response->set_cdata( `CSRF token validation failed` ).
        RETURN.
      ENDIF.
    ENDIF.

    IF lv_method <> 'POST'.
      server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
      RETURN.
    ENDIF.

    DATA(lv_action)       = server->request->get_form_field( 'action' ).
    DATA(lv_pgmid)        = server->request->get_form_field( 'pgmid' ).
    DATA(lv_object_type)  = server->request->get_form_field( 'object_type' ).
    DATA(lv_object_name)  = server->request->get_form_field( 'object_name' ).
    DATA(lv_target)       = server->request->get_form_field( 'target_trkorr' ).
    DATA(lv_trkorr)       = server->request->get_form_field( 'trkorr' ).

    TRANSLATE: lv_action TO UPPER CASE, lv_pgmid TO UPPER CASE, lv_object_type TO UPPER CASE,
               lv_object_name TO UPPER CASE, lv_target TO UPPER CASE, lv_trkorr TO UPPER CASE.

    " action defaults to move_object - preserves the original single-purpose
    " contract for any caller that never sends this new param.
    IF lv_action IS INITIAL.
      lv_action = 'MOVE_OBJECT'.
    ENDIF.
    IF lv_pgmid IS INITIAL.
      lv_pgmid = 'R3TR'.
    ENDIF.

    IF lv_object_type IS INITIAL OR lv_object_name IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `object_type and object_name are required` ).
      RETURN.
    ENDIF.
    IF lv_action = 'MOVE_OBJECT' AND lv_target IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `target_trkorr is required for action=move_object` ).
      RETURN.
    ENDIF.
    IF lv_action = 'DELETE_OBJECT' AND lv_trkorr IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `trkorr is required for action=delete_object` ).
      RETURN.
    ENDIF.
    IF lv_action <> 'MOVE_OBJECT' AND lv_action <> 'DELETE_OBJECT'.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( |unsupported action: { lv_action }| ).
      RETURN.
    ENDIF.

    TRY.
        DATA lv_info TYPE string.
        IF lv_action = 'MOVE_OBJECT'.
          lv_info = zcl_mcp_transport_admin=>move_object(
            iv_pgmid         = CONV pgmid( lv_pgmid )
            iv_object_type   = CONV trobjtype( lv_object_type )
            iv_object_name   = CONV trobj_name( lv_object_name )
            iv_target_trkorr = CONV trkorr( lv_target ) ).
        ELSE.
          lv_info = zcl_mcp_transport_admin=>delete_object(
            iv_pgmid       = CONV pgmid( lv_pgmid )
            iv_object_type = CONV trobjtype( lv_object_type )
            iv_object_name = CONV trobj_name( lv_object_name )
            iv_trkorr      = CONV trkorr( lv_trkorr ) ).
        ENDIF.
        server->response->set_status( code = 200 reason = 'OK' ).
        server->response->set_cdata( lv_info ).
      CATCH zcx_mcp_dispatch INTO DATA(lx_error).
        " get_text() renders via the T100 message template, which truncates
        " each placeholder (action/detail) to 50 chars (classic SY-MSGV1..4
        " width) - found live (a real CTS error message got cut off mid-
        " sentence). detail is a plain TYPE string attribute, never routed
        " through that template - read it directly for the untruncated text.
        server->response->set_status( code = 409 reason = 'Conflict' ).
        server->response->set_cdata( |{ lx_error->action }: { lx_error->detail }| ).
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
