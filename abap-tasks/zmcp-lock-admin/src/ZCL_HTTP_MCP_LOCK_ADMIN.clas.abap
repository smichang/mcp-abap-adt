CLASS zcl_http_mcp_lock_admin DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF: same DB-backed token pattern as ZCL_HTTP_MCP_TRANSPORT_ADMIN.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

ENDCLASS.


CLASS zcl_http_mcp_lock_admin IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " Auth: SICF has already authenticated the caller (Alternative Logon Procedure); sy-uname is the caller.
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

    IF lv_method <> 'POST'.
      server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
      RETURN.
    ENDIF.

    DATA(lv_object_name) = server->request->get_form_field( 'object_name' ).
    DATA(lv_delete)      = server->request->get_form_field( 'delete' ).
    TRANSLATE lv_object_name TO UPPER CASE.

    TRY.
        DATA(lv_info) = zcl_mcp_lock_admin=>clear_own_locks(
          iv_object_name = lv_object_name
          iv_delete      = xsdbool( to_upper( lv_delete ) = 'X' ) ).
        server->response->set_status( code = 200 reason = 'OK' ).
        server->response->set_cdata( lv_info ).
      CATCH zcx_mcp_dispatch INTO DATA(lx_error).
        server->response->set_status( code = 409 reason = 'Conflict' ).
        server->response->set_cdata( |{ lx_error->action }: { lx_error->detail }| ).
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
