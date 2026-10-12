CLASS zcx_mcp_auth_object DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_t100_message.

    CONSTANTS:
      BEGIN OF permission_denied,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '001',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF permission_denied,
      BEGIN OF already_exists,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '002',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF already_exists,
      BEGIN OF not_found,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '003',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF not_found,
      BEGIN OF invalid_field,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '004',
        attr1 TYPE scx_attrname VALUE 'FIELD_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF invalid_field,
      BEGIN OF name_too_long,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '005',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF name_too_long,
      BEGIN OF invalid_namespace,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '006',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF invalid_namespace,
      BEGIN OF class_not_found,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '007',
        attr1 TYPE scx_attrname VALUE 'OBJECT_CLASS',
        attr2 TYPE scx_attrname VALUE '',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF class_not_found,
      BEGIN OF save_failed,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '008',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE 'DETAIL',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF save_failed,
      BEGIN OF invalid_activity,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '009',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE 'DETAIL',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF invalid_activity,
      BEGIN OF field_locked,
        msgid TYPE symsgid VALUE 'ZMCP_AUTH_OBJECT',
        msgno TYPE symsgno VALUE '010',
        attr1 TYPE scx_attrname VALUE 'OBJECT_NAME',
        attr2 TYPE scx_attrname VALUE 'DETAIL',
        attr3 TYPE scx_attrname VALUE '',
        attr4 TYPE scx_attrname VALUE '',
      END OF field_locked.

    DATA object_name  TYPE string.
    DATA object_class TYPE string.
    DATA field_name   TYPE string.
    DATA detail       TYPE string.

    METHODS constructor
      IMPORTING
        textid       LIKE if_t100_message=>t100key OPTIONAL
        previous     LIKE previous OPTIONAL
        object_name  TYPE string OPTIONAL
        object_class TYPE string OPTIONAL
        field_name   TYPE string OPTIONAL
        detail       TYPE string OPTIONAL.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcx_mcp_auth_object IMPLEMENTATION.

  METHOD constructor ##ADT_SUPPRESS_GENERATION.
    CALL METHOD super->constructor
      EXPORTING
        previous = previous.
    me->object_name  = object_name.
    me->object_class = object_class.
    me->field_name   = field_name.
    me->detail       = detail.
    IF textid IS INITIAL.
      if_t100_message~t100key = if_t100_message=>default_textid.
    ELSE.
      if_t100_message~t100key = textid.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
