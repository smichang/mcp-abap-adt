CLASS zcl_http_mcp_auth_object DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " CSRF token store - same DB-backed pattern as ZCL_HTTP_MCP_TEXTPOOL
    " (EXPORT/IMPORT TO MEMORY ID was live-rejected there: this SICF node
    " issues a session cookie but is not running a genuinely stateful ICF
    " session, so ABAP memory does not survive across requests). Keyed by
    " sy-uname, already Basic-Auth verified by the SICF node's own logon
    " procedure before this method ever runs.
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

    METHODS parse_fields
      IMPORTING iv_body            TYPE string
      RETURNING VALUE(rt_fields)   TYPE zcl_mcp_auth_object=>tt_field.

    METHODS parse_activities
      IMPORTING iv_list              TYPE string
      RETURNING VALUE(rt_activities) TYPE zcl_mcp_auth_object=>tt_activity.

    METHODS map_exception
      IMPORTING ix_error TYPE REF TO zcx_mcp_auth_object
      EXPORTING ev_code  TYPE i
                ev_text  TYPE string.

ENDCLASS.


CLASS zcl_http_mcp_auth_object IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " NOTE ON AUTH: nothing to do here - see ZCL_HTTP_MCP_TEXTPOOL's own
    " note. SICF enforces Basic Authentication before this method runs;
    " sy-uname is already the authenticated user.

    DATA(lv_method) = server->request->get_header_field( name = '~request_method' ).

    " CSRF: identical protocol to ZCL_HTTP_MCP_TEXTPOOL / /sap/bc/adt -
    " X-CSRF-Token: Fetch on any request issues a token; every non-GET
    " must then present that same token.
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

    DATA(lv_mode)         = server->request->get_form_field( 'mode' ).
    DATA(lv_object_class) = server->request->get_form_field( 'object_class' ).
    DATA(lv_object_name)  = server->request->get_form_field( 'object_name' ).
    DATA(lv_description)  = server->request->get_form_field( 'description' ).
    DATA(lv_devclass)     = server->request->get_form_field( 'devclass' ).
    DATA(lv_trkorr)       = server->request->get_form_field( 'trkorr' ).
    " Comma-separated permitted activities for ACTVT, e.g. "02,03".
    DATA(lv_activities)   = server->request->get_form_field( 'activities' ).
    DATA(lv_body)         = server->request->get_cdata( ).

    TRANSLATE lv_mode TO LOWER CASE.

    IF lv_mode <> 'create' AND lv_mode <> 'update'.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `mode must be "create" or "update"` ).
      RETURN.
    ENDIF.

    IF lv_object_name IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `object_name is required` ).
      RETURN.
    ENDIF.

    DATA(lt_fields)     = parse_fields( lv_body ).
    DATA(lt_activities) = parse_activities( lv_activities ).

    DATA(lo_maint) = NEW zcl_mcp_auth_object( ).

    IF lv_mode = 'create'.

      IF lv_object_class IS INITIAL.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( `object_class is required for mode=create` ).
        RETURN.
      ENDIF.
      IF lv_devclass IS INITIAL.
        server->response->set_status( code = 400 reason = 'Bad Request' ).
        server->response->set_cdata( `devclass is required for mode=create` ).
        RETURN.
      ENDIF.

      TRY.
          lo_maint->create_object(
            object_class = lv_object_class
            object_name  = lv_object_name
            description  = lv_description
            fields       = lt_fields
            activities   = lt_activities
            devclass     = CONV #( lv_devclass )
            trkorr       = CONV #( lv_trkorr ) ).
          server->response->set_status( code = 201 reason = 'Created' ).
          server->response->set_cdata( |Created { lv_object_name }| ).
        CATCH zcx_mcp_auth_object INTO DATA(lx_create).
          DATA lv_code TYPE i.
          DATA lv_text TYPE string.
          map_exception( EXPORTING ix_error = lx_create IMPORTING ev_code = lv_code ev_text = lv_text ).
          server->response->set_status( code = lv_code reason = 'Error' ).
          server->response->set_cdata( lv_text ).
      ENDTRY.

    ELSE. " update

      TRY.
          lo_maint->update_object(
            object_name  = lv_object_name
            object_class = lv_object_class
            description  = lv_description
            fields       = lt_fields
            activities   = lt_activities
            trkorr       = CONV #( lv_trkorr ) ).
          server->response->set_status( code = 200 reason = 'OK' ).
          server->response->set_cdata( |Updated { lv_object_name }| ).
        CATCH zcx_mcp_auth_object INTO DATA(lx_update).
          DATA lv_code2 TYPE i.
          DATA lv_text2 TYPE string.
          map_exception( EXPORTING ix_error = lx_update IMPORTING ev_code = lv_code2 ev_text = lv_text2 ).
          server->response->set_status( code = lv_code2 reason = 'Error' ).
          server->response->set_cdata( lv_text2 ).
      ENDTRY.

    ENDIF.

  ENDMETHOD.


  METHOD parse_fields.
    " Body is a plain comma-separated list of field names, e.g.
    " "BUKRS,WERKS" - deliberately the simplest possible wire format
    " since a real authorization object has at most 10 short field names.
    " An empty/whitespace-only body means "no fields": header-only on
    " create, "keep the current field list" on update.
    DATA(lv_trimmed) = condense( iv_body ).
    CHECK lv_trimmed IS NOT INITIAL.
    SPLIT lv_trimmed AT ',' INTO TABLE DATA(lt_raw).
    LOOP AT lt_raw INTO DATA(lv_raw).
      DATA(lv_field) = condense( to_upper( lv_raw ) ).
      CHECK lv_field IS NOT INITIAL.
      APPEND VALUE #( field_name = lv_field ) TO rt_fields.
    ENDLOOP.
  ENDMETHOD.


  METHOD parse_activities.
    DATA(lv_trimmed) = condense( iv_list ).
    CHECK lv_trimmed IS NOT INITIAL.
    SPLIT lv_trimmed AT ',' INTO TABLE DATA(lt_raw).
    LOOP AT lt_raw INTO DATA(lv_raw).
      DATA(lv_act) = condense( to_upper( lv_raw ) ).
      CHECK lv_act IS NOT INITIAL.
      APPEND lv_act TO rt_activities.
    ENDLOOP.
  ENDMETHOD.


  METHOD map_exception.
    " Text is built here, not via get_text(): message class ZMCP_AUTH_OBJECT
    " does not exist (get_text() only yields "I:ZMCP_AUTH_OBJECT:008 ..."),
    " and T100 rendering would cut each placeholder at 50 chars anyway -
    " same reason ZCL_HTTP_MCP_TRANSPORT_ADMIN reads DETAIL directly.
    DATA(lv_obj) = ix_error->object_name.
    " msgno is unique within msgid ZMCP_AUTH_OBJECT (one per constant), so
    " switching on it alone is sufficient here.
    CASE ix_error->if_t100_message~t100key-msgno.
      WHEN zcx_mcp_auth_object=>permission_denied-msgno.
        ev_code = 403. ev_text = |Not allowed to maintain { lv_obj }|.
      WHEN zcx_mcp_auth_object=>already_exists-msgno.
        ev_code = 409. ev_text = |Authorization object { lv_obj } already exists|.
      WHEN zcx_mcp_auth_object=>not_found-msgno.
        ev_code = 404. ev_text = |Authorization object { lv_obj } not found|.
      WHEN zcx_mcp_auth_object=>invalid_field-msgno.
        ev_code = 400. ev_text = |Invalid authorization field { ix_error->field_name }|.
      WHEN zcx_mcp_auth_object=>name_too_long-msgno.
        ev_code = 400. ev_text = |Object name { lv_obj } too long|.
      WHEN zcx_mcp_auth_object=>invalid_namespace-msgno.
        ev_code = 400. ev_text = |Object name { lv_obj } must be in customer namespace (Y/Z)|.
      WHEN zcx_mcp_auth_object=>class_not_found-msgno.
        ev_code = 400. ev_text = |Object class { ix_error->object_class } not found|.
      WHEN zcx_mcp_auth_object=>save_failed-msgno.
        ev_code = 422. ev_text = |SU21 save failed for { lv_obj }|.
      WHEN zcx_mcp_auth_object=>invalid_activity-msgno.
        ev_code = 400. ev_text = |Invalid activity list for { lv_obj }|.
      WHEN zcx_mcp_auth_object=>field_locked-msgno.
        ev_code = 409. ev_text = |Field list of { lv_obj } cannot be changed|.
      WHEN OTHERS.
        ev_code = 400. ev_text = ix_error->get_text( ).
    ENDCASE.
    IF ix_error->detail IS NOT INITIAL.
      ev_text = |{ ev_text }: { ix_error->detail }|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
