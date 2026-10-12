CLASS zcl_mcp_textpool DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES tt_textpool TYPE STANDARD TABLE OF textpool WITH DEFAULT KEY.

    "! Reads a program's text pool in one explicit language.
    "! iv_language accepts EITHER form - the 1-char internal SAP code
    "! (e.g. 'M') or the 2-char ISO code (e.g. 'ZF') - resolved via the
    "! same standard CONVERSION_EXIT_ISOLA_INPUT SAP itself uses. Callers
    "! should never need to know a program's internal SPRAS value.
    CLASS-METHODS read_language
      IMPORTING
        iv_program_name    TYPE programm
        iv_language        TYPE string
      RETURNING
        VALUE(rt_textpool) TYPE tt_textpool
      RAISING
        zcx_mcp_textpool.

    "! Writes a program's text pool in one explicit language, without
    "! touching any other language's entries, any other category's
    "! entries, or - within the same category - any entry whose id+key
    "! isn't present in it_textpool or it_delete (a single-symbol write
    "! leaves every other symbol untouched). it_delete removes entries
    "! by id+key (entry/length ignored) instead of merely blanking them -
    "! a distinct operation from writing an entry with an empty value.
    "! Same iv_language flexibility as read_language.
    "! Reuses SAP-standard RS_ACCESS_PERMISSION (auth+enqueue)
    "! and RPY_TEXTELEMENTS_INSERT (INSERT TEXTPOOL ... LANGUAGE
    "! + transport registration) as LOCAL calls - no RFC destination,
    "! no JCo, same application server.
    CLASS-METHODS write_language
      IMPORTING
        iv_program_name TYPE programm
        iv_language     TYPE string
        iv_devclass     TYPE devclass
        iv_trkorr       TYPE trkorr OPTIONAL
        it_textpool     TYPE tt_textpool
        it_delete       TYPE tt_textpool OPTIONAL
      RAISING
        zcx_mcp_textpool.

  PRIVATE SECTION.

    "! Resolves either an ISO (2-char, e.g. 'ZF') or internal (1-char,
    "! e.g. 'M') language code to the internal SY-LANGU value, via the
    "! same conversion exit SAP's own screens use for language fields.
    CLASS-METHODS resolve_language
      IMPORTING
        iv_language        TYPE string
      RETURNING
        VALUE(rv_language) TYPE sy-langu
      RAISING
        zcx_mcp_textpool.

ENDCLASS.


CLASS zcl_mcp_textpool IMPLEMENTATION.

  METHOD resolve_language.

    DATA lv_input TYPE char2.
    lv_input = iv_language.

    CALL FUNCTION 'CONVERSION_EXIT_ISOLA_INPUT'
      EXPORTING
        input            = lv_input
      IMPORTING
        output           = rv_language
      EXCEPTIONS
        unknown_language = 1
        OTHERS           = 2.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_textpool
        EXPORTING
          textid   = zcx_mcp_textpool=>unknown_language
          language = iv_language.
    ENDIF.

  ENDMETHOD.


  METHOD read_language.

    DATA(lv_language) = resolve_language( iv_language ).

    READ TEXTPOOL iv_program_name LANGUAGE lv_language INTO rt_textpool.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_textpool
        EXPORTING
          textid       = zcx_mcp_textpool=>not_found
          program_name = iv_program_name
          language     = iv_language.
    ENDIF.

  ENDMETHOD.


  METHOD write_language.

    DATA(lv_language) = resolve_language( iv_language ).

    " ----------------------------------------------------------------
    " Authorization + enqueue, done HERE and not left to
    " RPY_TEXTELEMENTS_INSERT: reading that FM's source shows the whole
    " RS_ACCESS_PERMISSION call sits inside
    "   IF LIFECYCLE_MANAGER IS BOUND AND G_SUPPRESS_ACCESS_PERMISSION = ABAP_FALSE.
    " which we never satisfy (no AiE "dark transport" lifecycle manager
    " bound in a plain background/API call) - so with SUPPRESS_DIALOG = 'X'
    " the FM performs *no* authority check and *no* enqueue at all.
    " We therefore call the same standard FM ourselves first.
    " ----------------------------------------------------------------
    CALL FUNCTION 'RS_ACCESS_PERMISSION'
      EXPORTING
        authority_check          = 'X'
        global_lock              = space
        mode                     = 'INSERT'
        object                   = iv_program_name
        object_class             = 'TEXT'
      EXCEPTIONS
        canceled_in_corr         = 1
        enqueued_by_user         = 2
        enqueue_system_failure   = 3
        illegal_parameter_values = 4
        locked_by_author         = 5
        no_modify_permission     = 6
        no_show_permission       = 7
        permission_failure       = 8
        OTHERS                   = 9.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_textpool
        EXPORTING
          textid       = zcx_mcp_textpool=>permission_denied
          program_name = iv_program_name
          language     = iv_language.
    ENDIF.

    DATA(lv_devclass) = iv_devclass.
    DATA(lv_trkorr)   = iv_trkorr.
    DATA(lv_ok)       = abap_true.

    " INSERT TEXTPOOL ... LANGUAGE replaces the ENTIRE pool for that
    " language, not just the given rows (verified: writing
    " only a symbol, then writing only a selection text for the same
    " language, silently deleted the symbol). Merge at the individual
    " entry level (id+key), not just category (id) - matching only on
    " id would keep this class's own doc promise ("without touching any
    " other language's entries") while still silently wiping every
    " OTHER entry in the SAME category (e.g. sending just symbol '002'
    " would drop 001/003/...). id+key means an existing entry survives
    " unless the caller supplied that exact same id+key, so a
    " single-symbol write only ever touches that one symbol.
    DATA lt_existing TYPE tt_textpool.
    DATA lt_merged   TYPE tt_textpool.

    READ TEXTPOOL iv_program_name LANGUAGE lv_language INTO lt_existing.
    " sy-subrc ignored: lt_existing stays empty if no pool exists yet.

    LOOP AT lt_existing INTO DATA(ls_existing).
      READ TABLE it_textpool TRANSPORTING NO FIELDS WITH KEY id = ls_existing-id key = ls_existing-key.
      CHECK sy-subrc <> 0.  " will be replaced by the new value appended below
      READ TABLE it_delete TRANSPORTING NO FIELDS WITH KEY id = ls_existing-id key = ls_existing-key.
      CHECK sy-subrc <> 0.  " explicitly deleted - drop it, don't carry it forward
      APPEND ls_existing TO lt_merged.
    ENDLOOP.
    APPEND LINES OF it_textpool TO lt_merged.

    CALL FUNCTION 'RPY_TEXTELEMENTS_INSERT'
      EXPORTING
        development_class  = lv_devclass
        language           = lv_language
        program_name       = iv_program_name
        r2_flag            = space
        temporary          = space
        transport_number   = lv_trkorr
        suppress_dialog    = abap_true
      TABLES
        source             = lt_merged
      EXCEPTIONS
        cancelled          = 1
        permission_error   = 2
        program_not_exists = 3
        OTHERS             = 4.
    IF sy-subrc <> 0.
      lv_ok = abap_false.
    ENDIF.

    " Always release what we took, success or failure.
    CALL FUNCTION 'RS_ACCESS_PERMISSION'
      EXPORTING
        mode         = 'FREE'
        object       = iv_program_name
        object_class = 'TEXT'.

    IF lv_ok = abap_false.
      RAISE EXCEPTION TYPE zcx_mcp_textpool
        EXPORTING
          textid       = zcx_mcp_textpool=>insert_failed
          program_name = iv_program_name
          language     = iv_language.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
