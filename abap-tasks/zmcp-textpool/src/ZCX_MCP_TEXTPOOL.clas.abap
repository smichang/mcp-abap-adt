CLASS zcx_mcp_textpool DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_t100_message.

    CONSTANTS:
      BEGIN OF permission_denied,
        msgid TYPE symsgid VALUE 'ZMCP_TEXTPOOL',
        msgno TYPE symsgno VALUE '001',
        attr1 TYPE scx_attrname VALUE 'PROGRAM_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF permission_denied,
      BEGIN OF insert_failed,
        msgid TYPE symsgid VALUE 'ZMCP_TEXTPOOL',
        msgno TYPE symsgno VALUE '002',
        attr1 TYPE scx_attrname VALUE 'PROGRAM_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF insert_failed,
      BEGIN OF not_found,
        msgid TYPE symsgid VALUE 'ZMCP_TEXTPOOL',
        msgno TYPE symsgno VALUE '003',
        attr1 TYPE scx_attrname VALUE 'PROGRAM_NAME',
        attr2 TYPE scx_attrname VALUE 'LANGUAGE',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF not_found,
      BEGIN OF unknown_language,
        msgid TYPE symsgid VALUE 'ZMCP_TEXTPOOL',
        msgno TYPE symsgno VALUE '004',
        attr1 TYPE scx_attrname VALUE 'LANGUAGE',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF unknown_language.

    " STRING, not SY-LANGU: this may hold the caller's raw, unresolved
    " input (e.g. "ZF" or "ZZZ") - a 1-char field would silently truncate
    " it before it could be shown in an error message.
    DATA program_name TYPE programm.
    DATA language     TYPE string.

    METHODS constructor
      IMPORTING
        textid       LIKE if_t100_message=>t100key OPTIONAL
        previous     LIKE previous OPTIONAL
        program_name TYPE programm OPTIONAL
        language     TYPE string OPTIONAL.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcx_mcp_textpool IMPLEMENTATION.

  METHOD constructor.
    CALL METHOD super->constructor
      EXPORTING
        previous = previous.
    me->program_name = program_name.
    me->language     = language.
    IF textid IS INITIAL.
      if_t100_message~t100key = if_t100_message=>default_textid.
    ELSE.
      if_t100_message~t100key = textid.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
