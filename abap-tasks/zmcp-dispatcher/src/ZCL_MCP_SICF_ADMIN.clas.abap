CLASS zcl_mcp_sicf_admin DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    "! Creates (and activates) a new SICF node directly under
    "! default_host/zmcp, bound to an existing handler class that must
    "! already implement IF_HTTP_EXTENSION. The zmcp parent is resolved
    "! live by name every call (never a hardcoded GUID) and verified to
    "! sit directly under the well-known default_host node - this method
    "! can never create a node anywhere else in the ICF tree, regardless
    "! of caller input, because the parent is looked up here, not taken
    "! from the request. Calls CL_ICF_TREE=>IF_ICF_TREE~INSERT_NODE
    "! directly (package SHTTP, the same API transaction SICF itself is
    "! built on) rather than the simplified HTTPTREE_INSERT_NODE FM - see
    "! the login_process comment below for why.
    CLASS-METHODS create_node
      IMPORTING
        iv_name          TYPE icfname
        iv_handler_class TYPE seoclsname
        iv_docu          TYPE icf_docu
        iv_transport     TYPE trkorr OPTIONAL
      RETURNING
        VALUE(rv_node_guid) TYPE icfnodguid
      RAISING
        zcx_mcp_dispatch.

    "! Deletes a node directly under default_host/zmcp. Calls
    "! CL_ICF_TREE=>IF_ICF_TREE~DELETE_NODE directly (not the
    "! HTTPTREE_DELETE_NODE FM, which dumped live - see below) with
    "! i_dark_transport = abap_true.
    "!
    "! HISTORY: the FM version of this call dumped live
    "! (DYNPRO_SEND_IN_BACKGROUND) because it always routes through
    "! TR_OBJECT_CHECK/TR_OBJECT_INSERT, which can open an interactive
    "! CALL SCREEN dialog (TRINT_TADIR_POPUP) - fine in SICF's own GUI,
    "! fatal with no screen. Reading DELETE_NODE's own source found
    "! i_dark_transport: when true, it skips that path entirely and
    "! instead calls CTS_WBO_API_CHECK_OBJECTS/CTS_WBO_API_INSERT_OBJECTS
    "! - a headless CTS API built for exactly this (API-driven object
    "! registration, no dialog). Same AUTHORITY_CHECK_TCODE('SICF') +
    "! ICF_AUTHORITY_CHECK as create_node either way - i_dark_transport
    "! only changes the transport-registration mechanism, not the
    "! authorization boundary.
    CLASS-METHODS delete_node
      IMPORTING
        iv_name      TYPE icfname
        iv_transport TYPE trkorr OPTIONAL
      RAISING
        zcx_mcp_dispatch.

  PRIVATE SECTION.
    " The default_host node is a fixed, well-known GUID on every SAP
    " system (25 zeroes) - confirmed via ICFSERVICE
    " (DEFAULT_HOST's own ICFNODGUID). zmcp's OWN guid is still resolved
    " fresh every call, never cached/hardcoded.
    CONSTANTS co_default_host_guid TYPE icfparguid VALUE '0000000000000000000000000'.

    CLASS-METHODS resolve_zmcp_guid
      RETURNING VALUE(rv_guid) TYPE icfparguid
      RAISING   zcx_mcp_dispatch.

ENDCLASS.

CLASS zcl_mcp_sicf_admin IMPLEMENTATION.

  METHOD resolve_zmcp_guid.
    SELECT SINGLE icfnodguid FROM icfservice INTO rv_guid
      WHERE icf_name = 'ZMCP' AND icfparguid = co_default_host_guid.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          detail = 'default_host/zmcp node not found - cannot resolve parent'.
    ENDIF.
  ENDMETHOD.

  METHOD create_node.

    DATA(lv_parent_guid) = resolve_zmcp_guid( ).

    DATA lt_handlerlist TYPE icfhndlist.
    DATA(lv_handler) = iv_handler_class.
    TRANSLATE lv_handler TO UPPER CASE.
    APPEND lv_handler TO lt_handlerlist.

    DATA ls_icfserdesc TYPE icfserdesc.
    " Logon Procedure = "Alternative Logon Procedure" (the SICF Logon Data
    " tab). In ICFSERVICE that is LOG_FLAG = 'X' (data element ICFLOGFLAG,
    " "Flag for Selecting Alternative Logon Order") together with
    " LOGIN_PROCESS = 'L', LOG_ORDER left empty - exactly what the manual
    " dispatch node and /sap/bc/adt carry. LOGIN_PROCESS = 'L' alone is NOT
    " enough: the screen then still shows "Standard". INSERT_NODE derives
    " both fields from icfserdesc-log_flag ('X' -> login_process 'L',
    " log_flag 'X', log_order copied), so only log_flag has to be set.
    " The simplified HTTPTREE_INSERT_NODE FM ignores icfserdesc logon
    " fields (verified by reading its source), which is why this method
    " calls CL_ICF_TREE=>IF_ICF_TREE~INSERT_NODE directly.
    ls_icfserdesc-log_flag      = 'X'.
    ls_icfserdesc-login_process = 'L'.

    DATA lv_transport TYPE trkorr.
    lv_transport = iv_transport.

    " icfdocu is the full ICFDOCU structure here (unlike the FM's plain
    " icf_docu field) - only -icf_docu is read (name/parguid/langu are
    " overwritten by the method itself), confirmed by reading its source.
    DATA ls_icfdocu TYPE icfdocu.
    ls_icfdocu-icf_docu = iv_docu.

    CALL METHOD cl_icf_tree=>if_icf_tree~insert_node
      EXPORTING
        icf_name    = iv_name
        icfparguid  = lv_parent_guid
        icfdocu     = ls_icfdocu
        doculang    = sy-langu
        icfserdesc  = ls_icfserdesc
        icfhandlst  = lt_handlerlist
        icfactive   = 'X'
        package     = 'ZMCP'
        " Required by the signature but confirmed (by reading the method's
        " source) to be used only when package is initial - never read
        " when package is supplied, as it always is here. Any non-blank
        " value satisfies the interface without being operationally used.
        application = 'ZMCP'
      IMPORTING
        icfnodguid  = rv_node_guid
      CHANGING
        transport   = lv_transport
      EXCEPTIONS
        empty_icf_name          = 1
        no_new_virtual_host     = 2
        special_service_error   = 3
        parent_not_existing     = 4
        enqueue_error           = 5
        node_already_existing   = 6
        empty_docu              = 7
        doculang_not_installed  = 8
        security_info_error     = 9
        user_password_error     = 10
        password_encryption_error = 11
        invalid_url             = 12
        invalid_otr_concept     = 13
        formflg401_error        = 14
        handler_error           = 15
        transport_error         = 16
        tadir_error              = 17
        package_not_found        = 18
        wrong_application        = 19
        not_allow_application    = 20
        no_application           = 21
        invalid_icfparguid       = 22
        alt_name_invalid         = 23
        alternate_name_exist     = 24
        wrong_icf_name           = 25
        no_authority             = 26
        OTHERS                   = 27.

    IF sy-subrc <> 0.
      DATA(lv_reason) = SWITCH string( sy-subrc
        WHEN 1  THEN 'empty_icf_name'
        WHEN 2  THEN 'no_new_virtual_host'
        WHEN 3  THEN 'special_service_error'
        WHEN 4  THEN 'parent_not_existing'
        WHEN 5  THEN 'enqueue_error - node locked, retry'
        WHEN 6  THEN 'node_already_existing'
        WHEN 7  THEN 'empty_docu'
        WHEN 8  THEN 'doculang_not_installed'
        WHEN 9  THEN 'security_info_error'
        WHEN 10 THEN 'user_password_error'
        WHEN 11 THEN 'password_encryption_error'
        WHEN 12 THEN 'invalid_url'
        WHEN 13 THEN 'invalid_otr_concept'
        WHEN 14 THEN 'formflg401_error'
        WHEN 15 THEN 'handler_error - handler_class must exist and implement IF_HTTP_EXTENSION'
        WHEN 16 THEN 'transport_error - a valid transport is required for a transportable package'
        WHEN 17 THEN 'tadir_error'
        WHEN 18 THEN 'package_not_found'
        WHEN 19 THEN 'wrong_application'
        WHEN 20 THEN 'not_allow_application'
        WHEN 21 THEN 'no_application'
        WHEN 22 THEN 'invalid_icfparguid'
        WHEN 23 THEN 'alt_name_invalid'
        WHEN 24 THEN 'alternate_name_exist'
        WHEN 25 THEN 'wrong_icf_name'
        WHEN 26 THEN 'no_authority'
        ELSE         |unknown (sy-subrc={ sy-subrc })| ).
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'create_sicf_node'
          detail = lv_reason.
    ENDIF.

  ENDMETHOD.

  METHOD delete_node.

    DATA(lv_parent_guid) = resolve_zmcp_guid( ).

    " DELETE_NODE compares against ICFSERVICE-ICF_NAME, always upper-case
    " (same trap as the old FM-based delete_node - see git history/plan).
    DATA lv_name_upper TYPE icfname.
    lv_name_upper = iv_name.
    TRANSLATE lv_name_upper TO UPPER CASE.

    DATA lv_transport TYPE trkorr.
    lv_transport = iv_transport.

    CALL METHOD cl_icf_tree=>if_icf_tree~delete_node
      EXPORTING
        icfparguid       = lv_parent_guid
        transport        = lv_transport
        i_dark_transport = abap_true
      CHANGING
        icf_name         = lv_name_upper
      EXCEPTIONS
        no_virtual_host_delete      = 1
        special_service_error       = 2
        enqueue_error               = 3
        node_not_existing           = 4
        node_has_childs             = 5
        node_is_aliased             = 6
        node_not_in_original_system = 7
        transport_error             = 8
        tadir_error                 = 9
        db_error                    = 10
        no_authority                = 11
        OTHERS                      = 12.

    IF sy-subrc <> 0.
      DATA(lv_reason) = SWITCH string( sy-subrc
        WHEN 1  THEN 'no_virtual_host_delete'
        WHEN 2  THEN 'special_service_error'
        WHEN 3  THEN 'enqueue_error - node locked, retry'
        WHEN 4  THEN 'node_not_existing'
        WHEN 5  THEN 'node_has_childs'
        WHEN 6  THEN 'node_is_aliased'
        WHEN 7  THEN 'node_not_in_original_system'
        WHEN 8  THEN 'transport_error'
        WHEN 9  THEN 'tadir_error'
        WHEN 10 THEN 'db_error'
        WHEN 11 THEN 'no_authority'
        ELSE         |unknown (sy-subrc={ sy-subrc })| ).
      RAISE EXCEPTION TYPE zcx_mcp_dispatch
        EXPORTING
          textid = zcx_mcp_dispatch=>bad_request
          action = 'delete_sicf_node'
          detail = lv_reason.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
