#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

// Import handler functions
import { handleSearchObject } from './handlers/handleSearchObject';
import { handleDataPreview } from './handlers/handleDataPreview';
import { handleManageTransport } from './handlers/handleManageTransport';
import { handleManageDDIC } from './handlers/handleManageDDIC';
import { handleManageDynpro } from './handlers/handleManageDynpro';
import { handleManageMessageClass } from './handlers/handleManageMessageClass';
import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleGetCode } from './handlers/handleGetCode';
import { handleGetDiagnostics } from './handlers/handleGetDiagnostics';
import { handleGetMeta } from './handlers/handleGetMeta';
import { handleActivateObjects } from './handlers/handleActivateObjects';
import { handleRunATCCheck } from './handlers/handleRunATCCheck';
import { handleRunUnitTest } from './handlers/handleRunUnitTest';
import { handleUnlockObject } from './handlers/handleUnlockObject';
import { handleRunABAP } from './handlers/handleRunABAP';
import { handleManagePackage } from './handlers/handleManagePackage';
import { handleManageSessions } from './handlers/handleManageSessions';
import { handleDeleteObject } from './handlers/handleDeleteObject';
import { handleTextPoolLang } from './handlers/handleTextPoolLang';
import { handleManageSicfNode } from './handlers/handleManageSicfNode';
import { handleManageAuthObject } from './handlers/handleManageAuthObject';
import { backgroundSchemaProps } from './lib/background';

// Import shared utility functions and types
import { getBaseUrl, getAuthHeaders, createAxiosInstance, makeAdtRequest, return_error, return_response } from './lib/utils';
import { captureRealEnv, resolveSecret, describeResolution } from './lib/secretStore';

// SAP connection settings, in resolution-tier order: real process env > secrets
// keystore (opt-in, see SECRETS_KEYSTORE below) > .env file. captureRealEnv()
// must run BEFORE dotenv.config() below fills in process.env from .env, or the
// two lower tiers become indistinguishable — see lib/secretStore.ts.
const SAP_CONFIG_KEYS = ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'SAP_CLIENT', 'SAP_LANGUAGE'];
captureRealEnv(SAP_CONFIG_KEYS);

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Interface for SAP configuration
export interface SapConfig {
  url: string;
  username: string;
  password: string;
  client: string;
  language?: string;
}

/**
 * Retrieves SAP configuration via the process env / keystore / .env resolution
 * order (see lib/secretStore.ts). Fails loudly and synchronously so a missing
 * credential is impossible to miss at startup, rather than surfacing as an
 * opaque downstream error on first tool call.
 *
 * @returns {SapConfig} The SAP configuration object.
 * @throws {Error} If any required credential is missing from every tier.
 */
export function getConfig(): SapConfig {
  const url = resolveSecret('SAP_URL');
  const username = resolveSecret('SAP_USERNAME');
  const password = resolveSecret('SAP_PASSWORD');
  const client = resolveSecret('SAP_CLIENT');
  const language = resolveSecret('SAP_LANGUAGE'); // optional logon language (e.g. EN, DE)

  const required: [string, string | undefined][] = [
    ['SAP_URL', url], ['SAP_USERNAME', username], ['SAP_PASSWORD', password], ['SAP_CLIENT', client]
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    const ksPath = process.env.SECRETS_KEYSTORE;
    const diagnostic = required.map(([k]) => `- ${k}: ${describeResolution(k)}`).join('\n');
    throw new Error(`Missing required SAP credential(s): ${missing.join(', ')}.
Checked, in order: process environment -> ${ksPath ? `keystore (${ksPath})` : 'keystore (not configured)'} -> .env file.
${diagnostic}
Fix: set the missing variable(s) directly, run node scripts/setup-secrets.js, or create .env from .env.example.`);
  }

  return { url: url!, username: username!, password: password!, client: client!, language };
}

/**
 * Server class for interacting with ABAP systems via ADT.
 */
function serverVersion(): string {
  // dist/index.js sits next to package.json's directory; fall back rather than fail startup
  try {
    return JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch (_e) {
    return 'unknown';
  }
}

export class mcp_abap_adt_server {
  private server: Server;  // Instance of the MCP server
  private sapConfig: SapConfig; // SAP configuration

  /**
   * Constructor for the mcp_abap_adt_server class.
   */
  constructor() {
    this.sapConfig = getConfig(); // Load SAP configuration
    this.server = new Server(  // Initialize the MCP server
      {
        name: 'mcp-abap-adt', // Server name
        version: serverVersion(),
      },
      {
        capabilities: {
          tools: {}, // Initially, no tools are registered
        },
      }
    );

    this.setupHandlers(); // Setup request handlers
  }

  /**
   * Sets up request handlers for listing and calling tools.
   * @private
   */
  private setupHandlers() {
    // Setup tool handlers

    // Handler for ListToolsRequest
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [ // Define available tools
          {
            name: 'GetCode',
            description: 'Unified getter for ABAP source-related information, selected via the "resource" param. resource=OBJECT: unified getter for source-bearing objects — auto-detects the kind (program, class, interface, include, table, structure, function group, function module, data element, domain, CDS view) via search and returns the source (object_name required; optional kind hint PROG|CLAS|INTF|INCL|TABL|STRU|VIEW|FUGR|FUNC|DTEL|DOMA|CDS; optional function_group when kind=FUNC; a function module also gets a second line with its attributes — processing type normal/RFC/update, last changed at/by — which output_file does not write, so a saved file stays pure source). resource=VERSION: version history, source retrieval, and version compare (object_name + object_type required; no version/compare_to lists all saved versions; with version returns source at that version; with compare_to returns a unified diff from compare_to (baseline) to version (target, defaults to active); for a class, list mode shows every include (main/local classes/test classes…) and class_include picks the include for version/compare_to; local objects keep one SAP version, so the pre-write snapshots WriteProgram keeps are listed and usable as version=snapshot:<id>|snapshot:latest or compare_to=snapshot:<id>). resource=ENHANCEMENTS: retrieve ABAP enhancements attached to an object, or scan a function group\'s includes (object_name required; optional with_source default true, scan_all default false, max_includes default 100 for function groups). resource=WHEREUSED: find all references to an object across the system (object_name + object_type required; optional max_results default 100, offset for paging — full list cached in-memory for a few minutes). resource=SYNTAX: ADT syntax check of an EXISTING object\'s current source (inactive working version if there is one) — object_name required, optional object_type, max_messages default 20; read-only, nothing locked or written; returns E/W with line:col (use WriteProgram check_only to check NEW source instead; an include is checked in its master program\'s context, and the output names that program). resource=DYNPRO: classic SAP GUI screens (Dynpro) of a program — object_name = the program (for a function group use SAPL<group>); without dynnr lists its screens (number, type, description; max_results/offset paging); with dynnr returns that screen\'s attributes, elements and flow logic (raw=true returns the complete round-trippable JSON definition instead — large, consider output_file).',
            inputSchema: {
              type: 'object',
              properties: {
                resource: {
                  type: 'string',
                  enum: ['OBJECT', 'VERSION', 'ENHANCEMENTS', 'WHEREUSED', 'DYNPRO', 'SYNTAX'],
                  description: 'Which getter to invoke. See tool description for the fields each one uses.'
                },
                object_name: {
                  type: 'string',
                  description: 'Name of the ABAP object. Used by OBJECT, VERSION, ENHANCEMENTS, WHEREUSED, DYNPRO (the program owning the screens). Examples: ZMY_PROGRAM, ZCL_MY_CLASS, ZIF_MY_INTERFACE, ZMY_INCLUDE, VBAK, BAPI_TE_AUFKX, ZMY_FG, ZMY_FM, MATNR, ZPROD_BATCH'
                },
                objects: {
                  type: 'array',
                  description: 'OBJECT only. Batch read: up to 10 objects in ONE call, fetched in parallel — each entry is a name or { object_name, kind?, function_group? }. Use instead of object_name. Output is one "===== NAME =====" section per object; a failing object is reported in place and does not hide the others. Other top-level args apply to every entry.',
                  items: {
                    anyOf: [
                      { type: 'string' },
                      { type: 'object', properties: { object_name: { type: 'string' }, kind: { type: 'string' }, function_group: { type: 'string' } }, required: ['object_name'] }
                    ]
                  },
                  maxItems: 10
                },
                kind: {
                  type: 'string',
                  description: 'OBJECT only. Optional explicit kind hint to skip auto-detect. Values: PROG, CLAS, INTF, INCL, TABL, STRU, VIEW, FUGR, FUNC, DTEL, DOMA, CDS'
                },
                text_elements: {
                  description: 'OBJECT only, programs (PROG/P). true (default): the source followed by its text symbols, selection texts and list headings as "* ─── … ───" comment blocks appended. false: the source ONLY — clean text to patch, diff or write back. "only": just the text elements, as the bare blocks WriteProgram takes in text_symbols / selection_texts / list_headings (use with false to clone a program in two reads).',
                  oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['only'] }]
                },
                function_group: {
                  type: 'string',
                  description: 'OBJECT only, and only relevant when kind=FUNC. The function group containing the function module. If omitted, it is auto-resolved via search — a function module\'s package (DEVCLASS) is NOT its function group, so only pass this when you already know the exact group.'
                },
                object_type: {
                  type: 'string',
                  description: 'VERSION and WHEREUSED (both required). VERSION: type code of the object — PROG, CLAS, INTF, FUGR, INCL, TABL, DTEL, DOMA, DDLS, DEVC. WHEREUSED: type of the object, e.g. CLAS, PROG, FUGR, INTF.'
                },
                version: {
                  type: 'string',
                  description: 'VERSION only. Optional. Version identifier (e.g. a transport like DEVK900123, or "active"). Omit to list all versions first. In compare mode this is the target; defaults to the active source.'
                },
                class_include: {
                  type: 'string',
                  enum: ['main', 'definitions', 'implementations', 'macros', 'testclasses'],
                  description: 'VERSION (object_type=CLAS) and OBJECT (a class): which part of the class: main (global class, default), definitions (local types), implementations (local classes), macros, testclasses (local test classes). With resource=OBJECT, a value other than main returns the source of that local include as stored (the read twin of WriteProgram class_include). For VERSION a class keeps one history per part. Without version/compare_to and without class_include, every part\'s history is listed.'
                },
                compare_to: {
                  type: 'string',
                  description: 'VERSION only. Optional. Baseline version id to diff against. When set, returns a unified diff from compare_to → version (or → active if version omitted). Get version ids from list mode.'
                },
                with_source: {
                  type: 'boolean',
                  description: 'ENHANCEMENTS only. Include enhancement source code in the response. Default: true.',
                  default: true
                },
                scan_all: {
                  type: 'boolean',
                  description: 'ENHANCEMENTS only, for function groups: when true, scan every include in the group and aggregate enhancements. Slow on large function groups. Default: false (lists includes instead).',
                  default: false
                },
                max_includes: {
                  type: 'number',
                  description: 'ENHANCEMENTS only, for function groups with scan_all=true: maximum number of includes to scan. Default: 100. Raise to scan more (slower).',
                  default: 100
                },
                max_results: {
                  type: 'number',
                  description: 'WHEREUSED, and DYNPRO list mode. Maximum number of results to return',
                  default: 100
                },
                offset: {
                  type: 'number',
                  description: 'WHEREUSED, and DYNPRO list mode. Optional. Number of entries to skip before applying max_results, for paging through a widely-used object. Served from the short-lived in-memory cache (~3 min) when possible — no repeat SAP call.',
                  default: 0
                },
                dynnr: {
                  type: 'string',
                  description: 'DYNPRO only. Optional. Screen number, e.g. "0100" (leading zeros optional). Omit to list all screens of the program.'
                },
                language: {
                  type: 'string',
                  description: 'DYNPRO only, with dynnr. Instead of the screen definition, list its translatable element texts for this target language (SAP key M, ISO ZF or LXE zhTW): element, maximum length, master-language text and current target text, "(missing)" where none exists. Read-only; write with ManageDynpro action=translate.'
                },
                raw: {
                  type: 'boolean',
                  description: 'DYNPRO only, with dynnr. Return the complete screen definition as JSON (RPY_DYNPRO_READ external format: header, containers, fields_to_containers, flow_logic, params) instead of the readable summary. This is the shape ManageDynpro will accept for writes. Large (a 33-element screen is ~35 KB): with output_file the JSON goes ONLY to the file and the reply is just the path and size — pass that file to ManageDynpro definition_file.',
                  default: false
                },
                ...backgroundSchemaProps
              },
              required: ['resource']  // object_name is checked per resource in handleGetCode (OBJECT may use objects[] instead)
            }
          },
          {
            name: 'SearchObject',
            description: 'Search for ABAP objects using quick search. No pagination is available — narrow results with a tighter query wildcard or the object_type filter, or raise maxResults to widen the top-N window.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query string (use * wildcard for partial match)'
                },
                object_type: {
                  type: 'string',
                  description: 'Optional server-side type filter. Accepts the broad group code (e.g. CLAS, PROG, INTF, TABL, FUGR) or the full subtype (e.g. CLAS/OC, PROG/P). Single type only — comma-separated lists are not supported.'
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of results to return (top-N window; no server ceiling, but large values produce large output). Default 100.',
                  default: 100
                }
              },
              required: ['query']
            }
          },
          {
            name: 'DataPreview',
            description: 'ADT data preview with intelligent multi-endpoint fallback. Preview table/view/CDS data. Supports simple table preview or advanced SQL queries.',
            inputSchema: {
              type: 'object',
              properties: {
                table_name: {
                  type: 'string',
                  description: 'Name of the table, view, or CDS to preview. Examples: VBAK (Sales Orders), MARA (Materials), KNA1 (Customers), I_SalesDocument (CDS View)'
                },
                ddicEntityName: {
                  type: 'string',
                  description: 'Alternative parameter name for table_name (for compatibility)'
                },
                max_rows: {
                  type: 'number',
                  description: 'Maximum number of rows to retrieve. Default: 100. Range: 1-9999',
                  default: 100
                },
                rowNumber: {
                  type: 'number',
                  description: 'Alternative parameter for max_rows (for ADT compatibility)'
                },
                query: {
                  type: 'string',
                  description: 'Custom SQL SELECT statement for advanced filtering. Example: "SELECT VBELN, ERDAT, NETWR FROM VBAK WHERE ERDAT > \'20240101\' AND NETWR > 1000". When using query parameter, table_name is ignored.'
                },
                ...backgroundSchemaProps
              }
            }
          },
          {
            name: 'GetDiagnostics',
            description: 'Unified getter for runtime diagnostics, selected via the "resource" param. resource=DUMP: runtime errors (short dumps) — dual mode: WITHOUT dump_id, lists dumps (filter by user/category/date); WITH dump_id, drills into one dump and returns the concise human-readable summary. resource=TRACE: ABAP runtime traces (SAT/SQL performance traces) — dual mode: WITHOUT trace_id, lists traces (filter by user/object); WITH trace_id, drills into one trace and returns its details plus the hit list of most-executed statements. Traces are per-user; pass user=\'*\' to list all users. resource=GW_ERRORLOG: SAP Gateway (OData/Fiori) error log — dual mode: WITHOUT entry_id, lists the current buffer of recent Backend/Client service errors system-wide (SAP ignores filter/paging params here, always returns everything currently buffered); WITH entry_id, returns full diagnostic detail (header/service/context/source/stack) for one entry.',
            inputSchema: {
              type: 'object',
              properties: {
                resource: {
                  type: 'string',
                  enum: ['DUMP', 'TRACE', 'GW_ERRORLOG'],
                  description: 'Which diagnostics getter to invoke.'
                },
                dump_id: {
                  type: 'string',
                  description: 'DUMP detail mode. The dump identifier from a prior list call. Accepts the Dump ID path shown in the list, the bare id, or a self-link. When set, user/category/date/maxResults are ignored.'
                },
                type: {
                  type: 'string',
                  description: 'DUMP detail mode only. Default "summary" (readable). Other values: formatted (full ~1MB), unformatted (~2MB), hitlist, dbAccesses, statements, metadata (XML chapter index + links).'
                },
                category: {
                  type: 'string',
                  description: 'DUMP list mode. Filter dumps by category'
                },
                fromDate: {
                  type: 'string',
                  description: 'DUMP list mode. Start date for filtering (format: YYYYMMDD)'
                },
                toDate: {
                  type: 'string',
                  description: 'DUMP list mode. End date for filtering (format: YYYYMMDD)'
                },
                maxResults: {
                  type: 'number',
                  description: 'DUMP list mode. Maximum number of results to return',
                  default: 100
                },
                trace_id: {
                  type: 'string',
                  description: 'TRACE detail mode. The trace identifier from a prior list call (bare id or self-link path). When set, user/object_name/max_results are ignored.'
                },
                entry_id: {
                  type: 'string',
                  description: 'GW_ERRORLOG detail mode. The entry id from a prior list call (e.g. "BackendError/005056AD..."). The buffer is short-lived — an id from an old list call may no longer be present.'
                },
                top: {
                  type: 'number',
                  description: 'TRACE detail mode only. Number of hit-list rows (by gross time) to return. Default: 20.',
                  default: 20
                },
                user: {
                  type: 'string',
                  description: 'List mode (DUMP or TRACE). Filter by user. For TRACE, use \'*\' for all users; defaults to the logon user.'
                },
                object_name: {
                  type: 'string',
                  description: 'TRACE list mode. Filter traces by traced object name.'
                },
                max_results: {
                  type: 'number',
                  description: 'TRACE list mode. Maximum number of traces to return. Default: 50.',
                  default: 50
                },
                offset: {
                  type: 'number',
                  description: 'List mode (DUMP or TRACE). Optional. Number of entries to skip before applying the results limit, for paging. The full list (post-filter) is cached in-memory for a few minutes, so a follow-up call with a different offset is served without re-querying SAP.',
                  default: 0
                },
                ...backgroundSchemaProps
              },
              required: ['resource']
            }
          },
          {
            name: 'GetMeta',
            description: 'Unified getter for ABAP object/system metadata, selected via the "resource" param. resource=PACKAGE: package details (objects grouped by type); package_name required; full list cached in-memory for paging with offset. resource=TYPEINFO: ABAP type information; type_name required. resource=TRANSACTION: transaction details; transaction_name required. resource=TRANSPORT: list or inspect CTS transport requests; without transport_number lists the given/configured user\'s transports, with transport_number returns full details including tasks and object list. resource=MESSAGE_CLASS: message class texts; message_class required; optional language (ISO, e.g. ZF) reads the texts in that language and the true master language is shown. resource=DDIC: DDIC object definitions (CDS views, data elements, domains); object_type (CDS|DATA_ELEMENT|DOMAIN) + name required. resource=INACTIVE_OBJECTS: lists objects the connection\'s own SAP user currently has inactive (written but not yet activated) — no params.',
            inputSchema: {
              type: 'object',
              properties: {
                resource: {
                  type: 'string',
                  enum: ['PACKAGE', 'TYPEINFO', 'TRANSACTION', 'TRANSPORT', 'MESSAGE_CLASS', 'DDIC', 'INACTIVE_OBJECTS'],
                  description: 'Which metadata getter to invoke.'
                },
                package_name: {
                  type: 'string',
                  description: 'PACKAGE only (required). Name of the ABAP package'
                },
                type_name: {
                  type: 'string',
                  description: 'TYPEINFO only (required). Name of the ABAP type'
                },
                transaction_name: {
                  type: 'string',
                  description: 'TRANSACTION only (required). Name of the ABAP transaction'
                },
                object_name: {
                  type: 'string',
                  description: 'TRANSPORT only (optional). With it, answers "which change request holds this object?" instead of listing: read-only ADT transportchecks, NO lock (safe on a colleague\'s object). Verdict LOCAL / FREE / HELD_BY_SELF / HELD_BY_OTHER, with the holder\'s request, task and owner, or your own open requests when free. Use this as the check before WriteProgram/DeleteObject; do not probe with UnlockObject.'
                },
                type_hint: {
                  type: 'string',
                  description: 'TRANSPORT + object_name only (optional). Disambiguates a name shared by several object types (PROG, CLAS, INTF, FUGR/FF, TABL, ...).'
                },
                transport_number: {
                  type: 'string',
                  description: 'TRANSPORT only. Optional. Transport request number (e.g. DEVK900123). Omit to list all user transports.'
                },
                user: {
                  type: 'string',
                  description: 'TRANSPORT only. Optional. SAP username whose transports to list (e.g. DEVUSER). Defaults to the configured SAP_USERNAME.'
                },
                language: {
                  type: 'string',
                  description: 'MESSAGE_CLASS only (optional). 2-character ISO language (EN, DE, ZF, ...) to read the message texts in. Default: the logon language. Refused if SAP cannot answer in it or holds no texts in it.'
                },
                message_class: {
                  type: 'string',
                  description: 'MESSAGE_CLASS only (required). Name of the message class. Examples: 00 (General), SABAPDOCU (ABAP Docs), /IWBEP/CM_MGW_RT (Gateway), ZM* (Custom)'
                },
                object_type: {
                  type: 'string',
                  enum: ['CDS', 'DATA_ELEMENT', 'DOMAIN'],
                  description: 'DDIC only (required). Type of DDIC object: CDS (Core Data Services view), DATA_ELEMENT (field label/domain ref), DOMAIN (data type/fixed values)'
                },
                name: {
                  type: 'string',
                  description: 'DDIC only (required). Object name. CDS examples: I_SalesDocument, I_MaterialStock. Data element examples: MATNR, KUNNR, VBELN. Domain examples: CHAR10, CURR, DATS, XFELD'
                },
                max_results: {
                  type: 'number',
                  description: 'PACKAGE, TRANSPORT or MESSAGE_CLASS list mode. Maximum number of objects/transports/messages to list (default 200 for PACKAGE and MESSAGE_CLASS, 100 for TRANSPORT). Output flags when truncated.'
                },
                offset: {
                  type: 'number',
                  description: 'PACKAGE, TRANSPORT or MESSAGE_CLASS list mode. Optional. Number of entries to skip before applying max_results, for paging. Served from the short-lived in-memory cache (~3 min) when possible — no repeat SAP call.',
                  default: 0
                },
                ...backgroundSchemaProps
              },
              required: ['resource']
            }
          },
          {
            name: 'ManageTransport',
            description: 'Bound to THIS gateway\'s one connected dev system+client — use it for an ABAP object\'s own transport while editing code here (WriteProgram/ActivateObjects). Create, release, rename, delete, or assign objects to SAP CTS transport requests. action=create: create a new workbench transport (object_url may reference an object that does not exist yet — SAP derives the transport layer purely from dev_class + the URL shape; or pass object_type + object_name to build that path automatically instead of hand-constructing object_url, e.g. to give a brand-new object a proper transport description up front instead of letting WriteProgram auto-generate one). SAP creates the CR and a task in it as one step automatically — the response reports that task number for confirmation. action=release: release an existing transport. action=assign_object: add an ABAP object to a transport (only works for the 9 source-bearing/DDIC types in TYPE_PREFIX — PROG/CLAS/INTF/FUGR/INCL/TABL/DTEL/DOMA/DDLS — via a lock+PUT+unlock cycle on the object\'s own /source/main). action=set_text: rename an unreleased transport\'s description (SAP refuses this once released — fix it before releasing); automatically re-reads and re-sends the transport\'s current CTS target so the rename cannot silently clear it (pass `target` explicitly only to repair a transport whose CTS target was already cleared, e.g. target="/ZABC/"). action=delete: delete an unreleased transport (e.g. to discard one auto-generated with a bad description and recreate it with set_text/create instead). action=add_task: add an additional task to an existing transport for a different SAP user (e.g. a second developer needing their own task on a shared CR) — SAP\'s own task from action=create already covers the connecting user, so this is only for extra developers, not needed on every create. action=move_object: reassign ANY repository object (not limited to assign_object\'s 9 types — any R3TR/LIMU type CTS tracks, e.g. FUGR function modules, packages) to a different task or request directly, via a standalone bridge (default_host/zmcp/transport_admin, wrapping the headless SAP CTS API CTS_WBO_API_INSERT_OBJECTS) rather than a fake source PUT — accepts a bare task number, not just a request number. Fails clearly (never forces) if the object is currently locked elsewhere. action=merge: moves every object out of from_transport into to_transport (one move_object call per object) and, only if every single move succeeded, deletes the now-empty from_transport — reuses action=delete\'s own safety net, so a partial failure leaves from_transport in place rather than silently losing track of an object. action=remove_object: removes a locked object ENTRY from a transport/task without touching the underlying repository object — the fix for a transport permanently stuck refusing action=delete with "contains locked objects" after the object itself was already deleted elsewhere (DeleteObject leaves a deletion-record entry behind; the object being gone does not clear it). No ADT REST endpoint reaches this on this SAP release — the advertised "removeobject" HATEOAS link on a transport\'s own object entry is registered but never actually dispatched by SAP\'s own backend class, confirmed by reading its dispatch source directly. Goes through the same standalone bridge as move_object (default_host/zmcp/transport_admin), wrapping TR_DELETE_COMM_OBJECT_KEYS — the same FM SAP\'s own CTS REST API uses internally for this, and the engine behind SE01/SE09\'s own object-list right-click "Delete Object" feature.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description: 'Operation to perform. Values: create, release, assign_object, set_text, delete, add_task, move_object, merge, remove_object'
                },
                description: {
                  type: 'string',
                  description: 'Transport description text. Required for action=create and action=set_text. Maximum 60 characters (SAP field limit — longer values are rejected).',
                  maxLength: 60
                },
                object_url: {
                  type: 'string',
                  description: 'ADT object URI path without host. For action=create, either this or object_type+object_name is required. The referenced object does NOT need to exist yet. Example: /sap/bc/adt/oo/classes/ZCL_MY_CLASS'
                },
                dev_class: {
                  type: 'string',
                  description: 'Development package (DEVCLASS). Required for action=create. Example: ZMYPACKAGE'
                },
                force_new: {
                  type: 'boolean',
                  description: 'action=create only. One change request per goal: by default create is REFUSED when the object is already in a CR, a colleague\'s CR holds it, or you already have an open CR (the refusal names the CR to use). true opens a separate CR anyway.'
                },
                transport_number: {
                  type: 'string',
                  description: 'Transport request number. Required for action=release, action=assign_object, action=set_text, action=delete, and action=add_task. For action=move_object, this is the MOVE TARGET — a task or request number (both accepted). For action=remove_object, this is the task/request CURRENTLY holding the object entry to remove. Example: DEVK900123'
                },
                pgmid: {
                  type: 'string',
                  description: 'action=move_object and action=remove_object only. Optional, defaults to "R3TR" (the vast majority of objects). Use "LIMU" for sub-objects tracked under a container, most commonly a function module (pgmid=LIMU, object_type=FUNC).'
                },
                from_transport: {
                  type: 'string',
                  description: 'action=merge only (required). The transport whose objects all get moved out, then (if every move succeeded) deleted.'
                },
                to_transport: {
                  type: 'string',
                  description: 'action=merge only (required). The transport every object from from_transport gets moved into. Must differ from from_transport.'
                },
                task_user: {
                  type: 'string',
                  description: 'Optional. SAP username the new task is created for. Used by action=add_task only (action=create relies on the task SAP already attaches to the request for the connecting user — use add_task to give a different developer their own task on the same CR). Defaults to the configured SAP_USERNAME.'
                },
                ignore_locks: {
                  type: 'boolean',
                  description: 'For action=release: if true, release ignoring existing locks (relwithignlock). Default: false.'
                },
                object_name: {
                  type: 'string',
                  description: 'ABAP object name. Required for action=assign_object, action=move_object, and action=remove_object. For action=create, an alternative to object_url — combined with object_type to build the object URI (object need not exist yet). Example: ZCL_MY_CLASS'
                },
                object_type: {
                  type: 'string',
                  description: 'Object type code. Required for action=assign_object (must be one of TYPE_PREFIX\'s 9 types — PROG, CLAS, INTF, FUGR, INCL, TABL, DTEL, DOMA, DDLS), action=move_object, and action=remove_object (both accept any CTS E071 object type code, not limited to those 9 — e.g. FUNC with pgmid=LIMU for a function module; use the pgmid/type GetMeta(TRANSPORT) lists for the object). For action=create, use with object_name as an alternative to object_url.'
                },
                target: {
                  type: 'string',
                  description: 'action=set_text only. Optional CTS target system group override (e.g. "/ZABC/"). Normally omitted — the tool auto-preserves whatever target the transport currently has. Only pass this to REPAIR a transport whose target was already cleared to "Local Change Requests" by an older version of this tool.'
                }
              },
              required: ['action']
            }
          },
          {
            name: 'ManageDDIC',
            description: 'Create or update ABAP Dictionary structures, table types, data elements, domains, and CDS view entities via their native ADT contracts (not the custom dispatch bridge). object_type=STRUCTURE or CDS_VIEW: DDL-source based — provide source_file (or source_code) with the full DDL body ("define structure ... { ... }" or "@AbapCatalog...define view NAME as select from ... { ... }"); create additionally requires description + package_name. object_type=TABLE_TYPE: metadata-XML based, no source file — provide row_type_name (an existing dictionary structure/table used as the row type); create additionally requires description + package_name. Every TABLE_TYPE is created/kept as accessType=standard with the system default key — sorted/hashed access and explicit key components are not supported (unverified live contract). action=update on a TABLE_TYPE can only change row_type_name; a supplied description is rejected outright rather than silently ignored (SAP silently no-ops a description change sent on the update PUT). object_type=DATA_ELEMENT: metadata-XML based, no source file — provide domain_name (an existing, active domain; its dataType/length/decimals are looked up automatically) plus optional short_label/medium_label/long_label/heading_label (each defaults to description, truncated to that field\'s length limit, when omitted); create additionally requires description + package_name. Unlike TABLE_TYPE, a data element\'s description CAN be changed on update. Only typeKind=domain row types are supported for DATA_ELEMENT (no predefined-type or class/interface references). object_type=DOMAIN: metadata-XML based, no source file — provide data_type (e.g. CHAR, NUMC, DEC) + length, plus optional decimals (default 0); create additionally requires description + package_name. Like TABLE_TYPE (not DATA_ELEMENT), a domain\'s description is unretrievable after creation, so a supplied description on action=update is rejected outright. No fixed values or value-table reference support (unverified live contract). All object types require transport_number or transport_description for any name outside the $TMP package. Does not support delete, transparent tables, search helps, append structures, or any other DDIC object type.',
            inputSchema: {
              type: 'object',
              properties: {
                object_type: {
                  type: 'string',
                  description: 'DDIC object type. Supported: STRUCTURE, TABLE_TYPE, DATA_ELEMENT, CDS_VIEW, DOMAIN'
                },
                action: {
                  type: 'string',
                  description: 'Operation to perform. Values: create, update'
                },
                name: {
                  type: 'string',
                  description: 'Object name. Must be in the customer namespace (start with Z or Y). Example: ZMY_STRUCTURE, ZMY_TABLE_TYPE, ZMY_DTEL, ZMY_CDS_VIEW, ZMY_DOMAIN'
                },
                source_file: {
                  type: 'string',
                  description: 'STRUCTURE and CDS_VIEW only. Path to a local file containing the full DDL source. Relative paths resolve against the server\'s working directory. Use this or source_code (source_file wins if both given).'
                },
                source_code: {
                  type: 'string',
                  description: 'STRUCTURE and CDS_VIEW only. The complete DDL source inline. Use this or source_file — prefer source_file for larger sources to avoid burning LLM context.'
                },
                row_type_name: {
                  type: 'string',
                  description: 'TABLE_TYPE only. Name of an existing dictionary structure or table to use as the row type. Required for create, and for update (the only field update can change).'
                },
                domain_name: {
                  type: 'string',
                  description: 'DATA_ELEMENT only. Name of an existing, active domain to base the data element on (typeKind=domain — the only row-type kind supported). Required for create and update. The domain\'s technical type (dataType/length/decimals) is read live and embedded automatically.'
                },
                data_type: {
                  type: 'string',
                  description: 'DOMAIN only. ABAP/DDIC built-in data type, e.g. CHAR, NUMC, DEC, DATS. Required for create and update.'
                },
                length: {
                  type: 'number',
                  description: 'DOMAIN only. Field length. Required for create and update.'
                },
                decimals: {
                  type: 'number',
                  description: 'DOMAIN only. Optional. Number of decimal places (relevant for DEC/QUAN/CURR-style types). Defaults to 0.'
                },
                short_label: {
                  type: 'string',
                  description: 'DATA_ELEMENT only. Optional. Short field label (SE11 "Short" column header, max 10 characters — truncated if longer). Defaults to description (or, on update, the existing label) when omitted.'
                },
                medium_label: {
                  type: 'string',
                  description: 'DATA_ELEMENT only. Optional. Medium field label (max 20 characters — truncated if longer). Defaults to description (or, on update, the existing label) when omitted.'
                },
                long_label: {
                  type: 'string',
                  description: 'DATA_ELEMENT only. Optional. Long field label (max 40 characters — truncated if longer). Defaults to description (or, on update, the existing label) when omitted.'
                },
                heading_label: {
                  type: 'string',
                  description: 'DATA_ELEMENT only. Optional. Heading field label (max 55 characters — truncated if longer). Defaults to description (or, on update, the existing label) when omitted.'
                },
                description: {
                  type: 'string',
                  description: 'Description for a newly created object. Required for action=create. Not accepted for TABLE_TYPE or DOMAIN action=update (SAP silently ignores a description change there — see tool description). For DATA_ELEMENT/STRUCTURE/CDS_VIEW, omit on update to keep the current description unchanged.'
                },
                package_name: {
                  type: 'string',
                  description: 'Development package (DEVCLASS). Required for action=create, or whenever transport_description is supplied (used as the new transport\'s DEVCLASS).'
                },
                transport_number: {
                  type: 'string',
                  description: 'Optional. Transport request number to record the change. If the object is already recorded in an open transport, you MUST use that transport (or omit this parameter) — supplying a different one is refused to prevent silent reassignment.'
                },
                transport_description: {
                  type: 'string',
                  description: 'Optional. When transport_number is omitted, explicitly creates a new transport with THIS description instead of letting SAP auto-generate one. Requires package_name. Ignored if transport_number is also given, or if an existing object is already in an open transport (that transport is kept). For an existing object the transport is created only after the lock and reassignment guard pass, so a refusal leaves no empty transport. Maximum 60 characters.',
                  maxLength: 60
                }
              },
              required: ['object_type', 'action', 'name']
            }
          },
          {
            name: 'WriteProgram',
            description: 'MODES — pick ONE way to give the source: (1) source_code | source_file = full write (creates the object when description + package_name are given); (2) edits[] = patch an EXISTING object (cheapest for any change to a large object); (3) apply_patch=<id> = apply the edits of an earlier PASSED dry run (edits + check_only=true prints the id); (4) class_include=testclasses|implementations|definitions|macros = write the LOCAL part of a class (unit tests live in testclasses) — combine with (1), (2) or (3). check_only=true reports the syntax check and writes nothing. DEFAULTS: activate=true; syntax_check is OFF for a main-source write but ON for class_include. Write (overwrite) ABAP source code for programs, includes, classes, or function modules. Auto-detects object type. If the object does not exist, it can be created by providing description and package_name. Can also create an empty function group (object_type=FUGR) — a container only, no source is written (provide description + package_name, omit source_code/source_file).',
            inputSchema: {
              type: 'object',
              properties: {
                program_name: {
                  type: 'string',
                  description: 'Name of the ABAP object to write to: program, include, class, or function module. Always use this field regardless of object_type — there is no separate object_name or function_name field, even when object_type=FUNC. Example: ZTEST_PROGRAM, ZRPP0057NF03, ZCL_MY_CLASS, ZFDTC01_GET_BOM_BY_VERID'
                },
                source_code: {
                  type: 'string',
                  description: 'The complete ABAP source code to write. This will REPLACE the entire source. Use this OR source_file OR edits (not combined). Provide source_file instead when the code is large enough that inlining it would burn context.'
                },
                source_file: {
                  type: 'string',
                  description: 'Optional. Path to a local file containing the ABAP source. Relative paths are resolved against the server\'s working directory. Use this for large source to avoid burning LLM context. Mutually exclusive with source_code (if both are given, source_file wins).'
                },
                overwrite: {
                  type: 'boolean',
                  description: 'Optional, default false. description/package_name mean "create a new object". If the object already exists the call is REFUSED (nothing locked or written), because another developer may own that name - even in $TMP. To update an existing object omit description/package_name (or use edits[]); pass overwrite=true only to deliberately replace it through the create parameters.',
                  default: false
                },
                include_raw_sap_response: {
                  type: 'boolean',
                  description: 'Optional. On a source PUT failure, include the complete raw SAP ADT response for diagnosis. Default false to avoid a potentially large response consuming context; enable only when the concise error and source diagnostics are insufficient.',
                  default: false
                },
                text_symbols: {
                  type: 'string',
                  description: 'Optional. ABAP text symbols (TEXT-XXX entries). Supported only for executable programs (PROG/P). Written to /sap/bc/adt/textelements/programs/{name}/source/symbols after the main source, before activation. Format: blank-line-separated blocks, each one `@MaxLength:N` line followed by `KEY=VALUE` line. Example: `@MaxLength:30\\n001=Header Material\\n\\n@MaxLength:50\\n002=Vendor`. Mutually exclusive with text_symbols_file.'
                },
                text_symbols_file: {
                  type: 'string',
                  description: 'Optional. Path to a local file containing the text-symbols block in the same format as text_symbols. Use for larger symbol sets. Mutually exclusive with text_symbols (file wins if both are given).'
                },
                selection_texts: {
                  type: 'string',
                  description: 'Optional. Selection-screen texts (selection texts). PROG/P only. Format: one line per parameter `PARAM   =Text` (parameter name padded to 8 chars, then "=", then text). Mutually exclusive with selection_texts_file.'
                },
                selection_texts_file: {
                  type: 'string',
                  description: 'Optional. Path to a local file containing the selection texts block. Mutually exclusive with selection_texts (file wins if both are given).'
                },
                list_headings: {
                  type: 'string',
                  description: 'Optional. List headings for classical-list output. PROG/P only. Format: `listHeader=...\\ncolumnHeader_1=...\\n...`. Mutually exclusive with list_headings_file.'
                },
                list_headings_file: {
                  type: 'string',
                  description: 'Optional. Path to a local file containing the list-headings block. Mutually exclusive with list_headings (file wins if both are given).'
                },
                transport_number: {
                  type: 'string',
                  description: 'Optional. Transport request number to record the change. Example: DEVK900123. If the object is already recorded in an open transport, you MUST use that transport (or omit this parameter) — supplying a different one is refused to prevent silent reassignment. Check the object\'s current transport (GetTransport) BEFORE creating a new one, or you end up with an empty duplicate request.'
                },
                transport_description: {
                  type: 'string',
                  description: 'Optional. When transport_number is omitted, explicitly creates a new transport with THIS description instead of letting SAP silently auto-generate one titled "Generated Request for Change Recording" (which cannot be renamed once released). Requires package_name (used as the new transport\'s DEVCLASS). Ignored if transport_number is also given. Maximum 60 characters.',
                  maxLength: 60
                },
                activate: {
                  type: 'boolean',
                  description: 'Whether to activate after writing. Default: true',
                  default: true
                },
                class_include: {
                  type: 'string',
                  enum: ['testclasses', 'implementations', 'definitions', 'macros'],
                  description: 'Optional. Write one of an EXISTING class\'s LOCAL includes instead of its main source: testclasses (local unit-test classes), implementations (local classes), definitions (local types), macros. program_name is the class. Pass exactly one of source_code, source_file or edits (a patch of that include as it is in SAP now); the include is created if it does not exist yet. Local classes/tests must NOT be put into the class\'s main source — SAP\'s source splitter rejects that (OO_SOURCE_BASED011). activate defaults to true (activates the class). The class is syntax-checked with the new include text in place BEFORE the lock (on by default; syntax_check=false opts out; check_only=true only reports) — errors in THIS include refuse the write, errors elsewhere in the class are listed but do not block.'
                },
                apply_patch: {
                  type: 'string',
                  description: 'Optional. A patch id returned by an earlier edits[] + check_only=true dry run that passed ("To apply this exact patch: … apply_patch=p-xxxx"): re-use those edits instead of sending them again. Same program_name required; mutually exclusive with edits/source_code/source_file. The edits are re-applied to the CURRENT source (same fail-fast and re-read-in-lock safety as a direct edits[] call). Works for the main source of a class and, together with class_include, for that local include (an id is bound to one class AND one include). Valid 15 minutes, in memory — unknown after a server restart, then send the edits again.'
                },
                edits: {
                  type: 'array',
                  description: 'PATCH MODE — change part of an existing object without sending its whole source (use instead of source_code/source_file; cannot be combined with them; the object must already exist). Each entry is { old_string, new_string, replace_all? }: old_string must match the CURRENT SAP source exactly (case, indentation, spaces) and occur exactly once unless replace_all=true; new_string replaces it ("" deletes). Edits apply in order, each to the result of the previous one; if ANY edit fails, nothing is locked or written and the error names the edit, and — when the text exists with other whitespace/case — shows the exact lines to copy. The source is read from SAP (the inactive working version if one exists), re-read after the lock, and edits are re-applied if it changed in between. Syntax check, transport guard, text elements and activation behave as for a full write; check_only=true + edits is a dry run. Max 20 edits. Prefer this over source_code for any change to a large object.',
                  items: {
                    type: 'object',
                    properties: {
                      old_string: { type: 'string', description: 'Exact text to find in the current source (multi-line allowed). Include enough surrounding lines to be unique.' },
                      new_string: { type: 'string', description: 'Replacement text. Empty string deletes old_string.' },
                      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Default false.' }
                    },
                    required: ['old_string', 'new_string']
                  },
                  maxItems: 20
                },
                syntax_check: {
                  type: 'boolean',
                  description: 'Optional. Run an ADT syntax check of the new source BEFORE locking; on any error nothing is locked or written and the errors (line:col — text) are returned. Existing objects only (a new object is created first). A failing check call never blocks the write. Default false. An include is checked in its master program\'s context; with no master program known it is checked alone (the output says so), and then false errors are possible.',
                  default: false
                },
                check_only: {
                  type: 'boolean',
                  description: 'Optional. Only syntax-check source_code/source_file against the existing object and report the messages — no lock, no write, no transport. Implies syntax_check. Default false.',
                  default: false
                },
                description: {
                  type: 'string',
                  description: 'Optional. Description for creating a new object. Required together with package_name if the object does not exist yet.'
                },
                package_name: {
                  type: 'string',
                  description: 'Optional. Package (dev class) for creating a new object. Required together with description if the object does not exist yet. Example: $TMP, ZMY_PACKAGE'
                },
                object_type: {
                  type: 'string',
                  description: 'Optional. Type of object to create: PROG (program, default), INCL (include), INTF (interface — the full `INTERFACE … PUBLIC. … ENDINTERFACE.` source), CLAS (class — the full `CLASS ... DEFINITION ... IMPLEMENTATION ... ENDCLASS.` source, including visibility/final/abstract, goes in source_code/source_file; SAP defaults a brand-new class to PUBLIC CREATE PRIVATE until overwritten by the header you supply), FUGR (function group container — no source written; SAP generates the TOP/UXX includes), or FUNC (function module — requires function_group; the FM signature comes from the inline FUNCTION header in the source). Only used when creating a new object.',
                  default: 'PROG'
                },
                function_group: {
                  type: 'string',
                  description: 'Optional. Host function group for creating a new function module (object_type=FUNC). The group is created automatically if it does not exist (using description + package_name). Example: ZFG_JOB_SUSPEND'
                }
              },
              required: ['program_name']
            }
          },
          {
            name: 'ActivateObjects',
            description: 'Mass-activate multiple ABAP objects in a single ADT activation request. Use after WriteProgram calls with activate=false when you have several includes/programs that should compile together (cross-references resolve atomically). Auto-detects each object via search. For executable programs the text-elements object (text symbols / selection texts / list headings) is activated along with the source. Can also toggle a function module\'s "Remote-Enabled Module" (RFC-enabled) checkbox via rfc_enabled — that SE37 Attributes-tab setting is object metadata, not source code, so it is applied via its own lock/PUT/unlock cycle before the activation call.',
            inputSchema: {
              type: 'object',
              properties: {
                names: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Names of the ABAP objects to activate. Example: ["ZRPP0057NF03", "LCOKO1F01", "ZMY_INCLUDE"]. Optional if rfc_enabled is given — objects named there are activated automatically even if omitted here.'
                },
                rfc_enabled: {
                  type: 'object',
                  additionalProperties: { type: 'boolean' },
                  description: 'Optional. Map of function-module name → desired Remote-Enabled state, applied before activation. true sets it as RFC-enabled (processingType=rfc); false reverts it to a normal (non-remote) function module. Example: {"ZFM_MY_RFC": true}. Only the normal ↔ rfc transition is supported (not update modules).'
                },
                transport_number: {
                  type: 'string',
                  description: 'Optional. Transport request number to record rfc_enabled property changes. If an object is already locked in an open transport, you MUST use that transport (or omit this) — supplying a different one is refused to prevent silent reassignment. Not used for plain activation (no transport needed there).'
                }
              }
            }
          },
          {
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
          },
          {
            name: 'ManageDynpro',
            description: 'Create, update, delete or consistency-check a classic SAP GUI screen (Dynpro) of a customer program (Z*/Y*/SAPLZ*/SAPLY*). Read screens first with GetCode resource=DYNPRO (raw=true gives the JSON definition this tool takes). The write is generated immediately — the screen is active, no ActivateObjects step. Refused with nothing saved: generation errors (e.g. FIELD of an undefined variable), a subscreen area without CALL SUBSCREEN in PBO and PAI, selection screens (they come from SELECTION-SCREEN statements), and — for non-$TMP programs — a missing transport_number or one different from the open request already holding the screen. After every successful write SE51\'s consistency check runs: a MODULE the program does not define etc. is reported as an error (isError) although the screen IS saved — add the MODULE with WriteProgram, then action=check (or write the program first). Other findings are listed as warnings.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['create', 'update', 'delete', 'check', 'translate'],
                  description: 'create: new screen (fails if it exists). update: overwrite an existing screen (its MASTER language — never send translated text here, it replaces the master texts). delete: remove it. check: run SE51\'s consistency check on the saved screen (e.g. after adding missing MODULEs to the program). translate: write the texts of a screen in another language (what SE63 does) with language + translations; the master-language definition is not touched. Read the translatable elements first with GetCode resource=DYNPRO dynnr language.'
                },
                program_name: {
                  type: 'string',
                  description: 'Program owning the screen, e.g. ZMY_MODULE_POOL (SAPL<group> for a function group).'
                },
                dynnr: {
                  type: 'string',
                  description: 'Screen number, e.g. "0100" (leading zeros optional).'
                },
                definition: {
                  type: ['object', 'string'],
                  description: 'create/update. Full screen definition as JSON (object or string): { header, containers, fields_to_containers, flow_logic, params } — the shape GetCode resource=DYNPRO raw=true returns. header.program/header.screen are replaced by program_name/dynnr, so a definition read from another screen or program can be reused. Prefer definition_file for anything but tiny screens. Elements (fields_to_containers): copy an element of the SAME type as a template and change name/line/column/length/vislength. type: TEXT (label, text in "text"), TEMPLATE (input/output field; "text" = "_" x length), OKCODE (the OK-code field, line 0), FRAME, PUSH (button, push_fcode), CHECK (checkbox), RADIO (radio button); also FRAME_TMPL, PUSH_TMPL, INFOBUTTON. Field flags: input_fld "X" = input, output_fld "X" = output, outputonly "X" = output only (display). requ_entry: "" = input possible, "N" = input not possible (TEXT elements carry it; never combine with input_fld "X"), "R" = recommended, "O" = required. Verify with GetCode resource=DYNPRO: its Attr column shows in/out/ro/req per element.'
                },
                definition_file: {
                  type: 'string',
                  description: 'create/update. Path to a local file holding the definition JSON (wins over definition). Tip: GetCode resource=DYNPRO raw=true output_file=<path>, edit the file, pass it here.'
                },
                flow_logic: {
                  type: 'string',
                  description: 'create/update. Flow logic as plain text (PROCESS BEFORE OUTPUT. ... PROCESS AFTER INPUT. ...), max 72 characters per line. Replaces definition.flow_logic. On update it may be given without a definition — the current screen is read and only its flow logic replaced.'
                },
                flow_logic_file: {
                  type: 'string',
                  description: 'create/update. Path to a local file with the flow logic (wins over flow_logic).'
                },
                description: {
                  type: 'string',
                  description: 'create/update. Optional new screen description (max 60 characters). On update it may be given alone, like flow_logic.'
                },
                screen_attributes: {
                  type: ['object', 'string'],
                  description: 'create/update. Optional SE51 "Attributes" tab values, applied on top of the definition; on update it may be given alone (like flow_logic). Keys: type ("normal" | "subscreen" | "modal"; N/I/M also accepted), next_screen ("0200", "" = none), cursor_position (element name), screen_group (max 4), lines, columns (maintenance size), context_menu (FORM ON_CTMENU_<name>; pass <name>), and true/false flags hold_data, switch_off_runtime_compression, hold_scroll_position, without_application_toolbar, fiori_no_enlargement. Example: {"type":"modal","next_screen":"0100","hold_data":true}. "Template - non-executable" is not supported (SAP cannot generate template screens).',
                  properties: {
                    type: { type: 'string', enum: ['normal', 'subscreen', 'modal', 'N', 'I', 'M'] },
                    next_screen: { type: 'string' },
                    cursor_position: { type: 'string' },
                    screen_group: { type: 'string' },
                    lines: { type: 'number' },
                    columns: { type: 'number' },
                    context_menu: { type: 'string' },
                    hold_data: { type: 'boolean' },
                    switch_off_runtime_compression: { type: 'boolean' },
                    hold_scroll_position: { type: 'boolean' },
                    without_application_toolbar: { type: 'boolean' },
                    fiori_no_enlargement: { type: 'boolean' }
                  },
                  additionalProperties: false
                },
                transport_number: {
                  type: 'string',
                  description: 'Workbench request or one of its tasks, e.g. DEVK900123. Required unless the program is in a local ($...) package. Not used by translate.'
                },
                language: {
                  type: 'string',
                  description: 'translate only. Target language: SAP key (M = Traditional Chinese), ISO code (ZF) or LXE code (zhTW). Must differ from the screen\'s master language.'
                },
                translations: {
                  type: ['object', 'array', 'string'],
                  description: 'translate only. Element texts in the target language: {"GW_ZCOT0147A-ZDESC":"週期說明"} or [{"element":"...","text":"..."}]. Element names and maximum lengths come from GetCode resource=DYNPRO dynnr language. Everything is validated first; either all texts are written or none. A translation cannot be deleted here. The texts are NOT on a workbench request: they are recorded in the translation log and travel with SE63\'s translation transport.'
                }
              },
              required: ['action', 'program_name', 'dynnr']
            }
          },
          {
            name: 'RunABAP',
            description: 'Execute ABAP server-side and return its console output. CLAS: runs a class implementing IF_OO_ADT_CLASSRUN (method MAIN, output via out->write). PROG: runs an executable report with selection-screen defaults and returns its WRITE list — it may change data, so it requires confirm_side_effects=true after you have read the source. A CLASS in a local ($) package runs without confirmation; a class anywhere else (transportable, SAP standard) needs confirm_side_effects=true too. The object must exist (a typo is an error, not an empty run). Includes are refused. Output is capped by max_chars. For ABAP Unit use RunUnitTest.',
            inputSchema: {
              type: 'object',
              properties: {
                object_name: { type: 'string', description: 'Class or program name. Example: ZCL_MCP_DEMO_RUN' },
                object_type: { type: 'string', description: 'Optional CLAS or PROG; disambiguates a name that exists as both.' },
                confirm_side_effects: { type: 'boolean', description: 'Required true for a PROG, and for a CLAS outside a local ($) package: you acknowledge it really executes and may write to the database.' },
                max_chars: { type: 'integer', description: 'Output cap in characters (default 20000).' }
              },
              required: ['object_name']
            }
          },
          {
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
          },
          {
            name: 'UnlockObject',
            description: 'Recover from a stuck ADT edit lock (e.g. activation or WriteProgram failing with "User X is currently editing Y"). Attempts to acquire the lock and, if successful, immediately releases it — clearing a stray/reclaimable lock (typically left behind by an interrupted WriteProgram call, or a session that already timed out). If the lock cannot be acquired, the object is genuinely held by an active session: nothing is changed, and the response tells you whether the holder is your own configured SAP user (likely a leftover SAP GUI/ADT session — close it) or a different user (coordinate with them, or escalate to SAP Basis/SM12). Never force-unlocks another user\'s lock; with force=true it deletes your own user\'s orphan SM12 entry for the object.',
            inputSchema: {
              type: 'object',
              properties: {
                object_name: {
                  type: 'string',
                  description: 'Name of the locked ABAP object (program, include, function module, class, interface, ...). Example: ZRCU0001CF01'
                },
                object_type: {
                  type: 'string',
                  description: 'Optional. Disambiguates objects that share a name (e.g. RSPARAM is both a program and a structure): a type group such as PROG, CLAS, INTF, FUGR, TABL, or an exact ADT subtype such as PROG/P, TABL/DS, FUGR/FF. Without it an ambiguous name is refused and the candidates are listed — nothing is locked or deleted.'
                },
                force: {
                  type: 'boolean',
                  description: 'Optional, default false. When the lock cannot be acquired and is held by your OWN configured SAP user (an orphan from a dead session), delete it from SM12 via the standalone endpoint zmcp/lock_admin. Only your own user\'s locks on this object are ever deleted — never another developer\'s. There is NO orphan-vs-live check: a live editor session of the same user is deleted just like an orphan, so confirm no SAP GUI/Eclipse session of yours is editing the object first. Matches whole object names only.'
                }
              },
              required: ['object_name']
            }
          },
          {
            name: 'ManageSessions',
            description: 'List and end the connection user\'s OWN stale ABAP sessions (SM04) on every application server — the session half of recovering from a failed stateful ADT call (UnlockObject force=true only removes the SM12 lock, not the session). action=list shows each session as server:tid with kind, client IP (term), time and age. action=end ends the given ids. Own user only, HTTP/ADT sessions only (GUI and other kinds are refused — use SM04); the session carrying the request and sessions younger than min_age_minutes (default 2) are refused; every id is re-validated against a fresh list. There is deliberately no "end all". Your own open Eclipse/ADT or GUI-in-browser sessions are HTTP sessions too and look the same — end only ids you recognize (by term and age). List first — session ids are reused immediately (the same tid can be an HTTP session in one call and an RFC context in the next), so an id is only valid in the latest list; end it right after listing.',
            inputSchema: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['list', 'end'], description: '"list" (default use) or "end".' },
                ids: { type: 'array', items: { type: 'string' }, description: 'action=end only. Session ids exactly as printed by action=list, "server:tid".' },
                min_age_minutes: { type: 'integer', minimum: 0, description: 'action=end only. Refuse sessions younger than this (default 2) so a client mid-sequence is not cut off.' }
              },
              required: ['action']
            }
          },
          {
            name: 'DeleteObject',
            description: 'Deletes an ABAP repository object (e.g. a function module) from the system. Auto-detects the object via search, locks it, issues the ADT delete, and reports the result. Destructive and hard to reverse — confirm with the user before calling. Safety guard: an inactive class is refused until its CTS/deletion entry and inactive-object entry are removed through SAP GUI/Eclipse ADT; after that cleanup, the repository object can be deleted and its name recreated. Note: deleting a member of a container (e.g. a function module inside a function group) requires the delete to be recorded under whichever transport currently holds the CONTAINER\'s own CTS lock (e.g. R3TR FUGR), which may differ from the transport holding the member\'s own registration — a conflict here is reported with the blocking transport number so it can be resolved (release it, or retry with it) rather than guessed at.',
            inputSchema: {
              type: 'object',
              properties: {
                object_name: {
                  type: 'string',
                  description: 'Name of the ABAP object to delete (program, include, function module, class, interface, ...). Example: ZBP_JOB_CREATE_V2'
                },
                object_names: {
                  type: 'array',
                  items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { object_name: { type: 'string' }, object_type: { type: 'string' }, transport_number: { type: 'string' } }, required: ['object_name'] }] },
                  maxItems: 20,
                  description: 'Optional, instead of object_name: delete several objects in ONE call (names, or { object_name, object_type?, transport_number? }; max 20). Deleted one after another IN THE ORDER GIVEN — list a program BEFORE the includes it includes, a package LAST. A failure does not stop the rest; the answer lists every object with ✓/✗. object_type / transport_number at the top level apply to every entry that does not set its own.'
                },
                object_type: {
                  type: 'string',
                  description: 'Optional. Disambiguates objects that share a name (e.g. RSPARAM is both a program and a structure): a type group such as PROG, CLAS, INTF, FUGR, TABL, or an exact ADT subtype such as PROG/P, TABL/DS, FUGR/FF. Without it an ambiguous name is refused and the candidates are listed — nothing is locked or deleted.'
                },
                transport_number: {
                  type: 'string',
                  description: 'Optional. Transport request number to record the deletion under. If the object is already locked in an open transport, you MUST use that transport (or omit this) — supplying a different one is refused to prevent silent reassignment.'
                }
              },
              required: []
            }
          },
          {
            name: 'TextPoolLang',
            description: 'Read or write a program\'s text pool (symbols, selections, headings, or title) in an explicit target language, independent of the object\'s master language. A write only ever touches the individual entries you supply (by id+key) — every other entry, in this and every other category, is left exactly as-is; a single-symbol edit does not affect any other symbol.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description: '"get" to read, "write" to write.',
                  enum: ['get', 'write']
                },
                program_name: {
                  type: 'string',
                  description: 'ABAP program name. Example: ZRCO0074'
                },
                language: {
                  type: 'string',
                  description: '2-char ISO code (e.g. "ZF", "EN", "DE") or 1-char internal SAP code (e.g. "M", "E", "D") — either works. Not always derivable from each other (e.g. Traditional Chinese ISO "ZF" = internal "M") — pass the one you know rather than guessing the other.'
                },
                category: {
                  type: 'string',
                  description: 'Which text-pool category to read/write. Default: symbols.',
                  enum: ['symbols', 'selections', 'headings', 'title']
                },
                content: {
                  type: 'string',
                  description: 'For action=write: at least one of content/delete_keys is required. Plain-text body in the format for the chosen category: symbols → "@MaxLength:20\\n001=Some Value" (blank-line-separated blocks); selections → "PARAM   =Text" (param name, then spaces to pad to 8 chars, then "="); headings → "listHeader=Title\\ncolumnHeader_1=...\\ncolumnHeader_2=..." (only the lines you supply are changed); title → the whole body is the title, first line only. Only the entries named here are added/updated — every other existing entry (including other keys in the same category) is left untouched, so a single-symbol edit is safe. Omit or leave empty for a delete_keys-only write.'
                },
                delete_keys: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional, action=write only, category=symbols or selections only. Individual entry keys to remove outright (e.g. ["002", "005"] for symbols, or parameter names for selections) — distinct from writing an entry with an empty value, which keeps the row but blanks it. Can be combined with content in the same call (delete some keys, add/update others).'
                },
                package_name: {
                  type: 'string',
                  description: 'Required for action=write. Development class (devclass) for the transport registration. Example: $TMP, ZMCP'
                },
                transport_number: {
                  type: 'string',
                  description: 'Optional, action=write only. Transport request number. Omit for a $TMP package_name.'
                },
                offset: {
                  type: 'number',
                  description: 'Optional, action=get with category=symbols or selections only. Number of entries to skip before returning results, for paging a large text pool. Default: 0.'
                },
                limit: {
                  type: 'number',
                  description: 'Optional, action=get with category=symbols or selections only. Max number of entries to return. Omit for no limit (all entries from offset onward). The response header reports the total entry count and the window actually returned.'
                }
              },
              required: ['action', 'program_name', 'language']
            }
          },
          {
            name: 'ManageSicfNode',
            description: 'For the MCP gateway\'s OWN endpoints only — business HTTP services are created in SICF manually (or as OData/RAP), not here. Create or delete a SICF node directly under default_host/zmcp (action=create_sicf_node|delete_sicf_node), via the ZCL_MCP_SICF_ADMIN/ZCL_MCP_DISPATCH SICF service — the one-time manually-created bootstrap node under which every future custom ADT-gap endpoint now lives, with no further manual SICF steps required. create_sicf_node payload: "name=...\\nhandler_class=...\\ndocu=...\\ntransport=..." (name/handler_class/docu required; handler_class must already exist and implement IF_HTTP_EXTENSION). delete_sicf_node payload: "name=...\\ntransport=...". Also exposes two lightweight diagnostic actions proving the dispatch path itself: "ping" (echoes payload plus the connected SAP user/timestamp) and "echo_upper" (uppercases payload). A new ABAP-side action is added as a WHEN branch in ZCL_MCP_DISPATCH=>dispatch (WriteProgram + ActivateObjects, no SICF/Basis step) and becomes callable through this same tool immediately.',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description: 'Name of the registered ABAP-side action: "create_sicf_node", "delete_sicf_node", "ping", "echo_upper", or any future action added to ZCL_MCP_DISPATCH.'
                },
                payload: {
                  type: 'string',
                  description: 'Opaque string passed to the action\'s own handler — its format (if any) is defined by that action, not by this tool. See the tool description for create_sicf_node/delete_sicf_node\'s key=value payload format.'
                },
                method: {
                  type: 'string',
                  description: 'HTTP method to use. POST (default) sends payload as the request body; GET sends it as a query parameter instead. Use GET only for actions documented as safe/idempotent.',
                  enum: ['GET', 'POST']
                }
              },
              required: ['action']
            }
          },
          {
            name: 'ManageAuthObject',
            description: 'Create or update a custom SU21 authorization object: its class, description, up to 10 fields, and the permitted activities for ACTVT. Runs through the custom endpoint /zmcp/auth_object, because SU21 has no ADT API. No delete. update changes only what you pass and keeps the rest. Input is validated before anything is saved. Once the object is in use (an AUTHORITY-CHECK in code, roles, transactions or DCL), SU21 locks its field list: field changes are refused with 409 and nothing is saved, while class, description and activities can still change. To change the fields, first remove that usage; there is no bypass.',
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
          },
          {
            name: 'RunATCCheck',
            description: 'Run an ABAP Test Cockpit (ATC) code-quality check and return the findings (errors/warnings/notes with location and message). Pass EXACTLY ONE target: transport_numbers (one or more transport requests), objects (object or PACKAGE names — a package checks everything inside it; up to 20), or worklist_id (re-read an earlier run\'s findings with no new ATC run — use it to page large results). Every report states its worklist id and pages with offset/limit (default 200 findings; the footer gives the exact next call). Each transport is validated to exist before running — a nonexistent transport is reported as missing rather than silently returning 0 findings. By default, findings are scoped to the transport\'s own objects (scope="transport") — ATC checks the whole compilation unit (e.g. an entire function group for one changed FM), so unfiltered results can bury a small delta under hundreds of pre-existing findings on untouched sibling objects. For MCP clients with a short request timeout, set background=true to return instantly and have the findings written to a file.',
            inputSchema: {
              type: 'object',
              properties: {
                transport_numbers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'One or more transport request numbers to scan, e.g. ["DEVK900123", "DEVK900123"]. All objects across all listed transports are checked in a single ATC run.'
                },
                objects: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Object or package names to check instead of transports, e.g. ["ZCL_FOO", "ZMCP"]. Each name is resolved first (an unknown or ambiguous name is reported, not silently dropped); a package covers all objects inside. No transport scoping applies. Max 20.'
                },
                worklist_id: {
                  type: 'string',
                  description: 'Optional. A worklist id from an earlier report: fetch its findings again (offset/limit paging) without running ATC again.'
                },
                offset: { type: 'integer', description: 'Optional. Skip this many findings (ordered errors, warnings, notes across all objects). Default 0.' },
                limit: { type: 'integer', description: 'Optional. Findings to show per call. Default 200.' },
                check_variant: {
                  type: 'string',
                  description: 'Optional. ATC check variant to use. Defaults to the system\'s configured default check variant (from /sap/bc/adt/atc/customizing). Note: SAP silently falls back to the default variant if an invalid name is given here — no error is raised.'
                },
                scope: {
                  type: 'string',
                  enum: ['transport', 'full'],
                  default: 'transport',
                  description: 'Optional. "transport" (default): only report findings that land on objects actually registered in the given transport(s) — suppresses pre-existing findings on untouched sibling objects that ATC checks as part of the same compilation unit (e.g. other function modules in the same group). "full": report everything ATC returns, unfiltered. Falls back to unfiltered automatically if the transport\'s object list can\'t be resolved.'
                },
                fail_on_error: {
                  type: 'boolean',
                  description: 'Optional, default false. By default a completed run is a successful call even when it finds priority-1 (error) findings — read the "Verdict: PASS/FAIL" line. Set true for scripts/CI that gate on isError: the call is then ALSO returned as an error when the run has priority-1 findings.'
                },
                background: {
                  type: 'boolean',
                  description: 'Optional. When true, the tool returns immediately (in well under a second, before any SAP call) with the target file path, and writes the findings to that file when the run completes. Use this from MCP clients with a short request timeout (e.g. Cline). Read output_file a few seconds later for the results. Default: false (synchronous — returns the full report inline).',
                  default: false
                },
                output_file: {
                  type: 'string',
                  description: 'Optional. Path to write the findings report to. Relative paths resolve against the server working directory; the absolute path is reported back. Required target for background mode (a timestamped file in the working directory is used if omitted). In synchronous mode, when set, the report is written to this file and also returned inline — unless it exceeds 20000 characters, then only its first 30 lines plus the path, size and line count come back.'
                }
              },
              required: []
            }
          },
          {
            name: 'RunUnitTest',
            description: 'Run ABAP Unit tests for a class or program via ADT (POST /sap/bc/adt/abapunit/testruns) and return PASS/FAIL per test method, including assertion details (expected vs actual) and the failing line. A nonexistent object is validated and reported as "not found" rather than a misleading "no tests" (SAP silently drops an unresolvable object reference and returns an empty result). Use this to prove a $TMP A/B test program before a productive write, per the house workflow.',
            inputSchema: {
              type: 'object',
              properties: {
                object_name: {
                  type: 'string',
                  description: 'Name of the class or program hosting the test class(es), e.g. "ZAB_ZRSD0038" or "ZCL_MY_CLASS". Case-insensitive.'
                },
                risk_levels: {
                  type: 'array',
                  items: { type: 'string', enum: ['harmless', 'dangerous', 'critical'] },
                  description: 'Optional. Which test risk levels to include. Default: ["harmless"] (SAP\'s standard default — matches most local test classes).'
                },
                durations: {
                  type: 'array',
                  items: { type: 'string', enum: ['short', 'medium', 'long'] },
                  description: 'Optional. Which test duration categories to include. Default: ["short"].'
                },
                ...backgroundSchemaProps
              },
              required: ['object_name']
            }
          }
        ]
      };
    });

    // Handler for CallToolRequest
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'SearchObject':
          return await handleSearchObject(request.params.arguments);
        case 'DataPreview':
          return await handleDataPreview(request.params.arguments);
        case 'ManageTransport':
          return await handleManageTransport(request.params.arguments);
        case 'ManageDDIC':
          return await handleManageDDIC(request.params.arguments);
        case 'ManageDynpro':
          return await handleManageDynpro(request.params.arguments);
        case 'ManageMessageClass':
          return await handleManageMessageClass(request.params.arguments);
        case 'WriteProgram':
          return await handleWriteProgram(request.params.arguments);
        case 'GetCode':
          return await handleGetCode(request.params.arguments);
        case 'GetDiagnostics':
          return await handleGetDiagnostics(request.params.arguments);
        case 'GetMeta':
          return await handleGetMeta(request.params.arguments);
        case 'ActivateObjects':
          return await handleActivateObjects(request.params.arguments);
        case 'RunATCCheck':
          return await handleRunATCCheck(request.params.arguments);
        case 'RunUnitTest':
          return await handleRunUnitTest(request.params.arguments);
        case 'ManageSessions':
          return await handleManageSessions(request.params.arguments);
        case 'RunABAP':
          return await handleRunABAP(request.params.arguments);
        case 'ManagePackage':
          return await handleManagePackage(request.params.arguments);
        case 'UnlockObject':
          return await handleUnlockObject(request.params.arguments);
        case 'DeleteObject':
          return await handleDeleteObject(request.params.arguments);
        case 'TextPoolLang':
          return await handleTextPoolLang(request.params.arguments);

        case 'ManageSicfNode':
          return await handleManageSicfNode(request.params.arguments);
        case 'ManageAuthObject':
          return await handleManageAuthObject(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });

    // Handle server shutdown on SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Starts the MCP server and connects it to the transport.
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Create and run the server
const server = new mcp_abap_adt_server();
server.run().catch((error) => {
  process.exit(1);
});
