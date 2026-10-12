************************************************************************
* ABAP Unit tests for ZCL_MCP_DYNPRO (ManageDynpro / GetCode DYNPRO).
* Read-only: they use standard SAP screens (SAPMSYST 0070, SAPLSPO1 0100)
* and only exercise the refusal paths of the write side, so nothing is
* created, changed or deleted and no transport is needed.
************************************************************************
CLASS zcl_mcp_dynpro_test DEFINITION PUBLIC FINAL CREATE PUBLIC
  FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.

  PRIVATE SECTION.
    CONSTANTS:
      c_program TYPE progname VALUE 'SAPMSYST',
      c_dynnr   TYPE dynnr    VALUE '0070'.

    METHODS list_contains_the_screen FOR TESTING.
    METHODS list_gives_every_screen_a_type FOR TESTING.
    METHODS list_unknown_program_raises FOR TESTING.
    METHODS read_returns_the_header FOR TESTING.
    METHODS read_agrees_with_list FOR TESTING.
    METHODS read_returns_flow_logic FOR TESTING.
    METHODS read_unknown_screen_raises FOR TESTING.
    METHODS read_bad_dynnr_raises FOR TESTING.
    METHODS json_round_trip_is_lossless FOR TESTING.
    METHODS json_uses_lower_case_names FOR TESTING.
    METHODS from_json_empty_raises FOR TESTING.
    METHODS write_refuses_standard_program FOR TESTING.
    METHODS write_refuses_unknown_mode FOR TESTING.
    METHODS delete_refuses_standard_prog FOR TESTING.
    METHODS check_standard_screen_is_clean FOR TESTING.

    METHODS assert_msgno
      IMPORTING
        ix_error TYPE REF TO zcx_mcp_dynpro
        iv_exp   TYPE symsgno
        iv_msg   TYPE string.

ENDCLASS.


CLASS zcl_mcp_dynpro_test IMPLEMENTATION.

  METHOD assert_msgno.
    cl_abap_unit_assert=>assert_equals(
      act = ix_error->if_t100_message~t100key-msgno
      exp = iv_exp
      msg = iv_msg ).
  ENDMETHOD.


  METHOD list_contains_the_screen.
    TRY.
        DATA(lt_screens) = zcl_mcp_dynpro=>list( c_program ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |list raised: { lx->detail }| ).
    ENDTRY.
    cl_abap_unit_assert=>assert_not_initial( act = lt_screens msg = 'SAPMSYST has screens' ).
    READ TABLE lt_screens WITH KEY dynnr = c_dynnr TRANSPORTING NO FIELDS.
    cl_abap_unit_assert=>assert_subrc( msg = 'screen 0070 must be listed' ).
  ENDMETHOD.


  METHOD list_gives_every_screen_a_type.
    TRY.
        DATA(lt_screens) = zcl_mcp_dynpro=>list( c_program ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |list raised: { lx->detail }| ).
    ENDTRY.
    " D020S stores a normal screen as blank; the external type code must
    " be N, never blank.
    LOOP AT lt_screens INTO DATA(ls_screen).
      cl_abap_unit_assert=>assert_not_initial(
        act = ls_screen-type
        msg = |screen { ls_screen-dynnr } has no type code| ).
    ENDLOOP.
  ENDMETHOD.


  METHOD list_unknown_program_raises.
    TRY.
        zcl_mcp_dynpro=>list( 'ZMCP_NO_SUCH_PROGRAM' ).
        cl_abap_unit_assert=>fail( 'an unknown program must raise' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '003' iv_msg = 'program_not_found expected' ).
    ENDTRY.
  ENDMETHOD.


  METHOD read_returns_the_header.
    TRY.
        DATA(ls_dynpro) = zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = c_dynnr ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |read raised: { lx->detail }| ).
    ENDTRY.
    cl_abap_unit_assert=>assert_equals( act = ls_dynpro-header-program exp = c_program ).
    cl_abap_unit_assert=>assert_equals( act = ls_dynpro-header-screen exp = c_dynnr ).
  ENDMETHOD.


  METHOD read_agrees_with_list.
    TRY.
        DATA(lt_screens) = zcl_mcp_dynpro=>list( c_program ).
        DATA(ls_dynpro)  = zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = c_dynnr ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |raised: { lx->detail }| ).
    ENDTRY.
    READ TABLE lt_screens INTO DATA(ls_listed) WITH KEY dynnr = c_dynnr.
    cl_abap_unit_assert=>assert_subrc( ).
    cl_abap_unit_assert=>assert_equals( act = ls_listed-type exp = ls_dynpro-header-type
      msg = 'list and read must report the same screen type' ).
    cl_abap_unit_assert=>assert_equals( act = ls_listed-description exp = ls_dynpro-header-descript
      msg = 'list and read must report the same description' ).
  ENDMETHOD.


  METHOD read_returns_flow_logic.
    TRY.
        DATA(ls_dynpro) = zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = c_dynnr ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |read raised: { lx->detail }| ).
    ENDTRY.
    cl_abap_unit_assert=>assert_not_initial( act = ls_dynpro-flow_logic
      msg = 'a dialog screen has flow logic (PROCESS BEFORE OUTPUT ...)' ).
  ENDMETHOD.


  METHOD read_unknown_screen_raises.
    TRY.
        zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = '9999' ).
        cl_abap_unit_assert=>fail( 'an unknown screen must raise' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '004' iv_msg = 'screen_not_found expected' ).
    ENDTRY.
  ENDMETHOD.


  METHOD read_bad_dynnr_raises.
    TRY.
        zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = 'ABCD' ).
        cl_abap_unit_assert=>fail( 'a non-numeric screen number must raise' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '001' iv_msg = 'bad_request expected' ).
    ENDTRY.
  ENDMETHOD.


  METHOD json_round_trip_is_lossless.
    TRY.
        DATA(ls_dynpro) = zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = c_dynnr ).
        DATA(ls_back)   = zcl_mcp_dynpro=>from_json( zcl_mcp_dynpro=>to_json( ls_dynpro ) ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |raised: { lx->detail }| ).
    ENDTRY.
    " The JSON of a read must go back into RPY_DYNPRO_INSERT unchanged.
    cl_abap_unit_assert=>assert_equals( act = ls_back exp = ls_dynpro
      msg = 'to_json then from_json must give back the same screen' ).
  ENDMETHOD.


  METHOD json_uses_lower_case_names.
    TRY.
        DATA(ls_dynpro) = zcl_mcp_dynpro=>read( iv_program = c_program iv_dynnr = c_dynnr ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |read raised: { lx->detail }| ).
    ENDTRY.
    DATA(lv_json) = zcl_mcp_dynpro=>to_json( ls_dynpro ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json exp = '*"header"*"flow_logic"*'
      msg = 'component names must be lower case' ).
  ENDMETHOD.


  METHOD from_json_empty_raises.
    TRY.
        zcl_mcp_dynpro=>from_json( `` ).
        cl_abap_unit_assert=>fail( 'an empty body must raise' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '001' iv_msg = 'bad_request expected' ).
    ENDTRY.
  ENDMETHOD.


  METHOD write_refuses_standard_program.
    " Customer-program check comes before anything is touched.
    TRY.
        zcl_mcp_dynpro=>write(
          iv_program = c_program
          iv_dynnr   = '9998'
          is_dynpro  = VALUE #( )
          iv_mode    = `CREATE` ).
        cl_abap_unit_assert=>fail( 'writing into a standard program must be refused' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '007' iv_msg = 'not_supported expected' ).
    ENDTRY.
    SELECT SINGLE dnum FROM d020s WHERE prog = @c_program AND dnum = '9998' INTO @DATA(lv_dnum).
    cl_abap_unit_assert=>assert_subrc( exp = 4 msg = 'no screen may have been created' ).
  ENDMETHOD.


  METHOD write_refuses_unknown_mode.
    TRY.
        zcl_mcp_dynpro=>write(
          iv_program = c_program
          iv_dynnr   = '9998'
          is_dynpro  = VALUE #( )
          iv_mode    = `UPSERT` ).
        cl_abap_unit_assert=>fail( 'an unknown mode must be refused' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '001' iv_msg = 'bad_request expected' ).
    ENDTRY.
  ENDMETHOD.


  METHOD delete_refuses_standard_prog.
    TRY.
        zcl_mcp_dynpro=>delete( iv_program = c_program iv_dynnr = c_dynnr ).
        cl_abap_unit_assert=>fail( 'deleting a standard screen must be refused' ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        assert_msgno( ix_error = lx iv_exp = '007' iv_msg = 'not_supported expected' ).
    ENDTRY.
    SELECT SINGLE dnum FROM d020s WHERE prog = @c_program AND dnum = @c_dynnr INTO @DATA(lv_dnum).
    cl_abap_unit_assert=>assert_subrc( msg = 'the standard screen must still exist' ).
  ENDMETHOD.


  METHOD check_standard_screen_is_clean.
    " SAPLSPO1 0100 (popup) is documented as 0 findings in ZCL_MCP_DYNPRO=>check.
    TRY.
        zcl_mcp_dynpro=>check(
          EXPORTING iv_program = 'SAPLSPO1' iv_dynnr = '0100'
          IMPORTING ev_errors  = DATA(lv_errors) ev_warnings = DATA(lv_warnings) ).
      CATCH zcx_mcp_dynpro INTO DATA(lx).
        cl_abap_unit_assert=>fail( |check raised: { lx->detail }| ).
    ENDTRY.
    cl_abap_unit_assert=>assert_initial( act = lv_errors msg = 'a standard screen must have no runtime-fatal findings' ).
    cl_abap_unit_assert=>assert_initial( act = lv_warnings msg = 'a standard screen must have no warnings' ).
  ENDMETHOD.

ENDCLASS.
