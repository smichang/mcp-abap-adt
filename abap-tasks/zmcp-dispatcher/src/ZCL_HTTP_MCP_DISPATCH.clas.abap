CLASS zcl_http_mcp_dispatch DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF token store: EXPORT/IMPORT TO DATABASE indx(zt), keyed by the
    " already-Basic-Auth-verified sy-uname - NOT session/MEMORY ID. Copied
    " as a pattern from ZCL_HTTP_MCP_TEXTPOOL (a session cookie proves
    " routing stickiness only, not that ABAP session memory survives
    " across separate HTTP dispatches for a plain IF_HTTP_EXTENSION
    " handler) and re-verified live for this node rather than assumed to
    " carry over unchanged.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

ENDCLASS.

CLASS zcl_http_mcp_dispatch IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " AUTH: nothing to do here - the SICF node is configured with the same
    " Basic Authentication logon procedure as /sap/bc/adt/* and
    " .../zmcp/textpool; the framework rejects unauthenticated
    " requests before this method ever runs. sy-uname is already the
    " authenticated user by the time we get here.

    DATA(lv_method) = server->request->get_header_field( name = '~request_method' ).

    " CSRF: identical protocol to ZCL_HTTP_MCP_TEXTPOOL. A request
    " carrying X-CSRF-Token: Fetch gets a fresh token back and nothing
    " else runs. Any non-GET request must then present that same token
    " (issued within the last co_csrf_ttl_sec seconds) or is rejected
    " before ZCL_MCP_DISPATCH ever sees the request.
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

    DATA(lv_action) = server->request->get_form_field( 'action' ).
    TRANSLATE lv_action TO LOWER CASE.

    IF lv_action IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `action query parameter is required` ).
      RETURN.
    ENDIF.

    " GET carries payload (if any) as a query param, since a GET request
    " has no meaningful body; any mutating verb carries it as the raw
    " request body instead - each action's own handler in ZCL_MCP_DISPATCH
    " interprets the payload string however it needs to, the dispatcher
    " and this HTTP layer impose no shared schema on it.
    DATA lv_payload TYPE string.
    IF lv_method = 'GET'.
      lv_payload = server->request->get_form_field( 'payload' ).
    ELSE.
      lv_payload = server->request->get_cdata( ).
    ENDIF.

    TRY.
        DATA(lv_response) = zcl_mcp_dispatch=>dispatch(
          action  = lv_action
          payload = lv_payload ).
        server->response->set_status( code = 200 reason = 'OK' ).
        server->response->set_cdata( lv_response ).
      CATCH zcx_mcp_dispatch INTO DATA(lx).
        IF lx->if_t100_message~t100key = zcx_mcp_dispatch=>unknown_action.
          server->response->set_status( code = 404 reason = 'Not Found' ).
        ELSEIF lx->if_t100_message~t100key = zcx_mcp_dispatch=>permission_denied.
          server->response->set_status( code = 403 reason = 'Forbidden' ).
        ELSE.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
        ENDIF.
        server->response->set_cdata( lx->get_text( ) ).
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
