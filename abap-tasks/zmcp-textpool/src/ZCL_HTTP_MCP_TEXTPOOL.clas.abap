CLASS zcl_http_mcp_textpool DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PRIVATE SECTION.
    " category=symbols|selections|headings (default: symbols).
    " Wire formats deliberately mirror the plain-text conventions
    " mcp-abap-adt's WriteProgram/GetObject already parse/render for
    " the stock ADT sub-resources, so the TypeScript client needs no new
    " parser - just a category query param:
    "   symbols:    @MaxLength:20 \n 001=Some Value
    "   selections: PARAM   =Text            (key padded to 8 chars)
    "   headings:   listHeader=...  \n  columnHeader_1=...
    "
    " TEXTPOOL-ID values, all verified against a live system:
    "   'I' symbols  
    "   'S' selections, 'T' list header (key ''), 'H' column headers
    "       (key '001'-'004') - see CL_SEDX_ADT_C_
    "       HANDLER_SELECTIS+_HEADING. 'S' entries carry an 8-char prefix
    "       (8 spaces = no DDIC reference; 'D'+7 spaces = load from DDIC -
    "       this handler only ever writes the non-DDIC form).
    "   'R' key = '' - the program's own title/short text (same value
    "       WriteProgram's `description` writes at creation - confirmed
    "       live: a probe program's 'R' entry matched its description
    "       verbatim). category=title, plain text body, no KEY= framing
    "       needed since there's exactly one value.
    CONSTANTS co_entry_key_non_ddic TYPE c LENGTH 8 VALUE '        '.

    " CSRF token store. Live-tested and rejected: EXPORT/IMPORT TO MEMORY
    " ID - this SICF node issues a SAP_SESSIONID cookie on every request.
    " but even resending that exact cookie on the next request does NOT
    " restore the prior ABAP session's memory (confirmed live: fetch then
    " PUT with the same session cookie still failed IMPORT). The node is
    " not running a genuinely stateful ICF session, only routing-level
    " cookie issuance - a config change only the SICF admin can make, so
    " token storage here uses EXPORT/IMPORT TO DATABASE indx(zt) instead:
    " real persistence, independent of any session/cookie, keyed by the
    " authenticated user (sy-uname, already authenticated by SICF).
    CONSTANTS co_csrf_ttl_sec TYPE i VALUE 900.

    METHODS render_symbols
      IMPORTING it_textpool    TYPE zcl_mcp_textpool=>tt_textpool
      RETURNING VALUE(rv_text) TYPE string.
    METHODS parse_symbols
      IMPORTING iv_text            TYPE string
      RETURNING VALUE(rt_textpool) TYPE zcl_mcp_textpool=>tt_textpool.

    METHODS render_selections
      IMPORTING it_textpool    TYPE zcl_mcp_textpool=>tt_textpool
      RETURNING VALUE(rv_text) TYPE string.
    METHODS parse_selections
      IMPORTING iv_text            TYPE string
      RETURNING VALUE(rt_textpool) TYPE zcl_mcp_textpool=>tt_textpool.

    METHODS render_headings
      IMPORTING it_textpool    TYPE zcl_mcp_textpool=>tt_textpool
      RETURNING VALUE(rv_text) TYPE string.
    METHODS parse_headings
      IMPORTING iv_text            TYPE string
      RETURNING VALUE(rt_textpool) TYPE zcl_mcp_textpool=>tt_textpool.

    METHODS render_title
      IMPORTING it_textpool    TYPE zcl_mcp_textpool=>tt_textpool
      RETURNING VALUE(rv_text) TYPE string.
    METHODS parse_title
      IMPORTING iv_text            TYPE string
      RETURNING VALUE(rt_textpool) TYPE zcl_mcp_textpool=>tt_textpool.

ENDCLASS.


CLASS zcl_http_mcp_textpool IMPLEMENTATION.

  METHOD if_http_extension~handle_request.

    " NOTE ON AUTH: nothing to do here. SICF is configured with the
    " same "Alternative Logon Procedure" as /sap/bc/adt/* -
    " the framework rejects unauthenticated requests before this method
    " ever runs. sy-uname is already the authenticated user by the time
    " we get here, which is exactly what RS_ACCESS_PERMISSION checks
    " inside ZCL_MCP_TEXTPOOL=>write_language.

    DATA(lv_method) = server->request->get_header_field( name = '~request_method' ).

    " CSRF: mirrors /sap/bc/adt's own protocol. A request carrying
    " X-CSRF-Token: Fetch gets a fresh token back in the response header
    " and nothing else runs - no program/language validation needed for
    " a bare token fetch. Any mutating request must then present that
    " same token (issued within the last co_csrf_ttl_sec seconds) or is
    " rejected before touching program/language logic. Token store is
    " keyed by sy-uname (already authenticated by SICF), not by session -
    " see the comment on co_csrf_ttl_sec for why.
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

    DATA lv_program  TYPE programm.
    DATA lv_language TYPE string.
    DATA lv_category TYPE string.

    lv_program  = server->request->get_form_field( 'program' ).
    lv_language = server->request->get_form_field( 'language' ).
    lv_category = server->request->get_form_field( 'category' ).
    TRANSLATE lv_program TO UPPER CASE.
    IF lv_category IS INITIAL.
      lv_category = 'symbols'.
    ENDIF.

    IF lv_program IS INITIAL OR lv_language IS INITIAL.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `program and language query parameters are required` ).
      RETURN.
    ENDIF.

    IF lv_category <> 'symbols' AND lv_category <> 'selections' AND lv_category <> 'headings' AND lv_category <> 'title'.
      server->response->set_status( code = 400 reason = 'Bad Request' ).
      server->response->set_cdata( `category must be symbols, selections, headings, or title` ).
      RETURN.
    ENDIF.

    CASE lv_method.

      WHEN 'GET'.
        TRY.
            DATA(lt_pool) = zcl_mcp_textpool=>read_language(
                               iv_program_name = lv_program
                               iv_language     = lv_language ).
            server->response->set_status( code = 200 reason = 'OK' ).
            CASE lv_category.
              WHEN 'symbols'.    server->response->set_cdata( render_symbols( lt_pool ) ).
              WHEN 'selections'. server->response->set_cdata( render_selections( lt_pool ) ).
              WHEN 'headings'.   server->response->set_cdata( render_headings( lt_pool ) ).
              WHEN 'title'.      server->response->set_cdata( render_title( lt_pool ) ).
            ENDCASE.
          CATCH zcx_mcp_textpool INTO DATA(lx_read).
            server->response->set_status( code = 404 reason = 'Not Found' ).
            server->response->set_cdata( lx_read->get_text( ) ).
        ENDTRY.

      WHEN 'PUT'.
        DATA lv_devclass TYPE devclass.
        DATA lv_trkorr   TYPE trkorr.
        lv_devclass = server->request->get_form_field( 'devclass' ).
        lv_trkorr   = server->request->get_form_field( 'trkorr' ).

        DATA(lv_body) = server->request->get_cdata( ).

        DATA lt_pool_in TYPE zcl_mcp_textpool=>tt_textpool.
        CASE lv_category.
          WHEN 'symbols'.    lt_pool_in = parse_symbols( lv_body ).
          WHEN 'selections'. lt_pool_in = parse_selections( lv_body ).
          WHEN 'headings'.   lt_pool_in = parse_headings( lv_body ).
          WHEN 'title'.      lt_pool_in = parse_title( lv_body ).
        ENDCASE.

        " delete_keys: comma-separated list of individual entry keys to
        " remove outright (distinct from writing an entry with an empty
        " value, which keeps the row but blanks its content). Only
        " meaningful for the two free-form-key categories - headings/
        " title have a fixed, small slot set with no concept of removing
        " a slot.
        DATA(lv_delete_keys) = server->request->get_form_field( 'delete_keys' ).
        DATA lt_delete TYPE zcl_mcp_textpool=>tt_textpool.
        IF lv_delete_keys IS NOT INITIAL.
          IF lv_category <> 'symbols' AND lv_category <> 'selections'.
            server->response->set_status( code = 400 reason = 'Bad Request' ).
            server->response->set_cdata( `delete_keys is only supported for category=symbols or selections` ).
            RETURN.
          ENDIF.
          DATA(lv_delete_id) = COND char1( WHEN lv_category = 'symbols' THEN 'I' ELSE 'S' ).
          SPLIT lv_delete_keys AT ',' INTO TABLE DATA(lt_delete_raw).
          LOOP AT lt_delete_raw INTO DATA(lv_delete_key_raw).
            DATA(lv_delete_key) = condense( to_upper( lv_delete_key_raw ) ).
            CHECK lv_delete_key IS NOT INITIAL.
            APPEND VALUE #( id = lv_delete_id key = lv_delete_key ) TO lt_delete.
          ENDLOOP.
        ENDIF.

        TRY.
            zcl_mcp_textpool=>write_language(
              iv_program_name = lv_program
              iv_language     = lv_language
              iv_devclass     = lv_devclass
              iv_trkorr       = lv_trkorr
              it_textpool     = lt_pool_in
              it_delete       = lt_delete ).
            COMMIT WORK.
            server->response->set_status( code = 200 reason = 'OK' ).
          CATCH zcx_mcp_textpool INTO DATA(lx_write).
            server->response->set_status( code = 409 reason = 'Conflict' ).
            server->response->set_cdata( lx_write->get_text( ) ).
        ENDTRY.

      WHEN OTHERS.
        server->response->set_status( code = 405 reason = 'Method Not Allowed' ).

    ENDCASE.

  ENDMETHOD.


  METHOD render_symbols.
    " id = 'I' for text symbols - confirmed via
    " READ TEXTPOOL on a probe program (key '001').
    LOOP AT it_textpool ASSIGNING FIELD-SYMBOL(<ls>) WHERE id = 'I'.
      rv_text = rv_text &&
        |@MaxLength:{ <ls>-length }| && cl_abap_char_utilities=>newline &&
        |{ <ls>-key }={ <ls>-entry }| && cl_abap_char_utilities=>newline &&
        cl_abap_char_utilities=>newline.
    ENDLOOP.
  ENDMETHOD.


  METHOD parse_symbols.
    " Inverse of render_symbols: blank-line-separated blocks of
    "   @MaxLength:N
    "   KEY=VALUE
    DATA lv_maxlen TYPE textpool-length.
    SPLIT iv_text AT cl_abap_char_utilities=>newline INTO TABLE DATA(lt_lines).

    LOOP AT lt_lines INTO DATA(lv_line).
      CHECK lv_line IS NOT INITIAL.
      IF lv_line CP '@MaxLength:*'.
        lv_maxlen = lv_line+11.
      ELSEIF lv_line CS '='.
        APPEND VALUE #( id     = 'I'                                   " confirmed live, see render_symbols
                         key    = lv_line(3)
                         entry  = substring_after( val = lv_line sub = '=' )
                         length = lv_maxlen )
               TO rt_textpool.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD render_selections.
    " id = 'S'. Entry carries an 8-char prefix (co_entry_key_non_ddic for
    " a plain custom text) before the visible text - stripped here, per
    " CL_SEDX_ADT_C_HANDLER_SELECTIS~serialize (<fs>-entry+8).
    " Key rendered padded to 8 chars, matching the documented external
    " convention (docs/TOOL_INTERNALS.md: "parameter name padded to 8 chars").
    LOOP AT it_textpool ASSIGNING FIELD-SYMBOL(<ls>) WHERE id = 'S'.
      rv_text = rv_text &&
        |{ <ls>-key WIDTH = 8 }| && `=` && <ls>-entry+8 && cl_abap_char_utilities=>newline &&
        cl_abap_char_utilities=>newline.
    ENDLOOP.
  ENDMETHOD.


  METHOD parse_selections.
    " Inverse of render_selections. v1 limitation: always writes the
    " non-DDIC entry prefix - no support for "load text from DDIC"
    " (the '@DDICReference' marker CL_SEDX_ADT_C_HANDLER_SELECTIS also
    " supports is not implemented here).
    SPLIT iv_text AT cl_abap_char_utilities=>newline INTO TABLE DATA(lt_lines).

    LOOP AT lt_lines INTO DATA(lv_line).
      CHECK lv_line IS NOT INITIAL.
      CHECK lv_line CS '='.
      DATA(lv_key)   = condense( to_upper( substring_before( val = lv_line sub = '=' ) ) ).
      DATA(lv_value) = substring_after( val = lv_line sub = '=' ).

      " Two traps found and fixed here, live-verified with zero SAP
      " calls (pure string-logic tests) before redeploying - neither is
      " a DBCS issue, both would break identically for ASCII content:
      " 1) |{ co_entry_key_non_ddic }{ lv_value }| - string templates
      "    right-trim trailing blanks from a CHAR value by default, and
      "    co_entry_key_non_ddic is ENTIRELY blanks, so it collapses to
      "    nothing.
      " 2) DATA(lv_entry) = co_entry_key_non_ddic - inline DATA() infers
      "    lv_entry as CHAR8 (same type as the constant), so the
      "    CONCATENATE below truncates the result to 8 characters
      "    (all-blank, since the prefix alone fills the field). A plain
      "    assignment into an explicitly-declared TYPE string variable
      "    ALSO silently right-trims the all-blank source first - the
      "    constant must be concatenated directly, never assigned to an
      "    intermediate variable first. This is exactly
      "    CL_SEDX_ADT_C_HANDLER_SELECTIS's own pattern.
      DATA lv_entry TYPE string.
      CONCATENATE co_entry_key_non_ddic lv_value INTO lv_entry RESPECTING BLANKS.

      APPEND VALUE #( id     = 'S'
                       key    = lv_key
                       entry  = lv_entry
                       length = 8 + strlen( lv_value ) )
             TO rt_textpool.
    ENDLOOP.
  ENDMETHOD.


  METHOD render_headings.
    " id = 'T' key = '' for the list header/title; id = 'H' key = '001'-
    " '004' for the four column headers - two distinct IDs, confirmed
    " live. Format matches
    " CL_SEDX_ADT_C_HANDLER_HEADING~serialize exactly.
    DATA lv_title TYPE string.
    DATA lv_col1  TYPE string.
    DATA lv_col2  TYPE string.
    DATA lv_col3  TYPE string.
    DATA lv_col4  TYPE string.

    READ TABLE it_textpool ASSIGNING FIELD-SYMBOL(<ls_t>) WITH KEY id = 'T' key = ''.
    IF sy-subrc = 0. lv_title = <ls_t>-entry. ENDIF.
    READ TABLE it_textpool ASSIGNING FIELD-SYMBOL(<ls_1>) WITH KEY id = 'H' key = '001'.
    IF sy-subrc = 0. lv_col1 = <ls_1>-entry. ENDIF.
    READ TABLE it_textpool ASSIGNING FIELD-SYMBOL(<ls_2>) WITH KEY id = 'H' key = '002'.
    IF sy-subrc = 0. lv_col2 = <ls_2>-entry. ENDIF.
    READ TABLE it_textpool ASSIGNING FIELD-SYMBOL(<ls_3>) WITH KEY id = 'H' key = '003'.
    IF sy-subrc = 0. lv_col3 = <ls_3>-entry. ENDIF.
    READ TABLE it_textpool ASSIGNING FIELD-SYMBOL(<ls_4>) WITH KEY id = 'H' key = '004'.
    IF sy-subrc = 0. lv_col4 = <ls_4>-entry. ENDIF.

    rv_text = |listHeader={ lv_title }| && cl_abap_char_utilities=>newline &&
      cl_abap_char_utilities=>newline &&
      |columnHeader_1={ lv_col1 }| && cl_abap_char_utilities=>newline &&
      |columnHeader_2={ lv_col2 }| && cl_abap_char_utilities=>newline &&
      |columnHeader_3={ lv_col3 }| && cl_abap_char_utilities=>newline &&
      |columnHeader_4={ lv_col4 }|.
  ENDMETHOD.


  METHOD parse_headings.
    " Inverse of render_headings - mirrors
    " CL_SEDX_ADT_C_HANDLER_HEADING~deserialize's key dispatch exactly.
    " Only categories (T/H ids) present in the input replace their
    " counterpart in write_language's read-merge-write - e.g. sending
    " only listHeader leaves existing column headers untouched.
    SPLIT iv_text AT cl_abap_char_utilities=>newline INTO TABLE DATA(lt_lines).

    LOOP AT lt_lines INTO DATA(lv_line).
      CHECK lv_line IS NOT INITIAL.
      CHECK lv_line CS '='.
      DATA(lv_key)   = condense( to_upper( substring_before( val = lv_line sub = '=' ) ) ).
      DATA(lv_value) = substring_after( val = lv_line sub = '=' ).
      CASE lv_key.
        WHEN 'LISTHEADER'.
          APPEND VALUE #( id = 'T' key = '' entry = lv_value length = strlen( lv_value ) ) TO rt_textpool.
        WHEN 'COLUMNHEADER_1'.
          APPEND VALUE #( id = 'H' key = '001' entry = lv_value length = strlen( lv_value ) ) TO rt_textpool.
        WHEN 'COLUMNHEADER_2'.
          APPEND VALUE #( id = 'H' key = '002' entry = lv_value length = strlen( lv_value ) ) TO rt_textpool.
        WHEN 'COLUMNHEADER_3'.
          APPEND VALUE #( id = 'H' key = '003' entry = lv_value length = strlen( lv_value ) ) TO rt_textpool.
        WHEN 'COLUMNHEADER_4'.
          APPEND VALUE #( id = 'H' key = '004' entry = lv_value length = strlen( lv_value ) ) TO rt_textpool.
      ENDCASE.
    ENDLOOP.
  ENDMETHOD.


  METHOD render_title.
    " id = 'R' key = '' - the program's title/short text. Single value,
    " no KEY= framing needed.
    READ TABLE it_textpool ASSIGNING FIELD-SYMBOL(<ls>) WITH KEY id = 'R' key = ''.
    IF sy-subrc = 0.
      rv_text = <ls>-entry.
    ENDIF.
  ENDMETHOD.


  METHOD parse_title.
    " A title is one line - take everything before the first newline if
    " the PUT body has one (e.g. a trailing \n from curl), else the
    " whole body as-is.
    DATA(lv_text) = iv_text.
    IF lv_text CS cl_abap_char_utilities=>newline.
      lv_text = substring_before( val = lv_text sub = cl_abap_char_utilities=>newline ).
    ENDIF.
    APPEND VALUE #( id = 'R' key = '' entry = lv_text length = strlen( lv_text ) ) TO rt_textpool.
  ENDMETHOD.

ENDCLASS.
