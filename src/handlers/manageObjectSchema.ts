// Per-resource tool definitions of the ManageObject dispatcher, moved verbatim from
// the former standalone tools. manageObjectTool merges them into one schema.

const auth_object: any = {
  name: 'ManageAuthObject',
  description: 'Create or update a custom SU21 authorization object: its class, description, up to 10 fields, and the permitted activities for ACTVT. Runs through the custom endpoint /zaimcp/auth_object, because SU21 has no ADT API. No delete. update changes only what you pass and keeps the rest. Input is validated before anything is saved. Once the object is in use (an AUTHORITY-CHECK in code, roles, transactions or DCL), SU21 locks its field list: field changes are refused with 409 and nothing is saved, while class, description and activities can still change. To change the fields, first remove that usage; there is no bypass.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '"create" or "update".',
        enum: ['create', 'update']
      },
      object_name: {
        type: 'string',
        description: 'e.g. "Z_CO_IMG". Y/Z namespace, max 10 characters.'
      },
      object_class: {
        type: 'string',
        description: 'An existing object class, e.g. "FI", "ZFI" (max 4 chars). Required on create; optional on update to change the class.'
      },
      description: {
        type: 'string',
        description: 'Required on create; optional on update.'
      },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field_name: { type: 'string', description: 'An existing SU20 field, e.g. "BUKRS", "ACTVT". Max 10 characters.' },
            permitted_activities: {
              type: 'array',
              items: { type: 'string' },
              description: 'ACTVT entry only, e.g. ["02","03"] (codes from TACT). Required on create; on update, omit to keep the current list or give one to replace it.'
            }
          },
          required: ['field_name']
        },
        description: 'Up to 10 entries. On update this replaces the whole field list; omit it to keep the current fields.'
      },
      package_name: {
        type: 'string',
        description: 'Package, required on create.'
      },
      transport_number: {
        type: 'string',
        description: 'Optional. If omitted, SAP uses the open request that already holds the object.'
      }
    },
    required: ['action', 'object_name']
  }
};

const message_class: any = {
  name: 'ManageMessageClass',
  description: 'Create, update or delete an ABAP message class (SE91) and its messages via the native ADT contract. Read messages with GetMeta resource=MESSAGE_CLASS (optional `language` reads a translation). action=create: description + package_name required, optional initial messages. action=update: messages are inserted or overwritten by number in ONE language (all other messages and languages untouched) — the class\'s master language by default, or `language` (ISO, e.g. EN) to write a translation of messages that exist in the master; delete_messages removes individual messages in all languages; replace_all=true makes messages the complete new list (every other message is deleted); description optionally renames. action=delete: deletes the whole message class. create outside $TMP needs transport_number or transport_description; update/delete without transport_number reuse the request the class is already in; a transport differing from that one is refused. Message long texts cannot be written (ADT exposes no long-text write on this release) — maintain them in SE91; this tool never deletes an existing long text.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'create, update or delete' },
      message_class: { type: 'string', description: 'Message class name, customer namespace (Z*/Y*), max 20 characters. Example: ZSD_MESSAGES' },
      description: { type: 'string', description: 'Short text, max 60 characters. Required for create; optional on update (renames).' },
      package_name: { type: 'string', description: 'create only (required). Package, e.g. $TMP or ZSD. Also the DEVCLASS for transport_description.' },
      messages: {
        type: 'array',
        description: 'create/update. Messages to write; on update each is inserted or overwritten by number.',
        items: {
          type: 'object',
          properties: {
            number: { type: 'string', description: 'Message number 000-999 (e.g. "001" or 1)' },
            text: { type: 'string', description: 'Message text, max 73 characters. Use &1..&4 (or &) as placeholders.' },
            self_explanatory: { type: 'boolean', description: 'SE91 "Self-Explanatory" flag. New messages default to true; when overwriting an existing message, omitting it keeps the current flag.' }
          },
          required: ['number', 'text']
        }
      },
      language: { type: 'string', description: 'Optional 2-character ISO language code (EN, DE, ZF, ...) the message texts are written in. Default: the class\'s master language (T100A). A different language writes a translation; the message must already exist in the master language. On create it sets the master language (default EN).' },
      delete_messages: { type: 'array', items: { type: 'string' }, description: 'update only. Message numbers to delete (e.g. ["001","010"]). Deletes the message in ALL languages, with its long text. Every number must exist, otherwise nothing is changed. Not combinable with a translation `language`.' },
      replace_all: { type: 'boolean', description: 'update only. true = messages is the complete new list; every existing message not in it is deleted. Default false (upsert). Not combinable with delete_messages.' },
      transport_number: { type: 'string', description: 'Transport request/task. Required for create outside $TMP unless transport_description is given; on update/delete it may be omitted to reuse the request the class is already in.' },
      transport_description: { type: 'string', description: 'Creates a new transport with this description (max 60 chars) instead of transport_number. Needs package_name.' }
    },
    required: ['action', 'message_class']
  }
};

const package_def: any = {
  name: 'ManagePackage',
  description: 'Create or update an ABAP package (DEVC) over the native ADT package contract. action=create: package_name, description (<=60), software_component (default LOCAL for $ packages), transport_number (required unless $), optional super_package, responsible (default: the connection user), package_type (development|structure|main), transport_layer, application_component, record_changes. action=update: changes only the fields you pass (description, software_component, transport_layer, application_component, super_package) via lock -> PUT -> unlock; refuses to move the package into a different request. Delete a package with DeleteObject.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update'] },
      package_name: { type: 'string', description: 'Z*/Y*/$*/namespaced, max 30 chars.' },
      description: { type: 'string' },
      software_component: { type: 'string' },
      transport_layer: { type: 'string' },
      application_component: { type: 'string' },
      super_package: { type: 'string' },
      package_type: { type: 'string', enum: ['development', 'structure', 'main'] },
      master_language: { type: 'string', description: 'Default EN.' },
      responsible: { type: 'string' },
      record_changes: { type: 'boolean' },
      transport_number: { type: 'string', description: 'Change request for a transportable package.' }
    },
    required: ['action', 'package_name']
  }
};

const transaction: any = {
  name: 'ManageTransaction',
  description: 'Create, update or delete a custom transaction code (SE93): dialog (screen) or report transaction in the Y/Z namespace. Runs through the custom endpoint /zaimcp/transaction, because ADT can only read transactions. create needs program, description, package and, for a dialog transaction, the screen number. update changes only what you pass (program, screen, description, GUI flags) and keeps the rest. delete removes the transaction and its authorization defaults; roles that still list it are not touched. Parameter and variant transactions are not supported. Pass transport_number for a transportable package; omit it to let SAP use the open request that already holds the object.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '"create", "update" or "delete".', enum: ['create', 'update', 'delete'] },
      transaction_name: { type: 'string', description: 'e.g. "ZMM_STOCK". Y/Z namespace, max 20 characters.' },
      program_name: { type: 'string', description: 'Existing program to start. Required on create; on update it repoints the transaction.' },
      screen_number: { type: 'string', description: 'Start screen, e.g. "0100". Required on create for a dialog transaction; ignored for a report transaction.' },
      description: { type: 'string', description: 'Short text. Required on create; on update it replaces the text in the logon language.' },
      transaction_type: { type: 'string', description: '"D" dialog (default) or "R" report. Create only.', enum: ['D', 'R'] },
      package_name: { type: 'string', description: 'Package, required on create.' },
      transport_number: { type: 'string', description: 'Optional. If omitted, SAP uses the open request that already holds the object.' },
      web_gui: { type: 'boolean', description: 'SAP GUI for HTML allowed. On update, false switches it off.' },
      java_gui: { type: 'boolean', description: 'SAP GUI for Java allowed.' },
      win_gui: { type: 'boolean', description: 'SAP GUI for Windows allowed.' }
    },
    required: ['action', 'transaction_name']
  }
};

const PARTS: Record<string, any> = {
    AUTH_OBJECT: auth_object,
    MESSAGE_CLASS: message_class,
    PACKAGE: package_def,
    TRANSACTION: transaction
};

export const MANAGE_OBJECT_RESOURCES = Object.keys(PARTS);

function merge(): Record<string, any> {
    const byName: Record<string, Array<[string, any]>> = {};
    for (const [res, tool] of Object.entries(PARTS)) {
        for (const [prop, def] of Object.entries<any>(tool.inputSchema.properties)) {
            (byName[prop] ??= []).push([res, def]);
        }
    }
    const props: Record<string, any> = {};
    for (const [prop, defs] of Object.entries(byName)) {
        const merged: any = { ...defs[0][1] };
        const enums = defs.flatMap(([, d]) => d.enum ?? []);
        if (enums.length) merged.enum = [...new Set(enums)];
        // Shared names (action, description, package_name, ...) keep one shape and
        // say per resource what they mean; a name used by one resource is tagged too.
        const texted = defs.filter(([, d]) => d.description);
        merged.description = texted.length
            ? texted.map(([res, d]) => `[${res}] ${d.description}`).join(' ')
            : `[${defs.map(([res]) => res).join(', ')}]`;
        // A resource that gives no text for a shared name is still listed as using it.
        const silent = defs.filter(([, d]) => !d.description).map(([res]) => res);
        if (texted.length && silent.length) merged.description += ` (${silent.join(', ')}: ${defs.length === 1 ? '' : 'as above'})`.replace(': )', ')');
        props[prop] = merged;
    }
    return props;
}

export const manageObjectTool = {
    name: 'ManageObject',
    description:
        'Create, update or delete a SAP object chosen by `resource`: ' + MANAGE_OBJECT_RESOURCES.join(', ') +
        '. Every other parameter is the one the resource documents; a parameter tagged [RESOURCE] applies to that resource only. ' +
        MANAGE_OBJECT_RESOURCES.map(r => `${r}: ${PARTS[r].description}`).join(' || '),
    inputSchema: {
        type: 'object',
        properties: {
            resource: {
                type: 'string',
                description: 'Which object kind to maintain.',
                enum: MANAGE_OBJECT_RESOURCES
            },
            ...merge()
        },
        required: ['resource', 'action']
    }
};
