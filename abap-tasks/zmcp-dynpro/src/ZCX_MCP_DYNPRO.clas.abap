************************************************************************
* Exception class for the ManageDynpro MCP tool (SICF default_host/zmcp/dynpro,
* ZCL_HTTP_MCP_DYNPRO).
************************************************************************
CLASS zcx_mcp_dynpro DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_t100_message.

    " Message class ZMCP_DYNPRO does not exist (same as ZCX_MCP_AUTH_OBJECT's
    " ZMCP_AUTH_OBJECT): the textids only classify the error. ZCL_HTTP_MCP_DYNPRO's
    " map_exception builds the text itself from PROGRAM/DYNNR/DETAIL, which
    " also avoids the 50-char T100 placeholder truncation.
    CONSTANTS:
      BEGIN OF bad_request,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '001',
        attr1 TYPE scx_attrname VALUE 'DETAIL',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF bad_request,
      BEGIN OF permission_denied,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '002',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF permission_denied,
      BEGIN OF program_not_found,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '003',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF program_not_found,
      BEGIN OF screen_not_found,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '004',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DYNNR',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF screen_not_found,
      BEGIN OF read_failed,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '005',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DYNNR',
        attr3 TYPE scx_attrname VALUE 'DETAIL',
        attr4 TYPE scx_attrname VALUE '',
      END OF read_failed,
      BEGIN OF already_exists,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '006',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DYNNR',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF already_exists,
      BEGIN OF not_supported,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '007',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DYNNR',
        attr3 TYPE scx_attrname VALUE 'DETAIL',
        attr4 TYPE scx_attrname VALUE '',
      END OF not_supported,
      BEGIN OF transport_invalid,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '008',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DETAIL',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF transport_invalid,
      BEGIN OF write_failed,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '009',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DYNNR',
        attr3 TYPE scx_attrname VALUE 'DETAIL',
        attr4 TYPE scx_attrname VALUE '',
      END OF write_failed,
      BEGIN OF conflict,
        msgid TYPE symsgid VALUE 'ZMCP_DYNPRO',
        msgno TYPE symsgno VALUE '010',
        attr1 TYPE scx_attrname VALUE 'PROGRAM',
        attr2 TYPE scx_attrname VALUE 'DYNNR',
        attr3 TYPE scx_attrname VALUE 'DETAIL',
        attr4 TYPE scx_attrname VALUE '',
      END OF conflict.

    DATA program TYPE string.
    DATA dynnr   TYPE string.
    DATA detail  TYPE string.

    METHODS constructor
      IMPORTING
        textid   LIKE if_t100_message=>t100key OPTIONAL
        previous LIKE previous OPTIONAL
        program  TYPE string OPTIONAL
        dynnr    TYPE string OPTIONAL
        detail   TYPE string OPTIONAL.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcx_mcp_dynpro IMPLEMENTATION.

  METHOD constructor ##ADT_SUPPRESS_GENERATION.
    CALL METHOD super->constructor
      EXPORTING
        previous = previous.
    me->program = program.
    me->dynnr   = dynnr.
    me->detail  = detail.
    IF textid IS INITIAL.
      if_t100_message~t100key = if_t100_message=>default_textid.
    ELSE.
      if_t100_message~t100key = textid.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
