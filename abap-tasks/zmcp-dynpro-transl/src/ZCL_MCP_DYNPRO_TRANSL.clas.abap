************************************************************************
* Program Type : Class
* Description  : Language-dependent texts of a classic Dynpro (screen
*                element texts, table D021T) for the ManageDynpro MCP
*                bridge. Does what SE63 does for a screen, without SAP GUI:
*                reads source/target text pairs and writes a translation,
*                never touching the screen's master-language definition.
*                Engine: LXE translation environment (the same function
*                modules SE63 calls) - LXE_OBJ_TEXT_PAIR_READ_SCRT,
*                LXE_OBJ_TEXT_WRITE_SCRT, LXE_LOG_WRITE. Object type SCRT,
*                object name = program (40) + screen number (4).
* Author       : SSCR (MCP)
* Created Date : 2026/10/16
* Modifications:
************************************************************************
* Date        Author      RequestNo   Description
* ---------   ---------   ----------  ----------------------------------
* 2026/10/16  SSCR                    Initial version
************************************************************************
CLASS zcl_mcp_dynpro_transl DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_element,
        element     TYPE string,
        source_text TYPE string,
        target_text TYPE string,
        max_length  TYPE i,
      END OF ty_element,
      ty_elements TYPE STANDARD TABLE OF ty_element WITH DEFAULT KEY,
      BEGIN OF ty_listing,
        program         TYPE string,
        dynnr           TYPE string,
        source_language TYPE string,
        target_language TYPE string,
        target_iso      TYPE string,
        elements        TYPE ty_elements,
      END OF ty_listing,
      BEGIN OF ty_text,
        element TYPE string,
        text    TYPE string,
      END OF ty_text,
      ty_texts TYPE STANDARD TABLE OF ty_text WITH DEFAULT KEY,
      BEGIN OF ty_request,
        texts TYPE ty_texts,
      END OF ty_request.

    "! Translatable element texts of a screen with source text, current
    "! target text and the maximum length of each.
    CLASS-METHODS list
      IMPORTING
        iv_program        TYPE progname
        iv_dynnr          TYPE dynnr
        iv_language       TYPE string
      RETURNING
        VALUE(rs_listing) TYPE ty_listing
      RAISING
        zcx_mcp_dynpro.

    "! Writes target-language texts. iv_json = {"texts":[{"element":"X","text":"Y"}]}.
    "! All input is validated first; either every text is written or none.
    CLASS-METHODS write
      IMPORTING
        iv_program     TYPE progname
        iv_dynnr       TYPE dynnr
        iv_language    TYPE string
        iv_json        TYPE string
      RETURNING
        VALUE(rv_info) TYPE string
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS to_json
      IMPORTING
        ia_data        TYPE data
      RETURNING
        VALUE(rv_json) TYPE string.

  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_row,
        fldn TYPE d021t-fldn,
        dtxt TYPE d021t-dtxt,
      END OF ty_row,
      ty_rows  TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY,
      ty_pairs TYPE STANDARD TABLE OF lxe_pcx_s1 WITH DEFAULT KEY,
      BEGIN OF ty_target,
        index   TYPE i,
        element TYPE string,
        text    TYPE string,
      END OF ty_target,
      ty_targets TYPE STANDARD TABLE OF ty_target WITH DEFAULT KEY.

    CLASS-METHODS check_program
      IMPORTING
        iv_program TYPE progname
        iv_dynnr   TYPE dynnr
        iv_actvt   TYPE activ_auth
        iv_target  TYPE spras OPTIONAL
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS check_customer_program
      IMPORTING
        iv_program TYPE progname
        iv_dynnr   TYPE dynnr
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS resolve_language
      IMPORTING
        iv_program     TYPE progname
        iv_dynnr       TYPE dynnr
        iv_language    TYPE string
      EXPORTING
        ev_source      TYPE spras
        ev_target      TYPE spras
        ev_target_iso  TYPE lxeisolang
        ev_source_iso  TYPE lxeisolang
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS read_pairs
      IMPORTING
        iv_program   TYPE progname
        iv_dynnr     TYPE dynnr
        iv_source    TYPE spras
        iv_target    TYPE spras
        iv_read_only TYPE abap_bool
      EXPORTING
        ev_objname   TYPE lxeobjname
        et_pairs     TYPE ty_pairs
        et_rows      TYPE ty_rows
      RAISING
        zcx_mcp_dynpro.

    CLASS-METHODS element_of
      IMPORTING
        is_pair           TYPE lxe_pcx_s1
        it_rows           TYPE ty_rows
        iv_program        TYPE progname
        iv_dynnr          TYPE dynnr
      RETURNING
        VALUE(rv_element) TYPE string
      RAISING
        zcx_mcp_dynpro.

ENDCLASS.


CLASS zcl_mcp_dynpro_transl IMPLEMENTATION.

  METHOD check_program.
    IF iv_program IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = `program is required`.
    ENDIF.
    IF iv_dynnr IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = `dynnr is required`.
    ENDIF.

    SELECT SINGLE name FROM trdir WHERE name = @iv_program INTO @DATA(lv_name) ##NEEDED.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>program_not_found
          program = CONV #( iv_program ).
    ENDIF.
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

    " package: a function group main program (SAPL<group>) is registered
    " as R3TR FUGR <group>, not PROG
    DATA lv_devclass TYPE devclass.
    SELECT SINGLE devclass FROM tadir
      WHERE pgmid = 'R3TR' AND object = 'PROG' AND obj_name = @iv_program
      INTO @lv_devclass.
    IF sy-subrc <> 0 AND iv_program CP 'SAPL*'.
      DATA(lv_fugr) = CONV sobj_name( iv_program+4 ).
      SELECT SINGLE devclass FROM tadir
        WHERE pgmid = 'R3TR' AND object = 'FUGR' AND obj_name = @lv_fugr
        INTO @lv_devclass.
      IF sy-subrc <> 0.
        CLEAR lv_devclass.
      ENDIF.
    ENDIF.

    AUTHORITY-CHECK OBJECT 'S_DEVELOP'
      ID 'DEVCLASS' FIELD lv_devclass
      ID 'OBJTYPE'  FIELD 'PROG'
      ID 'OBJNAME'  FIELD iv_program
      ID 'P_GROUP'  DUMMY
      ID 'ACTVT'    FIELD iv_actvt.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>permission_denied
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr ).
    ENDIF.

    " SE63's own authorization: translating into this language
    IF iv_actvt <> '03' AND iv_target IS NOT INITIAL.
      AUTHORITY-CHECK OBJECT 'S_TRANSLAT'
        ID 'ACTVT'     FIELD iv_actvt
        ID 'TLANGUAGE' FIELD iv_target
        ID 'TRANOBJ'   DUMMY.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>permission_denied
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |no translation authorization (S_TRANSLAT) for language { iv_target }|.
      ENDIF.
    ENDIF.
  ENDMETHOD.


  METHOD check_customer_program.
    " Same limit as ManageDynpro: an SAP screen is a modification.
    IF NOT ( iv_program CP 'Z*' OR iv_program CP 'Y*'
          OR iv_program CP 'SAPLZ*' OR iv_program CP 'SAPLY*' ).
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>not_supported
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `screen texts can only be translated in customer programs (Z*, Y*, SAPLZ*, SAPLY*)`.
    ENDIF.
  ENDMETHOD.


  METHOD resolve_language.
    " Accepts the R/3 key (M), the two-character ISO code (ZF) or the LXE
    " language (zhTW). The source is always the screen's master language.
    DATA(lv_in) = condense( iv_language ).
    IF lv_in IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = `language is required (e.g. M, ZF or zhTW)`.
    ENDIF.

    CLEAR ev_target.
    CASE strlen( lv_in ).
      WHEN 1.
        DATA(lv_key) = CONV spras( to_upper( lv_in ) ).
        SELECT SINGLE spras FROM t002 WHERE spras = @lv_key INTO @ev_target.
      WHEN 2.
        DATA(lv_iso) = CONV laiso( to_upper( lv_in ) ).
        SELECT SINGLE spras FROM t002 WHERE laiso = @lv_iso INTO @ev_target.
      WHEN 4.
        DATA(lv_lxe) = CONV lxeisolang( lv_in ).
        SELECT SINGLE r3_lang FROM lxe_t002 WHERE language = @lv_lxe INTO @ev_target.
    ENDCASE.
    IF ev_target IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = |unknown language "{ iv_language }" - use the SAP key (M), ISO code (ZF) or LXE code (zhTW)|.
    ENDIF.

    " master language of the screen
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
    IF sy-subrc <> 0 OR ls_header-language IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>read_failed
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `master language of the screen could not be read`.
    ENDIF.
    ev_source = ls_header-language.

    IF ev_source = ev_target.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>bad_request
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = |target language { ev_target } is the screen's master language - change the master text with ManageDynpro update instead|.
    ENDIF.

    SELECT SINGLE language FROM lxe_t002
      WHERE r3_lang = @ev_target AND is_r3_lang = @abap_true INTO @ev_target_iso.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>not_supported
          detail = |language { ev_target } has no translation-environment (LXE) language|.
    ENDIF.
    SELECT SINGLE language FROM lxe_t002
      WHERE r3_lang = @ev_source AND is_r3_lang = @abap_true INTO @ev_source_iso.
  ENDMETHOD.


  METHOD read_pairs.
    CLEAR: et_pairs, et_rows.
    ev_objname = iv_program.
    ev_objname+40(4) = iv_dynnr.

    " read_only = space also makes the function group remember which text key
    " belongs to which element - LXE_OBJ_TEXT_WRITE_SCRT needs that map, and it
    " lives in the same session, so the write must follow in this request.
    DATA lv_status TYPE lxestatprc.
    CALL FUNCTION 'LXE_OBJ_TEXT_PAIR_READ_SCRT'
      EXPORTING
        t_r3_lang = iv_target
        s_r3_lang = iv_source
        objtype   = 'SCRT'
        objname   = ev_objname
        read_only = COND char1( WHEN iv_read_only = abap_true THEN 'X' ELSE ' ' )
      IMPORTING
        pstatus   = lv_status
      TABLES
        lt_pcx_s1 = et_pairs.
    IF lv_status = 'F'.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>read_failed
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = `translation environment could not read the screen texts`.
    ENDIF.

    " The text key is DTXT + the position of the row among ALL source-language
    " rows of D021T in primary-key order (the function counts every row).
    SELECT * FROM d021t
      WHERE prog = @iv_program AND dynr = @iv_dynnr AND lang = @iv_source
      ORDER BY PRIMARY KEY
      INTO TABLE @DATA(lt_d021t).
    et_rows = VALUE #( FOR ls_d IN lt_d021t ( fldn = ls_d-fldn dtxt = ls_d-dtxt ) ).
  ENDMETHOD.


  METHOD element_of.
    DATA(lv_pos) = CONV i( is_pair-textkey+10(5) ).
    READ TABLE it_rows INTO DATA(ls_row) INDEX lv_pos.
    " cross-check: a wrong position would put a translation on the wrong element
    IF sy-subrc <> 0 OR ls_row-dtxt <> is_pair-s_text.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>write_failed
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = |text key { is_pair-textkey } does not match an element of D021T - nothing written|.
    ENDIF.
    rv_element = ls_row-fldn.
  ENDMETHOD.


  METHOD list.
    check_program( iv_program = iv_program iv_dynnr = iv_dynnr iv_actvt = '03' ).
    resolve_language(
      EXPORTING iv_program    = iv_program
                iv_dynnr      = iv_dynnr
                iv_language   = iv_language
      IMPORTING ev_source     = DATA(lv_source)
                ev_target     = DATA(lv_target)
                ev_target_iso = DATA(lv_target_iso) ).

    read_pairs(
      EXPORTING iv_program   = iv_program
                iv_dynnr     = iv_dynnr
                iv_source    = lv_source
                iv_target    = lv_target
                iv_read_only = abap_true
      IMPORTING et_pairs     = DATA(lt_pairs)
                et_rows      = DATA(lt_rows) ).

    rs_listing-program         = iv_program.
    rs_listing-dynnr           = iv_dynnr.
    rs_listing-source_language = lv_source.
    rs_listing-target_language = lv_target.
    rs_listing-target_iso      = lv_target_iso.
    LOOP AT lt_pairs INTO DATA(ls_pair).
      APPEND VALUE #( element     = element_of( is_pair    = ls_pair
                                                it_rows    = lt_rows
                                                iv_program = iv_program
                                                iv_dynnr   = iv_dynnr )
                      source_text = condense( CONV string( ls_pair-s_text ) )
                      target_text = condense( CONV string( ls_pair-t_text ) )
                      max_length  = ls_pair-unitmlt ) TO rs_listing-elements.
    ENDLOOP.
    SORT rs_listing-elements BY element.
  ENDMETHOD.


  METHOD write.
    check_program( iv_program = iv_program iv_dynnr = iv_dynnr iv_actvt = '03' ).
    check_customer_program( iv_program = iv_program iv_dynnr = iv_dynnr ).
    resolve_language(
      EXPORTING iv_program    = iv_program
                iv_dynnr      = iv_dynnr
                iv_language   = iv_language
      IMPORTING ev_source     = DATA(lv_source)
                ev_target     = DATA(lv_target)
                ev_target_iso = DATA(lv_target_iso) ).
    " change authorization, now that the target language is known
    check_program( iv_program = iv_program iv_dynnr = iv_dynnr iv_actvt = '02' iv_target = lv_target ).

    " ---- request ----
    DATA ls_request TYPE ty_request.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json        = iv_json
                                             pretty_name = /ui2/cl_json=>pretty_mode-low_case
                                   CHANGING  data        = ls_request ).
      CATCH cx_root INTO DATA(lx_json).
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid = zcx_mcp_dynpro=>bad_request
            detail = |body is not valid JSON: { lx_json->get_text( ) }|.
    ENDTRY.
    IF ls_request-texts IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid = zcx_mcp_dynpro=>bad_request
          detail = `texts is required: {"texts":[{"element":"NAME","text":"..."}]}`.
    ENDIF.

    " ---- read pairs (read_only = space builds the key->element map) ----
    read_pairs(
      EXPORTING iv_program   = iv_program
                iv_dynnr     = iv_dynnr
                iv_source    = lv_source
                iv_target    = lv_target
                iv_read_only = abap_false
      IMPORTING ev_objname   = DATA(lv_objname)
                et_pairs     = DATA(lt_pairs)
                et_rows      = DATA(lt_rows) ).

    " ---- validate everything before anything is written ----
    DATA lt_targets TYPE ty_targets.
    DATA lt_seen TYPE SORTED TABLE OF string WITH UNIQUE DEFAULT KEY.
    DATA lt_known TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    LOOP AT lt_pairs INTO DATA(ls_pair).
      DATA(lv_el) = element_of( is_pair    = ls_pair
                                it_rows    = lt_rows
                                iv_program = iv_program
                                iv_dynnr   = iv_dynnr ).
      APPEND lv_el TO lt_known.
    ENDLOOP.

    LOOP AT ls_request-texts INTO DATA(ls_text).
      DATA(lv_name) = to_upper( condense( ls_text-element ) ).
      DATA(lv_new)  = shift_right( val = ls_text-text sub = ` ` ).
      IF lv_name IS INITIAL OR lv_new IS INITIAL.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid = zcx_mcp_dynpro=>bad_request
            detail = `every entry needs a non-empty element and text (deleting a translation is not supported)`.
      ENDIF.
      INSERT lv_name INTO TABLE lt_seen.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid = zcx_mcp_dynpro=>bad_request
            detail = |element { lv_name } is given twice|.
      ENDIF.
      READ TABLE lt_known TRANSPORTING NO FIELDS WITH KEY table_line = lv_name.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>bad_request
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |element { lv_name } has no translatable text on this screen - nothing written. Translatable: { concat_lines_of( table = lt_known sep = `, ` ) }|.
      ENDIF.
      DATA(lv_idx) = sy-tabix.
      READ TABLE lt_pairs INTO ls_pair INDEX lv_idx.
      IF strlen( lv_new ) > ls_pair-unitmlt.
        RAISE EXCEPTION TYPE zcx_mcp_dynpro
          EXPORTING
            textid  = zcx_mcp_dynpro=>bad_request
            program = CONV #( iv_program )
            dynnr   = CONV #( iv_dynnr )
            detail  = |text for { lv_name } is { strlen( lv_new ) } characters, the element holds at most { ls_pair-unitmlt } - nothing written|.
      ENDIF.
      APPEND VALUE #( index = lv_idx element = lv_name text = lv_new ) TO lt_targets.
    ENDLOOP.

    " ---- write ----
    LOOP AT lt_targets INTO DATA(ls_target).
      READ TABLE lt_pairs ASSIGNING FIELD-SYMBOL(<ls_pair>) INDEX ls_target-index.
      <ls_pair>-t_text = ls_target-text.
    ENDLOOP.

    DATA lv_status TYPE lxestatprc.
    CALL FUNCTION 'LXE_OBJ_TEXT_WRITE_SCRT'
      EXPORTING
        r3_lang   = lv_target
        objtype   = 'SCRT'
        objname   = lv_objname
      IMPORTING
        pstatus   = lv_status
      TABLES
        lt_pcx_s1 = lt_pairs.
    IF lv_status <> 'S'.
      ROLLBACK WORK.
      RAISE EXCEPTION TYPE zcx_mcp_dynpro
        EXPORTING
          textid  = zcx_mcp_dynpro=>write_failed
          program = CONV #( iv_program )
          dynnr   = CONV #( iv_dynnr )
          detail  = |translation environment answered status { lv_status } - rolled back|.
    ENDIF.
    COMMIT WORK.

    " Translation log: this is what SE63's translation transport collects.
    DATA lv_log TYPE lxestatprc.
    CALL FUNCTION 'LXE_LOG_WRITE'
      EXPORTING
        trglang = lv_target_iso
        custmnr = cl_lxe_constants=>c_trl_area_local
        objtype = 'SCRT'
        objname = lv_objname
      IMPORTING
        status  = lv_log.
    COMMIT WORK.

    DATA(lt_names) = VALUE string_table( FOR t IN lt_targets ( t-element ) ).
    rv_info = |Wrote { lines( lt_targets ) } text(s) to screen { iv_program } { iv_dynnr } in language { lv_target } ({ lv_target_iso }): | &&
              |{ concat_lines_of( table = lt_names sep = `, ` ) }; master language { lv_source } unchanged.|.
    IF lv_log = 'S'.
      rv_info = |{ rv_info }\nTranslation log: recorded (translation area { cl_lxe_constants=>c_trl_area_local }). | &&
                |These texts are not on a workbench request - move them with SE63's translation transport.|.
    ELSE.
      rv_info = |{ rv_info }\nWARNING: the texts are saved but the translation log entry failed (status { lv_log }) - | &&
                |SE63's translation transport will not pick them up.|.
    ENDIF.
  ENDMETHOD.


  METHOD to_json.
    rv_json = /ui2/cl_json=>serialize( data        = ia_data
                                       pretty_name = /ui2/cl_json=>pretty_mode-low_case ).
  ENDMETHOD.

ENDCLASS.
