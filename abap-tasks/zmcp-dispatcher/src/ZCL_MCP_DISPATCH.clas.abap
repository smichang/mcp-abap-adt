CLASS zcl_mcp_dispatch DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "! Static action dispatch. Deliberately a compiled CASE, never a
    "! dynamic CREATE OBJECT TYPE (action) - the action string comes
    "! straight from an HTTP request and must never drive dynamic class
    "! instantiation. Adding a new action means adding a WHEN branch here
    "! (a normal WriteProgram+ActivateObjects change), not a registry entry.
    CLASS-METHODS dispatch
      IMPORTING
        action          TYPE string
        payload         TYPE string OPTIONAL
      RETURNING
        VALUE(response) TYPE string
      RAISING
        zcx_mcp_dispatch.

  PROTECTED SECTION.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_kv,
             k TYPE string,
             v TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH EMPTY KEY.

    CLASS-METHODS parse_kv
      IMPORTING payload      TYPE string
      RETURNING VALUE(rt_kv) TYPE tt_kv.
    CLASS-METHODS kv_get
      IMPORTING it_kv          TYPE tt_kv
                key            TYPE string
      RETURNING VALUE(rv_value) TYPE string.

    CLASS-METHODS handle_ping
      IMPORTING
        payload         TYPE string
      RETURNING
        VALUE(response) TYPE string.
    CLASS-METHODS handle_echo_upper
      IMPORTING
        payload         TYPE string
      RETURNING
        VALUE(response) TYPE string.
    CLASS-METHODS handle_create_sicf_node
      IMPORTING
        payload         TYPE string
      RETURNING
        VALUE(response) TYPE string
      RAISING
        zcx_mcp_dispatch.
    CLASS-METHODS handle_delete_sicf_node
      IMPORTING
        payload         TYPE string
      RETURNING
        VALUE(response) TYPE string
      RAISING
        zcx_mcp_dispatch.
ENDCLASS.

CLASS zcl_mcp_dispatch IMPLEMENTATION.

  METHOD dispatch.
    CASE action.
      WHEN 'ping'.
        response = handle_ping( payload ).
      WHEN 'echo_upper'.
        response = handle_echo_upper( payload ).
      WHEN 'create_sicf_node'.
        response = handle_create_sicf_node( payload ).
      WHEN 'delete_sicf_node'.
        response = handle_delete_sicf_node( payload ).
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_mcp_dispatch
          EXPORTING
            textid = zcx_mcp_dispatch=>unknown_action
            action = action.
    ENDCASE.
  ENDMETHOD.

  METHOD handle_ping.
    response = |pong{ cl_abap_char_utilities=>newline }| &&
               |uname: { sy-uname }{ cl_abap_char_utilities=>newline }| &&
               |timestamp: { sy-datum DATE = ISO } { sy-uzeit TIME = ISO }{ cl_abap_char_utilities=>newline }| &&
               |payload: { payload }|.
  ENDMETHOD.

  METHOD handle_echo_upper.
    response = to_upper( payload ).
  ENDMETHOD.

  METHOD parse_kv.
    " One "key=value" per line - same plain-text convention used
    " elsewhere in this project (e.g. ZCL_HTTP_MCP_TEXTPOOL's category
    " bodies). Blank lines and lines without "=" are ignored.
    SPLIT payload AT cl_abap_char_utilities=>newline INTO TABLE DATA(lt_lines).
    LOOP AT lt_lines INTO DATA(lv_line).
      CHECK lv_line IS NOT INITIAL.
      CHECK lv_line CS '='.
      APPEND VALUE #( k = condense( to_lower( substring_before( val = lv_line sub = '=' ) ) )
                       v = substring_after( val = lv_line sub = '=' ) )
             TO rt_kv.
    ENDLOOP.
  ENDMETHOD.

  METHOD kv_get.
    READ TABLE it_kv INTO DATA(ls_kv) WITH KEY k = key.
    IF sy-subrc = 0.
      rv_value = ls_kv-v.
    ENDIF.
  ENDMETHOD.

  METHOD handle_create_sicf_node.
    DATA(lt_kv) = parse_kv( payload ).
    DATA(lv_name)          = kv_get( it_kv = lt_kv key = 'name' ).
    DATA(lv_handler_class) = kv_get( it_kv = lt_kv key = 'handler_class' ).
    DATA(lv_docu)          = kv_get( it_kv = lt_kv key = 'docu' ).
    DATA(lv_transport)     = kv_get( it_kv = lt_kv key = 'transport' ).

    IF lv_name IS INITIAL OR lv_handler_class IS INITIAL OR lv_docu IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'create_sicf_node'
          detail = 'name, handler_class, and docu are all required'.
    ENDIF.

    DATA(lv_guid) = zcl_mcp_sicf_admin=>create_node(
      iv_name          = CONV icfname( lv_name )
      iv_handler_class = CONV seoclsname( lv_handler_class )
      iv_docu          = CONV icf_docu( lv_docu )
      iv_transport     = CONV trkorr( lv_transport ) ).

    response = |created + activated: default_host/zmcp/{ lv_name }| &&
               |{ cl_abap_char_utilities=>newline }handler: { to_upper( lv_handler_class ) }| &&
               |{ cl_abap_char_utilities=>newline }node_guid: { lv_guid }|.
  ENDMETHOD.

  METHOD handle_delete_sicf_node.
    DATA(lt_kv) = parse_kv( payload ).
    DATA(lv_name)      = kv_get( it_kv = lt_kv key = 'name' ).
    DATA(lv_transport) = kv_get( it_kv = lt_kv key = 'transport' ).

    IF lv_name IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'delete_sicf_node'
          detail = 'name is required'.
    ENDIF.

    zcl_mcp_sicf_admin=>delete_node(
      iv_name      = CONV icfname( lv_name )
      iv_transport = CONV trkorr( lv_transport ) ).

    response = |deleted: default_host/zmcp/{ lv_name }|.
  ENDMETHOD.

ENDCLASS.
