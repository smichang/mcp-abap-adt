CLASS zcl_mcp_auth_object DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.

    " NOTE: object_name/object_class/field_name are TYPE string here, not
    " the DDIC CHAR10/CHAR4/CHAR10 fields (xuobject/xuobjclass/xufield) -
    " deliberately, so an over-length value can be rejected explicitly
    " (name_too_long / invalid_field) instead of silently truncating at
    " the interface boundary the way WriteProgram's CLAS/FUGR/FUNC names
    " once did before that bug was fixed. Conversion to the DDIC-typed
    " field happens only after validate_name/validate_fields has already
    " confirmed the length is safe.
    TYPES:
      BEGIN OF ts_field,
        field_name TYPE string,
      END OF ts_field,
      tt_field TYPE STANDARD TABLE OF ts_field WITH EMPTY KEY,
      tt_suso_field_ext TYPE STANDARD TABLE OF cl_suso_appl=>ts_suso_field_ext WITH EMPTY KEY,
      " Permitted activities for the ACTVT field (SU21's activity list,
      " persisted in TACTZ). TYPE string for the same explicit-rejection
      " reason as above - ACTVT is CHAR2.
      tt_activity TYPE STANDARD TABLE OF string WITH EMPTY KEY.

    CLASS-METHODS object_exists
      IMPORTING object_name   TYPE string
      RETURNING VALUE(result) TYPE abap_bool.

    METHODS create_object
      IMPORTING
        object_class TYPE string
        object_name  TYPE string
        description  TYPE string
        fields       TYPE tt_field OPTIONAL
        activities   TYPE tt_activity OPTIONAL
        devclass     TYPE devclass
        trkorr       TYPE e070-trkorr OPTIONAL
      RAISING
        zcx_mcp_auth_object.

    " fields omitted/empty = keep the object's current field list.
    " activities omitted/empty = keep the object's current TACTZ list.
    " object_class omitted/empty = keep the current class. The class is
    " header data, so it stays changeable after the object is in use
    " (only the field list locks).
    METHODS update_object
      IMPORTING
        object_name  TYPE string
        object_class TYPE string OPTIONAL
        description  TYPE string OPTIONAL
        fields      TYPE tt_field OPTIONAL
        activities  TYPE tt_activity OPTIONAL
        trkorr      TYPE e070-trkorr OPTIONAL
      RAISING
        zcx_mcp_auth_object.

  PRIVATE SECTION.

    METHODS validate_name
      IMPORTING object_name TYPE string
      RAISING   zcx_mcp_auth_object.

    METHODS validate_class
      IMPORTING object_class TYPE string
      RAISING   zcx_mcp_auth_object.

    METHODS validate_fields
      IMPORTING fields TYPE tt_field
      RAISING   zcx_mcp_auth_object.

    " Everything SU21's CHECK_SUSO would reject about the activity list is
    " checked here, BEFORE any save: create is a two-phase save (header,
    " then fields), and CL_SUSO_APPL keeps its own message log private, so
    " a failure in phase 2 would otherwise leave a half-built object behind
    " with nothing more than "returned 8" to explain it.
    METHODS validate_activities
      IMPORTING
        object_name TYPE string
        fields      TYPE tt_field
        activities  TYPE tt_activity
        is_update   TYPE abap_bool
      RAISING
        zcx_mcp_auth_object.

    METHODS read_current_fields
      IMPORTING object_name   TYPE xuobject
      RETURNING VALUE(result) TYPE tt_field.

    METHODS build_field_buffer
      IMPORTING
        object_name   TYPE xuobject
        fields        TYPE tt_field
      RETURNING
        VALUE(result) TYPE tt_suso_field_ext.

    METHODS attach_fields
      IMPORTING
        object_name  TYPE xuobject
        object_class TYPE xuobjclass
        description  TYPE tobjt-ttext
        fields       TYPE tt_field
        activities   TYPE tt_activity OPTIONAL
        trkorr       TYPE e070-trkorr OPTIONAL
      RAISING
        zcx_mcp_auth_object.

ENDCLASS.


CLASS zcl_mcp_auth_object IMPLEMENTATION.

  METHOD object_exists.
    IF strlen( object_name ) > 10.
      result = abap_false.
      RETURN.
    ENDIF.
    result = cl_suso=>object_exist( CONV #( object_name ) ).
  ENDMETHOD.

  METHOD validate_name.
    IF strlen( object_name ) = 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>invalid_namespace
          object_name = object_name.
    ENDIF.
    IF strlen( object_name ) > 10.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>name_too_long
          object_name = object_name
          detail      = |{ strlen( object_name ) } chars, max 10|.
    ENDIF.
    IF NOT ( object_name(1) = 'Y' OR object_name(1) = 'Z' ).
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>invalid_namespace
          object_name = object_name.
    ENDIF.
  ENDMETHOD.

  METHOD validate_class.
    IF strlen( object_class ) = 0 OR strlen( object_class ) > 4.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid       = zcx_mcp_auth_object=>class_not_found
          object_class = object_class
          detail       = |{ strlen( object_class ) } chars, max 4|.
    ENDIF.
  ENDMETHOD.

  METHOD validate_fields.
    DATA(lv_count) = lines( fields ).
    IF lv_count > 10.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid     = zcx_mcp_auth_object=>invalid_field
          field_name = |{ lv_count } fields supplied, max 10|.
    ENDIF.
    DATA lt_seen TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    LOOP AT fields INTO DATA(ls_field).
      IF strlen( ls_field-field_name ) = 0 OR strlen( ls_field-field_name ) > 10.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid     = zcx_mcp_auth_object=>invalid_field
            field_name = ls_field-field_name.
      ENDIF.
      INSERT to_upper( ls_field-field_name ) INTO TABLE lt_seen.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid     = zcx_mcp_auth_object=>invalid_field
            field_name = ls_field-field_name
            detail     = |duplicate field { ls_field-field_name }|.
      ENDIF.
      IF to_upper( ls_field-field_name ) <> 'ACTVT'.
        SELECT SINGLE fieldname FROM authx INTO @DATA(lv_fieldname)
          WHERE fieldname = @ls_field-field_name.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE zcx_mcp_auth_object
            EXPORTING
              textid     = zcx_mcp_auth_object=>invalid_field
              field_name = ls_field-field_name.
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate_activities.
    DATA(lv_has_actvt) = xsdbool( line_exists( fields[ field_name = 'ACTVT' ] ) ).

    IF activities IS NOT INITIAL AND lv_has_actvt = abap_false.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>invalid_activity
          object_name = object_name
          detail      = `permitted activities were supplied but the field list does not contain ACTVT`.
    ENDIF.

    DATA lt_seen TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    LOOP AT activities INTO DATA(lv_activity).
      DATA(lv_act) = condense( to_upper( lv_activity ) ).
      IF strlen( lv_act ) = 0 OR strlen( lv_act ) > 2.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid      = zcx_mcp_auth_object=>invalid_activity
            object_name = object_name
            detail      = |activity '{ lv_activity }' must be 1-2 characters (e.g. 02)|.
      ENDIF.
      INSERT lv_act INTO TABLE lt_seen.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid      = zcx_mcp_auth_object=>invalid_activity
            object_name = object_name
            detail      = |activity { lv_act } supplied more than once|.
      ENDIF.
      SELECT SINGLE actvt FROM tact INTO @DATA(lv_tact) WHERE actvt = @lv_act.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid      = zcx_mcp_auth_object=>invalid_activity
            object_name = object_name
            detail      = |activity { lv_act } does not exist in TACT|.
      ENDIF.
    ENDLOOP.

    " SU21 rejects ACTVT without an activity list (CHECK_SUSO, UE 135).
    " On update an existing TACTZ list is reused if none is supplied.
    IF lv_has_actvt = abap_true AND activities IS INITIAL.
      IF is_update = abap_true.
        DATA(lv_objct) = CONV xuobject( to_upper( object_name ) ).
        SELECT SINGLE actvt FROM tactz INTO @DATA(lv_existing) WHERE brobj = @lv_objct.
        IF sy-subrc = 0.
          RETURN.
        ENDIF.
      ENDIF.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>invalid_activity
          object_name = object_name
          detail      = `field ACTVT requires a list of permitted activities (e.g. 02, 03)`.
    ENDIF.
  ENDMETHOD.

  METHOD read_current_fields.
    SELECT SINGLE fiel1, fiel2, fiel3, fiel4, fiel5, fiel6, fiel7, fiel8, fiel9, fiel0
      FROM tobj INTO @DATA(ls_tobj) WHERE objct = @object_name.
    CHECK sy-subrc = 0.
    DO 10 TIMES.
      ASSIGN COMPONENT sy-index OF STRUCTURE ls_tobj TO FIELD-SYMBOL(<lv_field>).
      IF <lv_field> IS NOT INITIAL.
        APPEND VALUE #( field_name = CONV string( <lv_field> ) ) TO result.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD build_field_buffer.
    DATA lv_line TYPE xuline VALUE 0.
    LOOP AT fields INTO DATA(ls_field).
      lv_line = lv_line + 1.
      APPEND VALUE cl_suso_appl=>ts_suso_field_ext(
        objct = object_name
        line  = lv_line
        field = CONV xufield( to_upper( ls_field-field_name ) )
      ) TO result.
    ENDLOOP.
  ENDMETHOD.

  METHOD create_object.

    validate_name( object_name ).
    validate_class( object_class ).
    validate_fields( fields ).
    validate_activities( object_name = object_name fields = fields
                         activities = activities is_update = abap_false ).

    IF object_exists( object_name ) = abap_true.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>already_exists
          object_name = object_name.
    ENDIF.

    DATA(lv_object_name)  = CONV xuobject( to_upper( object_name ) ).
    DATA(lv_object_class) = CONV xuobjclass( to_upper( object_class ) ).

    SELECT SINGLE oclss FROM tobc INTO @DATA(lv_oclss_check) WHERE oclss = @lv_object_class.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid       = zcx_mcp_auth_object=>class_not_found
          object_class = object_class.
    ENDIF.

    DATA lo_appl TYPE REF TO cl_suso_appl.
    CREATE OBJECT lo_appl
      EXPORTING
        id_suso     = ''
        id_actvt    = cl_suso=>gc_create
        id_devclass = devclass
        id_trkorr   = trkorr
      EXCEPTIONS
        object_not_exist   = 1
        action_not_allowed = 2
        OTHERS              = 3.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>permission_denied
          object_name = object_name
          detail      = |constructor(create) rc { sy-subrc }|.
    ENDIF.

    DATA(ls_header) = VALUE cl_suso_appl=>ts_suso_header(
      objct   = lv_object_name
      oclss   = lv_object_class
      objtext = CONV #( description ) ).

    lo_appl->set_data_suso(
      EXPORTING
        is_suso_det_buf = ls_header
        id_suso         = lv_object_name
        id_devclass     = devclass ).

    DATA lv_ret TYPE sy-subrc.
    TRY.
        lv_ret = lo_appl->save_data_suso( id_suso = lv_object_name id_utest = abap_true ).
      CATCH cx_su2n_raise_events INTO DATA(lx_create).
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid      = zcx_mcp_auth_object=>save_failed
            object_name = object_name
            detail      = CONV #( lx_create->get_text( ) )
            previous    = lx_create.
    ENDTRY.
    IF lv_ret <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>save_failed
          object_name = object_name
          detail      = |header save returned { lv_ret }|.
    ENDIF.

    IF fields IS NOT INITIAL.
      attach_fields(
        object_name  = lv_object_name
        object_class = lv_object_class
        description  = CONV #( description )
        fields       = fields
        activities   = activities
        trkorr       = trkorr ).
    ENDIF.

  ENDMETHOD.

  METHOD update_object.

    validate_name( object_name ).
    validate_fields( fields ).

    IF object_exists( object_name ) = abap_false.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>not_found
          object_name = object_name.
    ENDIF.

    DATA(lv_object_name) = CONV xuobject( to_upper( object_name ) ).

    " No field list = keep the current one. It is still passed on to
    " SET_DATA_SUSO: an empty field buffer there returns 8 before the
    " header (description) buffer is applied.
    DATA(lt_fields) = fields.
    IF lt_fields IS INITIAL.
      lt_fields = read_current_fields( lv_object_name ).
    ENDIF.

    validate_activities( object_name = object_name fields = lt_fields
                         activities = activities is_update = abap_true ).

    DATA(lv_description) = CONV tobjt-ttext( description ).
    IF lv_description IS INITIAL.
      SELECT SINGLE ttext FROM tobjt INTO @lv_description
        WHERE object = @lv_object_name AND langu = @sy-langu.
    ENDIF.

    SELECT SINGLE oclss FROM tobj INTO @DATA(lv_oclss) WHERE objct = @lv_object_name.
    IF object_class IS NOT INITIAL.
      validate_class( object_class ).
      lv_oclss = CONV xuobjclass( to_upper( object_class ) ).
      SELECT SINGLE oclss FROM tobc INTO @DATA(lv_oclss_check) WHERE oclss = @lv_oclss.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid       = zcx_mcp_auth_object=>class_not_found
            object_class = object_class.
      ENDIF.
    ENDIF.

    attach_fields(
      object_name  = lv_object_name
      object_class = lv_oclss
      description  = lv_description
      fields       = lt_fields
      activities   = activities
      trkorr       = trkorr ).

  ENDMETHOD.

  METHOD attach_fields.

    DATA lo_appl TYPE REF TO cl_suso_appl.
    CREATE OBJECT lo_appl
      EXPORTING
        id_suso   = object_name
        id_actvt  = cl_suso=>gc_change
        id_trkorr = trkorr
      EXCEPTIONS
        object_not_exist   = 1
        action_not_allowed = 2
        OTHERS              = 3.
    IF sy-subrc = 1.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>not_found
          object_name = CONV #( object_name ).
    ELSEIF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>permission_denied
          object_name = CONV #( object_name )
          detail      = |constructor(change) rc { sy-subrc }|.
    ENDIF.

    " SU21 drops field editing to display-only once the object is used
    " (AUTHORITY-CHECK in code, role authorizations, SE93, DCL) - then
    " SET_DATA_SUSO/SAVE_DATA_SUSO silently skip the TOBJ field slots
    " while still saving header and TACTZ, i.e. "success" with the field
    " list unchanged. Refuse up front instead whenever the requested
    " list actually differs from the current one.
    DATA lv_edit_mode_f TYPE activ_auth.
    lo_appl->get_data_suso( IMPORTING ed_edit_mode_f = lv_edit_mode_f ).
    IF lv_edit_mode_f <> cl_suso=>gc_change AND lv_edit_mode_f <> 'AO'.
      DATA(lt_current) = read_current_fields( object_name ).
      DATA(lv_current)   = concat_lines_of( table = VALUE string_table( FOR c IN lt_current ( to_upper( c-field_name ) ) ) sep = `,` ).
      DATA(lv_requested) = concat_lines_of( table = VALUE string_table( FOR r IN fields ( to_upper( r-field_name ) ) ) sep = `,` ).
      IF fields IS NOT INITIAL AND lv_requested <> lv_current.
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid      = zcx_mcp_auth_object=>field_locked
            object_name = CONV #( object_name )
            detail      = |SU21 allows no field changes (field edit mode { lv_edit_mode_f }) because the object is | &&
                          |already in use: AUTHORITY-CHECK in code, role authorizations, transaction or DCL checks. | &&
                          |Current fields: [{ lv_current }], requested: [{ lv_requested }]. Nothing was saved.|.
      ENDIF.
    ENDIF.

    DATA(ls_header) = VALUE cl_suso_appl=>ts_suso_header(
      objct   = object_name
      oclss   = object_class
      objtext = description ).

    " CL_SUSO_APPL's constructor already loads the current TACTZ rows into
    " its activity buffer, so it_suso_actvt_buf is only supplied when a new
    " list is given - "is supplied" semantics decide whether it replaces.
    DATA lt_actvt TYPE cl_suso_appl=>tt_tactz.
    LOOP AT activities INTO DATA(lv_activity).
      APPEND VALUE tactz( brobj = object_name
                          actvt = CONV activ_auth( condense( to_upper( lv_activity ) ) ) ) TO lt_actvt.
    ENDLOOP.

    DATA lv_set_ret TYPE sy-subrc.
    IF fields IS INITIAL.
      lv_set_ret = lo_appl->set_data_suso(
        is_suso_det_buf = ls_header
        id_suso         = object_name ).
    ELSE.
      DATA(lt_fields) = build_field_buffer( object_name = object_name fields = fields ).
      IF lt_actvt IS INITIAL.
        lv_set_ret = lo_appl->set_data_suso(
          is_suso_det_buf = ls_header
          it_out_fld_buf  = lt_fields
          id_suso         = object_name ).
      ELSE.
        lv_set_ret = lo_appl->set_data_suso(
          is_suso_det_buf  = ls_header
          it_out_fld_buf   = lt_fields
          it_suso_actvt_buf = lt_actvt
          id_suso          = object_name ).
      ENDIF.
    ENDIF.
    IF lv_set_ret <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>save_failed
          object_name = CONV #( object_name )
          detail      = |SET_DATA_SUSO returned { lv_set_ret }|.
    ENDIF.

    DATA lv_ret TYPE sy-subrc.
    TRY.
        lv_ret = lo_appl->save_data_suso( id_suso = object_name id_utest = abap_true ).
      CATCH cx_su2n_raise_events INTO DATA(lx_save).
        RAISE EXCEPTION TYPE zcx_mcp_auth_object
          EXPORTING
            textid      = zcx_mcp_auth_object=>save_failed
            object_name = CONV #( object_name )
            detail      = CONV #( lx_save->get_text( ) )
            previous    = lx_save.
    ENDTRY.
    IF lv_ret <> 0.
      RAISE EXCEPTION TYPE zcx_mcp_auth_object
        EXPORTING
          textid      = zcx_mcp_auth_object=>save_failed
          object_name = CONV #( object_name )
          detail      = |field save returned { lv_ret }|.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
