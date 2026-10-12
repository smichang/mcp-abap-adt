************************************************************************
* Program Type : Class
* Description  : Classic Dynpro (screen) read/write for the ManageDynpro
*                MCP bridge. Wraps RPY_DYNPRO_READ / RPY_DYNPRO_INSERT /
*                RS_SCRP_DELETE - standard ADT has no
*                REST contract for classic screen content (see
*               ).
* Author       : MCP
* Created Date : 2026/10/02
* Modifications:
************************************************************************
* Date        Author      RequestNo   Description
* ---------   ---------   ----------  ----------------------------------
* 2026/10/02  MCP                    Initial version (read phase)
* 2026/10/02  MCP                    Write phase: write/delete/from_json
* 2026/10/02  MCP                    check() (SE51 consistency check) + next-screen retarget
* 2026/10/02  MCP                    only screen types N/I/M writable
************************************************************************
CLASS zcl_mcp_dynpro DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    " One screen in its external (RPY_*) format - the same shape
    " RPY_DYNPRO_INSERT takes, so a read result can be written back.
    TYPES:
      BEGIN OF ty_dynpro,
        header               TYPE rpy_dyhead,
        containers           TYPE dycatt_tab,
        fields_to_containers TYPE dyfatc_tab,
        flow_logic           TYPE STANDARD TABLE OF rpy_dyflow WITH DEFAULT KEY,
        params               TYPE STANDARD TABLE OF rpy_dypara WITH DEFAULT KEY,
      END OF ty_dynpro,
      BEGIN OF ty_screen,
        dynnr       TYPE dynnr,
        type        TYPE scrhtyp,
        description TYPE scrhdtxt,
      END OF ty_screen,
      ty_screens TYPE STANDARD TABLE OF ty_screen WITH DEFAULT KEY.

    "! Lists all screens of a program, with the external type code from
    "! RPY_DYHEAD-TYPE: N normal, I subscreen, M modal dialog box,
    "! S selection screen, J selection screen defined AS SUBSCREEN
    "!. W = selection screen as modal dialog
    "! per domain SCRPTYP.
    CLASS-METHODS list
      IMPORTING
        iv_program        TYPE progname
      RETURNING
        VALUE(rt_screens) TYPE ty_screens
      RAISING
        zcx_mcp_dynpro.

    "! Reads one screen completely (header, elements, flow logic).
    CLASS-METHODS read
      IMPORTING
        iv_program      TYPE progname
        iv_dynnr        TYPE dynnr
      RETURNING
        VALUE(rs_dynpro) TYPE ty_dynpro
      RAISING
        zcx_mcp_dynpro.

    "! JSON helpers - lower-case DDIC component names, so the same JSON
    "! deserializes back into ty_dynpro unchanged (write phase).
    CLASS-METHODS to_json
      IMPORTING
        ia_data        TYPE any
      RETURNING
        VALUE(rv_json) TYPE string.

    "20261002 MCP write phase - begin
    CLASS-METHODS from_json
      IMPORTING
        iv_json          TYPE string
      RETURNING
        VALUE(rs_dynpro) TYPE ty_dynpro
      RAISING
        zcx_mcp_dynpro.

    "! Creates (iv_mode = CREATE) or overwrites (UPDATE) one screen and
    "! generates it (active immediately - no separate activation step).
    "! On any failure the LUW is rolled back, so a broken definition never
    "! replaces the active screen. Non-$TMP programs need iv_trkorr (a
    "! request or one of its tasks); the LIMU DYNP entry lands in the
    "! caller's task of that request.
    CLASS-METHODS write
      IMPORTING
        iv_program     TYPE progname
        iv_dynnr       TYPE dynnr
        is_dynpro      TYPE ty_dynpro
        iv_mode        TYPE string
        iv_trkorr      TYPE trkorr OPTIONAL
      RETURNING
        VALUE(rv_info) TYPE string
      RAISING
        zcx_mcp_dynpro.

    "! Deletes one screen (RS_SCRP_DELETE, headless) and commits.
    CLASS-METHODS delete
      IMPORTING
        iv_program     TYPE progname
        iv_dynnr       TYPE dynnr
        iv_trkorr      TYPE trkorr OPTIONAL
      RETURNING
        VALUE(rv_info) TYPE string
      RAISING
        zcx_mcp_dynpro.
    "! SE51's consistency check (RS_SCRP_CONS_CHECK_TODO_SINGLE) for one
    "! saved screen. ev_errors = findings that fail at runtime (missing
    "! MODULE, missing CALL SUBSCREEN, element without variable, ...);
    "! ev_warnings = the rest. NOTE: the SAP check commits implicitly - only
    "! call it when nothing uncommitted may still be rolled back.
    CLASS-METHODS check
      IMPORTING
        iv_program  TYPE progname
        iv_dynnr    TYPE dynnr
      EXPORTING
        ev_errors   TYPE string
        ev_warnings TYPE string
      RAISING
        zcx_mcp_dynpro.
    "20261002 MCP write phase - end

  PRIVATE SECTION.
    "20261002 MCP write phase - check_program takes the activity and
    "returns the package; new helpers for write/delete
    CLASS-METHODS check_program
      IMPORTING
        iv_program         TYPE progname
        iv_actvt           TYPE activ_auth DEFAULT '03'
      RETURNING
        VALUE(rv_devclass) TYPE devclass
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS check_dynnr
      IMPORTING
        iv_program TYPE progname
        iv_dynnr   TYPE dynnr
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS check_customer_program
      IMPORTING
        iv_program TYPE progname
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS current_type
      IMPORTING
        iv_program     TYPE progname
        iv_dynnr       TYPE dynnr
      RETURNING
        VALUE(rv_type) TYPE scrhtyp.

    CLASS-METHODS resolve_request
      IMPORTING
        iv_program        TYPE progname
        iv_devclass       TYPE devclass
        iv_trkorr         TYPE trkorr
      RETURNING
        VALUE(rv_request) TYPE trkorr
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS check_same_request
      IMPORTING
        iv_program TYPE progname
        iv_dynnr   TYPE dynnr
        iv_request TYPE trkorr
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS describe_recording
      IMPORTING
        iv_program     TYPE progname
        iv_dynnr       TYPE dynnr
        iv_devclass    TYPE devclass
      RETURNING
        VALUE(rv_text) TYPE string.

    "20261002 MCP one RPY_DYNPRO_INSERT call, never commits
    CLASS-METHODS insert
      IMPORTING
        is_dynpro            TYPE ty_dynpro
        iv_suppress_exist    TYPE abap_bool
        iv_suppress_generate TYPE abap_bool
        iv_request           TYPE trkorr
      EXPORTING
        ev_rc                TYPE sysubrc
        ev_msg               TYPE string.

    "20261002 MCP own pre-write check: SAP's #145 finding proved
    "unreliable right after a screen is created in the same session
    CLASS-METHODS check_subscreen_calls
      IMPORTING
        iv_program TYPE progname
        iv_dynnr   TYPE dynnr
        is_dynpro  TYPE ty_dynpro
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS last_message
      RETURNING
        VALUE(rv_text) TYPE string.

ENDCLASS.


CLASS zcl_mcp_dynpro IMPLEMENTATION.

  METHOD check_program.
    IF iv_program IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = `program is required`.
    ENDIF.

    SELECT SINGLE name FROM trdir WHERE name = @iv_program INTO @DATA(lv_name) ##NEEDED.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>program_not_found
          program = CONV #( iv_program ).
    ENDIF.

    "20261002 MCP write phase - package also for function group main
    "programs (SAPL<group> is registered as R3TR FUGR <group>, not PROG)
    SELECT SINGLE devclass FROM tadir
      WHERE pgmid = 'R3TR' AND object = 'PROG' AND obj_name = @iv_program
      INTO @rv_devclass.
    IF sy-subrc <> 0 AND iv_program CP 'SAPL*'.
      DATA(lv_fugr) = CONV sobj_name( iv_program+4 ).
      SELECT SINGLE devclass FROM tadir
        WHERE pgmid = 'R3TR' AND object = 'FUGR' AND obj_name = @lv_fugr
        INTO @rv_devclass.
      IF sy-subrc <> 0.
        CLEAR rv_devclass.   " not in TADIR - authority check below decides
      ENDIF.
    ENDIF.

    AUTHORITY-CHECK OBJECT 'S_DEVELOP'
      ID 'DEVCLASS' FIELD rv_devclass
      ID 'OBJTYPE'  FIELD 'PROG'
      ID 'OBJNAME'  FIELD iv_program
      ID 'P_GROUP'  DUMMY
      ID 'ACTVT'    FIELD iv_actvt.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>permission_denied
          program = CONV #( iv_program ).
    ENDIF.
  ENDMETHOD.


  METHOD list.
    check_program( iv_program ).

    SELECT dnum FROM d020s
      WHERE prog = @iv_program
      ORDER BY dnum
      INTO TABLE @DATA(lt_dnum).
    IF sy-subrc <> 0.
      RETURN.   " program without screens - empty list, not an error
    ENDIF.

    " D020S-TYPE stores blank for a normal screen, which RPY_DYNPRO_READ
    " reports as 'N'. Read the external header per screen so list() and
    " read() always report the same type code and description.
    LOOP AT lt_dnum INTO DATA(ls_dnum).
      DATA ls_header TYPE rpy_dyhead.
      CLEAR ls_header.
      CALL FUNCTION 'RPY_DYNPRO_READ'
        EXPORTING
          progname         = iv_program
          dynnr            = ls_dnum-dnum
        IMPORTING
          header           = ls_header
        EXCEPTIONS
          cancelled        = 1
          not_found        = 2
          permission_error = 3
          OTHERS           = 4.
      IF sy-subrc <> 0.
        " still list it, so the caller sees the screen exists
        APPEND VALUE #( dynnr = ls_dnum-dnum description = |(header read failed, rc={ sy-subrc })| )
          TO rt_screens.
        CONTINUE.
      ENDIF.
      APPEND VALUE #( dynnr       = ls_dnum-dnum
                      type        = ls_header-type
                      description = ls_header-descript ) TO rt_screens.
    ENDLOOP.
  ENDMETHOD.


  METHOD read.
    check_program( iv_program ).
    check_dynnr( iv_program = iv_program iv_dynnr = iv_dynnr ).

    CALL FUNCTION 'RPY_DYNPRO_READ'
      EXPORTING
        progname             = iv_program
        dynnr                = iv_dynnr
      IMPORTING
        header               = rs_dynpro-header
      TABLES
        containers           = rs_dynpro-containers
        fields_to_containers = rs_dynpro-fields_to_containers
        flow_logic           = rs_dynpro-flow_logic
        params               = rs_dynpro-params
      EXCEPTIONS
        cancelled            = 1
        not_found            = 2
        permission_error     = 3
        OTHERS               = 4.
    CASE sy-subrc.
      WHEN 0.
        RETURN.
      WHEN 2.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>screen_not_found
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr ).
      WHEN 3.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>permission_denied
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr ).
      WHEN OTHERS.
        DATA(lv_rc) = sy-subrc.
        DATA(lv_msg) = last_message( ).
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>read_failed
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |RPY_DYNPRO_READ rc={ lv_rc } { lv_msg }|.
    ENDCASE.
  ENDMETHOD.


  METHOD to_json.
    rv_json = /ui2/cl_json=>serialize( data        = ia_data
                                       pretty_name = /ui2/cl_json=>pretty_mode-low_case ).
  ENDMETHOD.

  METHOD from_json.
    "20261002 MCP write phase - new method
    IF iv_json IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = `request body (screen definition JSON) is empty`.
    ENDIF.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json        = iv_json
                                             pretty_name = /ui2/cl_json=>pretty_mode-low_case
                                   CHANGING  data        = rs_dynpro ).
      CATCH cx_sy_conversion_error cx_sy_move_cast_error INTO DATA(lx_conv).
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid   = zcx_mcp_dynpro=>bad_request
            previous = lx_conv
            detail   = |invalid screen definition JSON: { lx_conv->get_text( ) }|.
    ENDTRY.
  ENDMETHOD.


  METHOD write.
    DATA(lv_mode) = to_upper( iv_mode ).
    IF lv_mode <> `CREATE` AND lv_mode <> `UPDATE`.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = |mode must be create or update, got "{ iv_mode }"|.
    ENDIF.

    check_customer_program( iv_program ).
    DATA(lv_devclass) = check_program( iv_program = iv_program iv_actvt = '02' ).
    check_dynnr( iv_program = iv_program iv_dynnr = iv_dynnr ).

    SELECT SINGLE dnum FROM d020s
      WHERE prog = @iv_program AND dnum = @iv_dynnr
      INTO @DATA(lv_dnum) ##NEEDED.
    DATA(lv_exists) = xsdbool( sy-subrc = 0 ).
    IF lv_mode = `CREATE` AND lv_exists = abap_true.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>already_exists
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr ).
    ELSEIF lv_mode = `UPDATE` AND lv_exists = abap_false.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>screen_not_found
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr ).
    ENDIF.

    DATA(ls_dynpro) = is_dynpro.
    " Target always wins over whatever the JSON header says - this is what
    " lets a definition read from one program be written to another.
    ls_dynpro-header-program = iv_program.
    ls_dynpro-header-screen  = iv_dynnr.
    "20261002 MCP a screen copied from another number keeps pointing to
    "itself as next screen - retarget that self-reference to the new number
    IF is_dynpro-header-nextscreen IS NOT INITIAL
       AND is_dynpro-header-nextscreen = is_dynpro-header-screen.
      ls_dynpro-header-nextscreen = iv_dynnr.
    ENDIF.
    IF ls_dynpro-header-language IS INITIAL.
      SELECT SINGLE masterlang FROM tadir
        WHERE pgmid = 'R3TR' AND object = 'PROG' AND obj_name = @iv_program
        INTO @ls_dynpro-header-language.
      IF sy-subrc <> 0.
        ls_dynpro-header-language = sy-langu.
      ENDIF.
    ENDIF.

    " Selection screens (S/J/W) are generated from SELECTION-SCREEN
    " statements in the program source - an edit here would be overwritten
    " by the next program generation.
    DATA(lv_old_type) = COND scrhtyp( WHEN lv_exists = abap_true
                                      THEN current_type( iv_program = iv_program iv_dynnr = iv_dynnr ) ).
    IF ls_dynpro-header-type CA 'SJW' OR ( lv_old_type IS NOT INITIAL AND lv_old_type CA 'SJW' ).
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>not_supported
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `selection screens are generated from SELECTION-SCREEN statements - change the program source instead`.
    ENDIF.
    "20261002 MCP any other unknown code (e.g. '1') was
    "saved and generated - only normal / subscreen / modal are writable
    IF ls_dynpro-header-type IS INITIAL.
      ls_dynpro-header-type = 'N'.
    ELSEIF ls_dynpro-header-type NA 'NIM'.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>bad_request
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = |screen type "{ ls_dynpro-header-type }" is not valid - use N (normal), I (subscreen) or M (modal dialog box)|.
    ENDIF.
    IF ls_dynpro-flow_logic IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>bad_request
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `flow_logic is empty - at least PROCESS BEFORE OUTPUT / PROCESS AFTER INPUT are required`.
    ENDIF.

    check_subscreen_calls( iv_program = iv_program iv_dynnr = iv_dynnr is_dynpro = ls_dynpro ).

    DATA(lv_request) = resolve_request( iv_program  = iv_program
                                        iv_devclass = lv_devclass
                                        iv_trkorr   = iv_trkorr ).
    check_same_request( iv_program = iv_program iv_dynnr = iv_dynnr iv_request = lv_request ).

    " Verified:
    " - the FM locks (RS_ACCESS_PERMISSION) and records LIMU DYNP
    "   (RS_CORR_INSERT) itself; with USE_CORRNUM_IMMEDIATEDLY = ' ' and a
    "   request number the entry lands in the caller's task;
    " - a generation error still saves the broken screen as inactive unless
    "   the commit is suppressed and the LUW rolled back;
    " - RS_SCRP_CONS_CHECK_TODO_SINGLE commits implicitly, so the
    "   consistency check can't run before the decision to keep the write -
    "   callers run check( ) after write( ) instead.
    insert( EXPORTING is_dynpro            = ls_dynpro
                      iv_suppress_exist    = xsdbool( lv_mode = `UPDATE` )
                      iv_suppress_generate = abap_false
                      iv_request           = lv_request
            IMPORTING ev_rc                = DATA(lv_rc)
                      ev_msg               = DATA(lv_msg) ).
    IF lv_rc = 0.
      COMMIT WORK.
      rv_info = |Screen { iv_program } { iv_dynnr } { COND string( WHEN lv_mode = `CREATE` THEN `created` ELSE `updated` ) }| &&
                | and generated (active). { describe_recording( iv_program  = iv_program
                                                                iv_dynnr    = iv_dynnr
                                                                iv_devclass = lv_devclass ) }|.
      RETURN.
    ENDIF.

    ROLLBACK WORK.
    CASE lv_rc.
      WHEN 1.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>transport_invalid
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |SAP cancelled the transport recording for request "{ lv_request }" | &&
                      |(missing, not modifiable, or the screen is locked in another request). { lv_msg }|.
      WHEN 2.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>already_exists
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr ).
      WHEN 3.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>program_not_found
            program = CONV #( iv_program ).
      WHEN 4.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>conflict
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |not executed (lock or permission): { lv_msg }|.
      WHEN 8.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>write_failed
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |screen generation failed, nothing saved (only the first error is reported): { lv_msg }|.
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>write_failed
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |element definition rejected (RPY_DYNPRO_INSERT rc={ lv_rc }), nothing saved: { lv_msg }|.
    ENDCASE.
  ENDMETHOD.


  METHOD delete.
    check_customer_program( iv_program ).
    DATA(lv_devclass) = check_program( iv_program = iv_program iv_actvt = '06' ).
    check_dynnr( iv_program = iv_program iv_dynnr = iv_dynnr ).

    SELECT SINGLE dnum FROM d020s
      WHERE prog = @iv_program AND dnum = @iv_dynnr
      INTO @DATA(lv_dnum) ##NEEDED.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>screen_not_found
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr ).
    ENDIF.
    IF current_type( iv_program = iv_program iv_dynnr = iv_dynnr ) CA 'SJW'.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>not_supported
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `selection screens are generated from SELECTION-SCREEN statements - remove them in the program source instead`.
    ENDIF.

    DATA(lv_request) = resolve_request( iv_program  = iv_program
                                        iv_devclass = lv_devclass
                                        iv_trkorr   = iv_trkorr ).
    check_same_request( iv_program = iv_program iv_dynnr = iv_dynnr iv_request = lv_request ).

    " WITH_POPUP = ' ': no confirmation dialog (none possible over HTTP).
    " RS_SCRP_DELETE never commits by itself (verified).
    CLEAR sy-msgid.
    CALL FUNCTION 'RS_SCRP_DELETE'
      EXPORTING
        dynnr                  = iv_dynnr
        progname               = iv_program
        with_popup             = ' '
      CHANGING
        corrnum                = lv_request
      EXCEPTIONS
        enqueued_by_user       = 1
        enqueue_system_failure = 2
        not_executed           = 3
        not_exists             = 4
        no_modify_permission   = 5
        popup_canceled         = 6
        OTHERS                 = 7.
    DATA(lv_rc)  = sy-subrc.
    DATA(lv_msg) = last_message( ).

    IF lv_rc = 0.
      COMMIT WORK.
      SELECT SINGLE dnum FROM d020s
        WHERE prog = @iv_program AND dnum = @iv_dynnr
        INTO @lv_dnum.
      IF sy-subrc = 0.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>write_failed
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |RS_SCRP_DELETE reported success but the screen still exists. { lv_msg }|.
      ENDIF.
      rv_info = |Screen { iv_program } { iv_dynnr } deleted. { describe_recording( iv_program  = iv_program
                                                                                  iv_dynnr    = iv_dynnr
                                                                                  iv_devclass = lv_devclass ) }|.
      RETURN.
    ENDIF.

    ROLLBACK WORK.
    CASE lv_rc.
      WHEN 1 OR 2.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>conflict
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |screen is locked: { lv_msg }|.
      WHEN 4.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>screen_not_found
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr ).
      WHEN 5.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>permission_denied
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr ).
      WHEN 6.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>transport_invalid
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |SAP cancelled the transport recording for request "{ lv_request }". { lv_msg }|.
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>write_failed
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |RS_SCRP_DELETE rc={ lv_rc }: { lv_msg }|.
    ENDCASE.
  ENDMETHOD.


  METHOD check_dynnr.
    IF iv_dynnr IS INITIAL OR iv_dynnr CN '0123456789'.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>bad_request
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `dynnr must be 4 digits`.
    ENDIF.
  ENDMETHOD.


  METHOD check_customer_program.
    " Writes are limited to customer programs: changing an SAP screen is a
    " modification (SSCR key, modification assistant) - out of scope.
    IF NOT ( iv_program CP 'Z*' OR iv_program CP 'Y*'
          OR iv_program CP 'SAPLZ*' OR iv_program CP 'SAPLY*' ).
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>not_supported
          program = CONV #( iv_program )
          detail  = `screens can only be changed in customer programs (Z*, Y*, SAPLZ*, SAPLY*)`.
    ENDIF.
  ENDMETHOD.


  METHOD current_type.
    DATA ls_header TYPE rpy_dyhead.
    CALL FUNCTION 'RPY_DYNPRO_READ'
      EXPORTING
        progname         = iv_program
        dynnr            = iv_dynnr
      IMPORTING
        header           = ls_header
      EXCEPTIONS
        cancelled        = 1
        not_found        = 2
        permission_error = 3
        OTHERS           = 4.
    IF sy-subrc = 0.
      rv_type = ls_header-type.
    ENDIF.   " unreadable -> blank; the insert itself will then decide
  ENDMETHOD.


  METHOD resolve_request.
    " Local ($...) packages are never recorded.
    IF iv_devclass IS NOT INITIAL AND iv_devclass(1) = '$'.
      RETURN.
    ENDIF.
    IF iv_trkorr IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>transport_invalid
          program = CONV #( iv_program )
          detail  = |transport_number is required - package { iv_devclass } is transportable|.
    ENDIF.

    SELECT SINGLE trkorr, trfunction, trstatus, strkorr FROM e070
      WHERE trkorr = @iv_trkorr
      INTO @DATA(ls_e070).
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>transport_invalid
          program = CONV #( iv_program )
          detail  = |transport { iv_trkorr } does not exist|.
    ENDIF.
    " RPY_DYNPRO_INSERT cancels on a task number - use its request.
    IF ls_e070-strkorr IS NOT INITIAL.
      SELECT SINGLE trkorr, trfunction, trstatus, strkorr FROM e070
        WHERE trkorr = @ls_e070-strkorr
        INTO @ls_e070.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>transport_invalid
            program = CONV #( iv_program )
            detail  = |parent request of task { iv_trkorr } not found|.
      ENDIF.
    ENDIF.
    IF ls_e070-trfunction <> 'K'.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>transport_invalid
          program = CONV #( iv_program )
          detail  = |{ ls_e070-trkorr } is not a workbench request (type { ls_e070-trfunction })|.
    ENDIF.
    IF ls_e070-trstatus <> 'D' AND ls_e070-trstatus <> 'L'.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>transport_invalid
          program = CONV #( iv_program )
          detail  = |{ ls_e070-trkorr } is not modifiable (status { ls_e070-trstatus })|.
    ENDIF.
    rv_request = ls_e070-trkorr.
  ENDMETHOD.


  METHOD check_same_request.
    " Verified: when the screen (LIMU DYNP) or its program
    " (R3TR PROG) is already locked in another open request, SAP keeps it
    " there and silently ignores the request passed in. Refuse instead, as
    " WriteProgram does, so the caller never believes it used request X.
    IF iv_request IS INITIAL.
      RETURN.
    ENDIF.
    DATA lv_dynp_key TYPE e071-obj_name.
    lv_dynp_key = |{ iv_program WIDTH = 40 }{ iv_dynnr }|.
    SELECT e071~trkorr, e070~strkorr
      FROM e071 INNER JOIN e070 ON e070~trkorr = e071~trkorr
      WHERE ( ( e071~pgmid = 'LIMU' AND e071~object = 'DYNP' AND e071~obj_name = @lv_dynp_key )
           OR ( e071~pgmid = 'R3TR' AND e071~object = 'PROG' AND e071~obj_name = @iv_program ) )
        AND e070~trstatus IN ('D','L')
      ORDER BY e071~trkorr
      INTO TABLE @DATA(lt_rec).
    IF sy-subrc <> 0.
      RETURN.   " not recorded anywhere yet - the given request will be used
    ENDIF.
    LOOP AT lt_rec INTO DATA(ls_rec).
      DATA(lv_req) = COND trkorr( WHEN ls_rec-strkorr IS INITIAL THEN ls_rec-trkorr ELSE ls_rec-strkorr ).
      IF lv_req <> iv_request.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>conflict
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |already recorded in open request { lv_req } (entry { ls_rec-trkorr }) - | &&
                      |use that transport, or release/merge it first; nothing was changed|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD describe_recording.
    IF iv_devclass IS NOT INITIAL AND iv_devclass(1) = '$'.
      rv_text = |Local object (package { iv_devclass }), no transport.|.
      RETURN.
    ENDIF.
    DATA lv_dynp_key TYPE e071-obj_name.
    lv_dynp_key = |{ iv_program WIDTH = 40 }{ iv_dynnr }|.
    " Open requests/tasks only (D modifiable, L protected).
    SELECT e071~trkorr, e071~pgmid, e071~object, e070~strkorr
      FROM e071 INNER JOIN e070 ON e070~trkorr = e071~trkorr
      WHERE ( ( e071~pgmid = 'LIMU' AND e071~object = 'DYNP' AND e071~obj_name = @lv_dynp_key )
           OR ( e071~pgmid = 'R3TR' AND e071~object = 'PROG' AND e071~obj_name = @iv_program ) )
        AND e070~trstatus IN ('D','L')
      ORDER BY e071~trkorr
      INTO TABLE @DATA(lt_rec).
    IF sy-subrc <> 0.
      rv_text = `Not found in any open transport.`.
      RETURN.
    ENDIF.
    LOOP AT lt_rec INTO DATA(ls_rec).
      DATA(lv_where) = COND string( WHEN ls_rec-strkorr IS INITIAL
                                    THEN |request { ls_rec-trkorr }|
                                    ELSE |task { ls_rec-trkorr } (request { ls_rec-strkorr })| ).
      rv_text = |{ rv_text }{ COND string( WHEN rv_text IS NOT INITIAL THEN `; ` ) }| &&
                |{ ls_rec-pgmid } { ls_rec-object } in { lv_where }|.
    ENDLOOP.
    rv_text = |Transport: { rv_text }.|.
  ENDMETHOD.


  METHOD insert.
    " The FM's TYPE C parameters reject an inline xsdbool( ) expression at
    " runtime (CX_SY_DYN_CALL_ILLEGAL_TYPE) - pass plain CHAR1 variables.
    DATA lv_suppress_exist    TYPE c LENGTH 1.
    DATA lv_suppress_generate TYPE c LENGTH 1.
    DATA(ls_dynpro) = is_dynpro.
    lv_suppress_exist    = iv_suppress_exist.
    lv_suppress_generate = iv_suppress_generate.
    CLEAR sy-msgid.
    CALL FUNCTION 'RPY_DYNPRO_INSERT'
      EXPORTING
        header                   = ls_dynpro-header
        suppress_exist_checks    = lv_suppress_exist
        suppress_generate        = lv_suppress_generate
        corrnum                  = iv_request
        use_corrnum_immediatedly = ' '
        suppress_commit_work     = 'X'
      TABLES
        containers               = ls_dynpro-containers
        fields_to_containers     = ls_dynpro-fields_to_containers
        flow_logic               = ls_dynpro-flow_logic
        params                   = ls_dynpro-params
      EXCEPTIONS
        cancelled                = 1
        already_exists           = 2
        program_not_exists       = 3
        not_executed             = 4
        missing_required_field   = 5
        illegal_field_value      = 6
        field_not_allowed        = 7
        not_generated            = 8
        illegal_field_position   = 9
        OTHERS                   = 10.
    ev_rc  = sy-subrc.
    ev_msg = last_message( ).
  ENDMETHOD.


  METHOD check.
    " RS_SCRP_CONS_CHECK_TODO_SINGLE = SE51's consistency check for one
    " screen (dialog-free). It commits implicitly (verified:
    " a rolled-back insert survived a check in between). Finding number =
    " 100 + pointer; texts
    " are text symbols 1nn of SAPLSEUZ (read in the logon language).
    " Verified: 0 findings on SE51-maintained screens and
    " SAPLSPO1 0100; missing MODULE = 102, missing CALL SUBSCREEN = 145,
    " non-existent next screen = 101.
    " Errors = would fail at runtime; everything else is a warning
    " (e.g. 101: the next screen may simply be created afterwards).
    CONSTANTS lc_blocking TYPE string VALUE `102 103 104 112 116 117 121 123 145`.
    DATA lt_find TYPE STANDARD TABLE OF rsfindlst.
    DATA lt_text TYPE STANDARD TABLE OF textpool.

    CLEAR: ev_errors, ev_warnings.
    check_program( iv_program ).
    check_dynnr( iv_program = iv_program iv_dynnr = iv_dynnr ).
    CALL FUNCTION 'RS_SCRP_CONS_CHECK_TODO_SINGLE'
      EXPORTING
        progname         = iv_program
        dynnr            = iv_dynnr
      TABLES
        findlst          = lt_find
      EXCEPTIONS
        impossible       = 1
        not_found        = 2
        selection_screen = 3
        OTHERS           = 4.
    IF sy-subrc <> 0.
      " Blocking: a check that could not run must never pass silently.
      ev_errors = |\n  consistency check could not run (RS_SCRP_CONS_CHECK_TODO_SINGLE rc={ sy-subrc }) { last_message( ) }|.
      RETURN.
    ENDIF.
    IF lt_find IS INITIAL.
      RETURN.
    ENDIF.

    READ TEXTPOOL 'SAPLSEUZ' INTO lt_text LANGUAGE sy-langu.
    IF sy-subrc <> 0.
      READ TEXTPOOL 'SAPLSEUZ' INTO lt_text LANGUAGE 'E'.
      IF sy-subrc <> 0.
        CLEAR lt_text.   " codes are still reported, just without text
      ENDIF.
    ENDIF.

    LOOP AT lt_find INTO DATA(ls_find).
      DATA(lv_code) = CONV string( 100 + CONV i( ls_find-pointer ) ).
      DATA(lv_text) = VALUE textpool-entry( lt_text[ id = 'I' key = lv_code ]-entry OPTIONAL ).
      DATA(lv_where) = COND string( WHEN ls_find-object_cls = 'CPSL' THEN | (flow logic line { CONV i( ls_find-object_row ) })|
                                    WHEN ls_find-object_cls = 'CPSF' THEN ` (element list)`
                                    WHEN ls_find-object_cls = 'CPSA' THEN ` (attributes)` ).
      DATA(lv_line) = |\n  #{ lv_code } { condense( CONV string( lv_text ) ) }: { condense( CONV string( ls_find-used_obj ) ) }{ lv_where }|.
      IF lc_blocking CS lv_code.
        ev_errors = ev_errors && lv_line.
      ELSE.
        ev_warnings = ev_warnings && lv_line.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD check_subscreen_calls.
    " Every subscreen area must be called in PBO (CALL SUBSCREEN area
    " INCLUDING prog dynnr) and in PAI (CALL SUBSCREEN area), otherwise the
    " screen fails at runtime (SE51 finding #145). Checked here, before
    " anything is written, because SAP's own check commits implicitly and
    " missed #145 for a screen created earlier in the same session.
    DATA lt_areas TYPE STANDARD TABLE OF rpy_dycatt-name WITH DEFAULT KEY.
    LOOP AT is_dynpro-containers INTO DATA(ls_cont) WHERE type = 'SUBSCREEN'.
      APPEND to_upper( ls_cont-name ) TO lt_areas.
    ENDLOOP.
    IF lt_areas IS INITIAL.
      RETURN.
    ENDIF.

    " Flow logic -> one string per event block, comments removed.
    DATA: lv_event TYPE string,
          lv_pbo   TYPE string,
          lv_pai   TYPE string.
    LOOP AT is_dynpro-flow_logic INTO DATA(ls_flow).
      DATA(lv_line) = to_upper( CONV string( ls_flow-line ) ).
      IF lv_line IS INITIAL OR lv_line(1) = '*'.
        CONTINUE.
      ENDIF.
      FIND FIRST OCCURRENCE OF '"' IN lv_line MATCH OFFSET DATA(lv_off).
      IF sy-subrc = 0.
        lv_line = substring( val = lv_line len = lv_off ).
      ENDIF.
      CONDENSE lv_line.
      IF lv_line CP 'PROCESS BEFORE OUTPUT*'.
        lv_event = `PBO`. CONTINUE.
      ELSEIF lv_line CP 'PROCESS AFTER INPUT*'.
        lv_event = `PAI`. CONTINUE.
      ELSEIF lv_line CP 'PROCESS ON *'.
        lv_event = `OTHER`. CONTINUE.
      ENDIF.
      CASE lv_event.
        WHEN `PBO`. lv_pbo = |{ lv_pbo } { lv_line }|.
        WHEN `PAI`. lv_pai = |{ lv_pai } { lv_line }|.
      ENDCASE.
    ENDLOOP.

    DATA lv_missing TYPE string.
    LOOP AT lt_areas INTO DATA(lv_area).
      " backtick literals: a backslash is an escape character in |...| templates
      " area name ends at blank, '.', ',' (chained: CALL SUBSCREEN: a, b.) or end
      DATA(lv_pattern) = `CALL\s+SUBSCREEN\s*:?\s*([^.]*,\s*)?` && lv_area && `([\s.,]|$)`.
      FIND PCRE lv_pattern IN lv_pbo.
      IF sy-subrc <> 0.
        lv_missing = |{ lv_missing }\n  subscreen area { lv_area } is not called in PBO | &&
                     |(CALL SUBSCREEN { lv_area } INCLUDING <program> '<dynnr>'.)|.
      ENDIF.
      FIND PCRE lv_pattern IN lv_pai.
      IF sy-subrc <> 0.
        lv_missing = |{ lv_missing }\n  subscreen area { lv_area } is not called in PAI | &&
                     |(CALL SUBSCREEN { lv_area }.)|.
      ENDIF.
    ENDLOOP.
    IF lv_missing IS NOT INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>write_failed
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = |missing CALL SUBSCREEN (SE51 #145), nothing saved:{ lv_missing }|.
    ENDIF.
  ENDMETHOD.


  METHOD last_message.
    IF sy-msgid IS NOT INITIAL.
      MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
              WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO rv_text.
      rv_text = |{ sy-msgid }/{ sy-msgno } { rv_text }|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
