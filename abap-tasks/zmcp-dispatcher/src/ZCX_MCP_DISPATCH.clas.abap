CLASS zcx_mcp_dispatch DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_t100_message.

    CONSTANTS:
      BEGIN OF unknown_action,
        msgid TYPE symsgid VALUE 'ZMCP_DISPATCH',
        msgno TYPE symsgno VALUE '001',
        attr1 TYPE scx_attrname VALUE 'ACTION',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF unknown_action,
      BEGIN OF permission_denied,
        msgid TYPE symsgid VALUE 'ZMCP_DISPATCH',
        msgno TYPE symsgno VALUE '002',
        attr1 TYPE scx_attrname VALUE 'ACTION',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF permission_denied,
      BEGIN OF bad_request,
        msgid TYPE symsgid VALUE 'ZMCP_DISPATCH',
        msgno TYPE symsgno VALUE '003',
        attr1 TYPE scx_attrname VALUE 'ACTION',
        attr2 TYPE scx_attrname VALUE 'DETAIL',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF bad_request.

    " STRING: action/detail are caller-supplied HTTP request content, not
    " DDIC-bounded fields - a fixed-length type would silently truncate an
    " overlong or unexpected value before it could be shown in the error.
    DATA action TYPE string.
    DATA detail TYPE string.

    METHODS constructor
      IMPORTING
        textid   LIKE if_t100_message=>t100key OPTIONAL
        previous LIKE previous OPTIONAL
        action   TYPE string OPTIONAL
        detail   TYPE string OPTIONAL.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcx_mcp_dispatch IMPLEMENTATION.

  METHOD constructor.
    CALL METHOD super->constructor
      EXPORTING
        previous = previous.
    me->action = action.
    me->detail = detail.
    IF textid IS INITIAL.
      if_t100_message~t100key = if_t100_message=>default_textid.
    ELSE.
      if_t100_message~t100key = textid.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
