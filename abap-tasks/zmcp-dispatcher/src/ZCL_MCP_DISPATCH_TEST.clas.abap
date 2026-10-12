CLASS zcl_mcp_dispatch_test DEFINITION PUBLIC FINAL CREATE PUBLIC
  FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.

  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
    METHODS ping_echoes_payload FOR TESTING.
    METHODS ping_reports_current_user FOR TESTING.
    METHODS unknown_action_raises FOR TESTING.
    METHODS unknown_action_has_the_name FOR TESTING.
    METHODS echo_upper_uppercases_payload FOR TESTING.
    METHODS ping_ok_after_new_action FOR TESTING.
    METHODS create_node_requires_fields FOR TESTING.
    METHODS delete_node_requires_name FOR TESTING.

ENDCLASS.


CLASS zcl_mcp_dispatch_test IMPLEMENTATION.

  METHOD ping_echoes_payload.

    DATA(lv_response) = zcl_mcp_dispatch=>dispatch(
      action  = 'ping'
      payload = 'hello-from-aunit' ).

    cl_abap_unit_assert=>assert_char_cp(
      act = lv_response
      exp = '*payload: hello-from-aunit*'
      msg = 'ping must echo the exact payload it was given' ).

  ENDMETHOD.


  METHOD ping_reports_current_user.

    " Independent expected value: sy-uname directly, not recomputed via
    " the dispatcher's own logic.
    DATA(lv_response) = zcl_mcp_dispatch=>dispatch(
      action  = 'ping'
      payload = '' ).

    cl_abap_unit_assert=>assert_char_cp(
      act = lv_response
      exp = |*uname: { sy-uname }*|
      msg = 'ping must report the actual calling user' ).

  ENDMETHOD.


  METHOD unknown_action_raises.

    TRY.
        zcl_mcp_dispatch=>dispatch( action = 'no_such_action' ).
        cl_abap_unit_assert=>fail(
          'expected zcx_mcp_dispatch for an unregistered action - this is the default-deny boundary' ).
      CATCH zcx_mcp_dispatch.
        " expected
    ENDTRY.

  ENDMETHOD.


  METHOD unknown_action_has_the_name.

    TRY.
        zcl_mcp_dispatch=>dispatch( action = 'no_such_action' ).
        cl_abap_unit_assert=>fail( 'expected zcx_mcp_dispatch' ).
      CATCH zcx_mcp_dispatch INTO DATA(lx).
        cl_abap_unit_assert=>assert_equals(
          act = lx->action
          exp = 'no_such_action'
          msg = 'the exception must carry the rejected action name for diagnostics' ).
    ENDTRY.

  ENDMETHOD.


  METHOD echo_upper_uppercases_payload.

    " Proves a second action, added purely by editing ZCL_MCP_DISPATCH
    " (new WHEN branch + private handler method), dispatches correctly
    " alongside the original 'ping' - no SICF/HTTP-layer change involved.
    DATA(lv_response) = zcl_mcp_dispatch=>dispatch(
      action  = 'echo_upper'
      payload = 'MixedCase Text 123' ).

    cl_abap_unit_assert=>assert_equals(
      act = lv_response
      exp = 'MIXEDCASE TEXT 123'
      msg = 'echo_upper must uppercase the exact payload it was given' ).

  ENDMETHOD.


  METHOD ping_ok_after_new_action.

    " Regression: adding echo_upper's WHEN branch must not disturb the
    " existing ping branch.
    DATA(lv_response) = zcl_mcp_dispatch=>dispatch(
      action  = 'ping'
      payload = 'still-fine' ).

    cl_abap_unit_assert=>assert_char_cp(
      act = lv_response
      exp = '*payload: still-fine*'
      msg = 'ping must still work unchanged after adding a second action' ).

  ENDMETHOD.


  METHOD create_node_requires_fields.

    " Deliberately NOT testing a real create_sicf_node call here - that
    " would create a genuine SICF node/transport entry as a side effect
    " of running the unit test suite, unlike every other write in this
    " project which rolls back with the AUnit transaction. This only
    " proves the field-validation guard rejects an incomplete payload
    " BEFORE ZCL_MCP_SICF_ADMIN (and the real HTTPTREE_INSERT_NODE FM)
    " is ever reached.
    TRY.
        zcl_mcp_dispatch=>dispatch(
          action  = 'create_sicf_node'
          payload = 'name=zzz_missing_fields' ).
        cl_abap_unit_assert=>fail(
          'expected zcx_mcp_dispatch: handler_class and docu are missing' ).
      CATCH zcx_mcp_dispatch INTO DATA(lx).
        cl_abap_unit_assert=>assert_equals(
          act = lx->action
          exp = 'create_sicf_node' ).
    ENDTRY.

  ENDMETHOD.


  METHOD delete_node_requires_name.

    " Same rationale as create_node_requires_fields: proves the guard
    " only, never reaches the real CL_ICF_TREE=>IF_ICF_TREE~DELETE_NODE
    " call.
    TRY.
        zcl_mcp_dispatch=>dispatch(
          action  = 'delete_sicf_node'
          payload = '' ).
        cl_abap_unit_assert=>fail( 'expected zcx_mcp_dispatch: name is missing' ).
      CATCH zcx_mcp_dispatch INTO DATA(lx).
        cl_abap_unit_assert=>assert_equals(
          act = lx->action
          exp = 'delete_sicf_node' ).
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
