# SAP ADT REST API Endpoints

This document provides a comprehensive list of the REST endpoints used by SAP ABAP Development Tools (ADT) for communication between the client (Eclipse/MCP Server) and the SAP Backend.

> **Note:** All endpoints are relative to the SAP system base URL (e.g., `https://host:port`). Most require `sap-client` header and Basic Authentication. Write operations (`POST`, `PUT`, `DELETE`) usually require an `x-csrf-token`.

## 1. Core Discovery & Metadata
Endpoints for discovering system capabilities and browsing the repository.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/discovery` | `GET` | **Main Discovery**: Returns XML listing all available ADT services. |
| `/sap/bc/adt/core/discovery` | `GET` | **Core Services**: Discovers fundamental services like search and project explorer. |
| `/sap/bc/adt/compatibility/graph` | `GET` | **Compatibility**: Checks client-server compatibility. |
| `/sap/bc/adt/repository/informationsystem/search` | `GET` | **Quick Search**: Search for ABAP objects by name, type, or package. |
| `/sap/bc/adt/repository/nodestructure` | `POST` | **Package Explorer**: Retrieves the tree structure of a package (Nodes). |
| `/sap/bc/adt/repository/nodepath` | `POST` | **Object Path**: Resolves the package hierarchy path for an object. |
| `/sap/bc/adt/repository/informationsystem/objecttypes` | `GET` | **Type Browser**: Lists all supported object types. |
| `/sap/bc/adt/repository/typestructure` | `POST` | **Type Structure**: Loads detailed object type capabilities. |
| `/sap/bc/adt/packages/valuehelps/{type}` | `GET` | **Package Search**: Search help for packages. |

## 2. Source Code & Object Management
Endpoints for reading, writing, locking, and activating objects.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/programs/programs/{name}/source/main` | `GET/PUT` | Read/Write **Program** source. |
| `/sap/bc/adt/oo/classes/{name}/source/main` | `GET/PUT` | Read/Write **Class** source. |
| `/sap/bc/adt/oo/interfaces/{name}/source/main` | `GET/PUT` | Read/Write **Interface** source. |
| `/sap/bc/adt/functions/groups/{grp}/fmodules/{fm}/source/main` | `GET/PUT` | Read/Write **Function Module** source. |
| `/sap/bc/adt/programs/includes/{name}/source/main` | `GET/PUT` | Read/Write **Include** source. |
| `/sap/bc/adt/ddic/tables/{name}/source/main` | `GET` | Read **Table** definition (DDL). |
| `/sap/bc/adt/ddic/structures/{name}/source/main` | `GET` | Read **Structure** definition (DDL). |
| `{objectUrl}` | `POST` | **Lock**: `?_action=LOCK&accessMode=MODIFY`. Add `X-sap-adt-sessiontype: stateful` for lock→PUT→unlock cycle. Response: XML with `LOCK_HANDLE`. |
| `{objectUrl}` | `POST` | **Unlock**: `?_action=UNLOCK&lockHandle={encoded}`. Add `X-sap-adt-sessiontype: stateless`. **Note: uses POST, not DELETE.** |
| `{objectSourceUrl}` | `PUT` | **Set source**: `?lockHandle={handle}&corrNr={transport}`. Body: source text. Add `X-sap-adt-sessiontype: stateful`. |
| `/sap/bc/adt/activation` | `POST` | **Activate**: Activates one or more objects. |
| `/sap/bc/adt/activation/inactiveobjects` | `GET` | **Inactive List**: Retrieves user's inactive objects. Wired up as `GetMeta(resource=INACTIVE_OBJECTS)` — see `CLAUDE.md`. |
| `/sap/bc/adt/sscr/registration/objects` | `GET` | **Registration**: Checks if object requires SSCR key. |
| `{objectUrl}` | `DELETE` | **Delete**: `?lockHandle={handle}[&corrNr={transport}]`, requires the stateful lock session from the `LOCK` call above (same `X-sap-adt-sessiontype: stateful`). No response body on success; throws on failure. Verified live 2026-08-27 against a function module. **Trap:** deleting a member of a container object (e.g. a function module inside a function group) needs the delete recorded under whichever transport currently holds the *container's own* CTS lock (`R3TR FUGR {group}`), not the transport holding the member's own entry — see `CLAUDE.md`'s DeleteObject Tool section for the live incident. |
| `{objectUrl}/objectstructure` | `GET` | **Structure**: Detailed components (methods, attributes) of a class/object. |
| `{revisionUrl}` | `GET` | **Revisions**: History of an object (Link via `rel=.../versions`). PROG/INCL/INTF/FUGR: `{objectUrl}/source/main/versions`. **CLAS has no `source/main/versions` (404)** — one feed per include: `includes/main/versions` (global class pool), `includes/definitions`, `includes/implementations`, `includes/macros`, `includes/testclasses`. DDLS: `{objectUrl}/versions`. Verified 2026-10-07; `GetCode resource=VERSION` reads `includes/main` for classes. |
| `/sap/bc/adt/messageclass/{name}` | `GET/PUT/DELETE` | **Message class (SE91)**, `application/vnd.sap.adt.mc.messageclass+xml`; create = `POST /sap/bc/adt/messageclass`. PUT takes an `mc:messageClass` document and only **upserts** the `<mc:messages>` it carries; deletions must be listed as `<mc:deletedmessages mc:msgno="…"/>` after them. **Always set `adtcore:language`** (ISO, e.g. `EN`, `ZF`): texts are read and written in that language — omitted, SAP writes every message with `T100-SPRSL = ' '` (observed in practice). A delete with an empty or logon language removes the message in all languages; another language removes only that language's row. GET reads in the `sap-language` header's language but reports `adtcore:masterLanguage` wrongly — use `T100A-MASTERLANG`. No activation. `UNLOCK` after a `DELETE`, or the name stays enqueued. `…/messages/{no}` supports only GET/`LOCK_MSG`; `…/messages/{no}/longtext` is GET-only (no long-text write on this release). Wired up as `ManageMessageClass` — see `CLAUDE.md`. |

## 3. Object Creation
Endpoints to create new ABAP objects.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/programs/programs` | `POST` | Create Program. |
| `/sap/bc/adt/oo/classes` | `POST` | Create Class. |
| `/sap/bc/adt/oo/interfaces` | `POST` | Create Interface. |
| `/sap/bc/adt/functions/groups` | `POST` | Create Function Group. |
| `/sap/bc/adt/functions/groups/{name}/fmodules` | `POST` | Create Function Module. |
| `/sap/bc/adt/ddic/ddl/sources` | `POST` | Create CDS Data Definition. |
| `/sap/bc/adt/packages` | `POST` | Create Package. |
| *(Many others per type)* | `POST` | See `objectcreator.js` for full mapping. |

## 4. Transport Management (CTS)

ADT exposes two different transport-creation contracts. Do not treat them as
aliases:

- `/sap/bc/adt/cts/transports` creates an object-oriented correction request.
  SAP derives its package transport layer and target from `DEVCLASS` plus the
  shape of `REF`. This is the contract used while creating or saving a repository
  object and normally produces a Workbench request.
- `/sap/bc/adt/cts/transportrequests` with `tm:useraction="newrequest"` is the
  Transport Organizer contract. It explicitly selects Workbench, Customizing,
  or Transport of Copies and can create initial tasks in the same request.

### Discovery and media types

Do not assume that every backend release supports every operation. Read
`GET /sap/bc/adt/discovery` and locate:

- category scheme: `http://www.sap.com/adt/categories/cts`
- collection term `transports` for object-oriented correction creation
- collection term `transportmanagement` for Transport Organizer operations
- template relation `http://www.sap.com/adt/categories/cts/transportrequests`
  for the canonical request-collection URL

Older ADT releases may expose the Transport Organizer term as the misspelled
`transportsmanagement`. The native ADT client gates new-request creation on the
`transportmanagement` collection accepting this media type:

```text
application/vnd.sap.adt.transportorganizer.v1+xml
```

The contracts in this section were derived from the installed native SAP ADT
3.52 plug-ins (`com.sap.adt.transport_3.52.0`,
`com.sap.adt.tm.model_1.212.0`, and `com.sap.adt.tm.ui_1.212.0`). Entries marked
"live-verified" were additionally exercised against this project's SAP system;
the `newrequest` POST is native-client-confirmed but has not yet been sent by
this project.

### Endpoint matrix

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/cts/transportchecks` | `POST` | **Check object recording requirements**. Posts ADT ASX check data containing the object reference and `DEVCLASS`; optional query parameters observed in native ADT include `transportLayer` and `linkUpMode`. |
| `/sap/bc/adt/cts/transports` | `POST` | **Create an object-oriented correction request**. ASX body fields: `OPERATION`, `DEVCLASS`, `REQUEST_TEXT`, optional `REQUEST_PROJECT`, optional `REQUEST_CHANGE_GUID`, and `REF`. Optional query parameter: `transportLayer`. `Accept: text/plain`; the response is a request URL whose last segment is the request number. Live-verified. |
| `/sap/bc/adt/cts/transportrequests` | `POST` | **Create an explicit request plus initial tasks** with `tm:useraction="newrequest"`. Supports request type `K` (Workbench), `W` (Customizing), and `T` (Transport of Copies). Use Transport Organizer v1 XML for both `Content-Type` and `Accept`. Native-ADT-confirmed; not yet live-probed by this project. |
| `/sap/bc/adt/cts/transportrequests` | `GET` | **List/search requests**. Common query parameters: `user` or `targetuser`, `requestType`, `requestStatus`, `releasedFromDate`, `releasedToDate`, `configUri`, and `targets=true`. The response groups requests under `tm:workbench`, `tm:customizing`, and, where supported, `tm:transportofcopies`. The older lightweight API also uses `trfunction` plus `_action=FIND`. |
| `/sap/bc/adt/cts/transportrequests/{id}` | `GET` | **Request or task detail** including tasks, object registrations, attributes, and HATEOAS action links. `Accept: application/vnd.sap.adt.transportorganizer.v1+xml`. Live-verified. |
| `/sap/bc/adt/cts/transportrequests/{id}` | `PUT` | **Change request attributes**, including description. Follow the detail response's `http://www.sap.com/cts/relations/changeattributes` link rather than assuming the URL. For rename, send `tm:number`, new `tm:desc`, and the current `tm:target`; omitting `tm:target` can silently clear the CTS route. Unreleased requests only. Live-verified. |
| `/sap/bc/adt/cts/transportrequests/{id}` | `DELETE` | **Delete an unreleased empty request**. A request containing registered/locked objects is rejected. Live-verified. |
| `/sap/bc/adt/cts/transportrequests/{id}/tasks` | `POST` | **Add another task** using `tm:useraction="newtask"`. Prefer the detail response's `http://www.sap.com/cts/relations/newtask` link. This is unnecessary immediately after either creation contract when an initial task was already requested or auto-created. Live-verified. |
| `/sap/bc/adt/cts/transportrequests/{id}/newreleasejobs` | `POST` | **Normal release**. Prefer relation `http://www.sap.com/cts/relations/newreleasejobs`. The HTTP response may be 200 while `chkrun:checkReport` reports an abort/error, so inspect the XML body. Live-verified. |
| `/sap/bc/adt/cts/transportrequests/{id}/relwithignlock` | `POST` | **Release while ignoring object locks**. Relation: `http://www.sap.com/cts/relations/relwithignlock`. |
| `/sap/bc/adt/cts/transportrequests/{id}/relObjigchkatc` | `POST` | **Release while ignoring ATC findings**. Relation spelling is lowercase `http://www.sap.com/cts/relations/relobjigchkatc`; endpoint spelling is backend-provided and should be taken from the link. |
| `/sap/bc/adt/cts/transportrequests/{id}/relwithignwarning` | `POST` | **Release while ignoring warnings**, when advertised by relation `http://www.sap.com/cts/relations/relwithignwarning`. Native-ADT-confirmed; backend availability varies. |
| `/sap/bc/adt/cts/transportrequests/reference` | `GET` | **Find a request for an object** with `pgmid`, `obj_wbtype`, and `obj_name` (for example `pgmid=R3TR&obj_wbtype=CLAS&obj_name=ZCL_FOO`). Returns an `atom:link`; follow its `href` to retrieve the matching request data. Live-verified. |
| `/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations` | `GET/POST` | **Read or maintain search configurations** used by the Transport Organizer tree. |
| Discovery-provided value-help links | `GET` | **Value help** for target, CTS project, attribute, and object. Relations end in `/transportrequests/valuehelp/target`, `/ctsproject`, `/attribute`, and `/object`; use their advertised URI templates and query parameters rather than constructing paths. |
| Discovery-provided facets link | `GET` | **Transport search facets**. Relation: `http://www.sap.com/adt/categories/cts/transportrequests/facets`; media type `application/vnd.sap.adt.transportorganizer.facets.v1+xml`. |

### Create an explicit Customizing request and tasks

Use request type `W`. Each `tm:task` child creates a task for that owner in the
same operation. The native ADT wizard permits multiple owners. Its default
target for an empty target field is `LOCAL`; for a transportable request, pass
the real target returned by the target value help instead of guessing it.

```http
POST /sap/bc/adt/cts/transportrequests
Content-Type: application/vnd.sap.adt.transportorganizer.v1+xml
Accept: application/vnd.sap.adt.transportorganizer.v1+xml
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"
         tm:useraction="newrequest">
  <tm:request tm:type="W"
              tm:target="/TARGET/"
              tm:desc="Customizing request description">
    <tm:task tm:owner="DEVELOPER1"/>
    <tm:task tm:owner="DEVELOPER2"/>
  </tm:request>
</tm:root>
```

Optional request attribute `tm:cts_project="..."` assigns a CTS project. The
response is Transport Organizer XML; read `tm:request/@tm:number` and each
`tm:task/@tm:number` rather than parsing a plain-text URL.

Request category codes used by native ADT:

| Code | Request category |
| :--- | :--- |
| `K` | Workbench request |
| `W` | Customizing request |
| `T` | Transport of Copies |

### Create an object-oriented correction request

This older contract is still the correct one when object creation/save needs a
request chosen from `DEVCLASS` and `REF`:

```http
POST /sap/bc/adt/cts/transports[?transportLayer=...]
Content-Type: application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest
Accept: text/plain
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <OPERATION>I</OPERATION>
      <DEVCLASS>ZPACKAGE</DEVCLASS>
      <REQUEST_TEXT>Workbench request description</REQUEST_TEXT>
      <REF>/sap/bc/adt/oo/classes/ZCL_EXAMPLE</REF>
    </DATA>
  </asx:values>
</asx:abap>
```

The v1 data-name variant
`com.sap.adt.CreateCorrectionRequest.v1` additionally supports
`REQUEST_PROJECT` and `REQUEST_CHANGE_GUID` when discovery advertises that
media type. SAP creates the request's first task automatically in the behavior
live-verified by this project.

### Add a task to an existing request

```http
POST /sap/bc/adt/cts/transportrequests/{request}/tasks
Content-Type: text/plain
Accept: application/*
```

```xml
<?xml version="1.0" encoding="ASCII"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"
         tm:number="DEVK900123"
         tm:targetuser="DEVELOPER2"
         tm:useraction="newtask"/>
```

The response root carries `tm:number`, `tm:targetuser`, `tm:uri`, and
`tm:useraction`; the new task number is the last segment of `tm:uri`.

## 5. Code Analysis, Navigation & Refactoring
Endpoints for syntax, completion, and modifying code structure.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/checkruns` | `POST` | **Syntax Check**: Validates code (`reporters=abapCheckRun`). |
| `/sap/bc/adt/checkruns/reporters` | `GET` | **Check Types**: Lists supported check reporters. |
| `/sap/bc/adt/abapsource/codecompletion/proposal` | `POST` | **Completion**: Suggests code completion. |
| `/sap/bc/adt/abapsource/codecompletion/elementinfo`| `POST` | **Element Info**: Details for a completion item. |
| `/sap/bc/adt/navigation/target` | `POST` | **Navigation**: "F3" functionality (Find Definition). |
| `/sap/bc/adt/repository/informationsystem/usageReferences` | `POST` | **References**: "Where-Used" list. |
| `/sap/bc/adt/abapsource/typehierarchy` | `POST` | **Hierarchy**: Type hierarchy (Super/Sub classes). |
| `/sap/bc/adt/abapsource/prettyprinter` | `POST` | **Format**: Pretty Print code. |
| `/sap/bc/adt/abapsource/prettyprinter/settings` | `GET/PUT` | **Settings**: Pretty Printer config. |
| `/sap/bc/adt/quickfixes/evaluation` | `POST` | **Quick Fixes**: Get quick fix proposals. |
| `/sap/bc/adt/refactorings` | `POST` | **Refactor**: Rename, Extract Method (`step=evaluate/preview/execute`). |
| `/sap/bc/adt/docu/abap/langu` | `POST` | **ABAP Doc**: Retrieves ABAP documentation (F1). |

## 6. Quality Assurance (ATC & Unit Test)
Endpoints for automated quality control.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/abapunit/testruns` | `POST` | **ABAP Unit**: Runs unit tests. |
| `/sap/bc/adt/abapunit/testruns/evaluation` | `POST` | **Evaluation**: Evaluates test results. |
| `/sap/bc/adt/atc/runs` | `POST` | **ATC Run**: Starts an ATC check. |
| `/sap/bc/adt/atc/worklists` | `GET` | **ATC Results**: Gets findings. |
| `/sap/bc/adt/atc/exemptions/apply` | `GET/POST`| **Exemptions**: Manage ATC exemptions. |
| `/sap/bc/adt/atc/customizing` | `GET` | **Config**: ATC system settings. |

## 7. Data & CDS
Endpoints for database interaction and CDS.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/datapreview/ddic` | `POST` | **Table Content**: Preview table data. |
| `/sap/bc/adt/datapreview/freestyle` | `POST` | **SQL Query**: Run open SQL queries. |
| `/sap/bc/adt/ddic/ddl/elementinfo` | `GET` | **DDIC Info**: Metadata for tables/views/CDS. |
| `/sap/bc/adt/ddic/cds/annotation/definitions` | `GET` | **Annotations**: CDS annotation definitions. |
| `/sap/bc/adt/businessservices/odatav2/publishjobs`| `POST` | **Publish**: Publish Service Binding. |

## 8. Debugging & Tracing
Endpoints for runtime analysis.

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/debugger/listeners` | `POST/GET`| **Listen**: Register/List debug listeners. |
| `/sap/bc/adt/debugger/breakpoints` | `POST` | **Breakpoints**: Set/manage breakpoints. |
| `/sap/bc/adt/debugger` | `POST` | **Control**: Attach, Step, Stack, Variables (`method=...`). |
| `/sap/bc/adt/runtime/traces/abaptraces` | `GET` | **Trace List**: List SAT traces. |
| `/sap/bc/adt/runtime/traces/abaptraces/{id}/hitlist` | `GET` | **Hit List**: Performance trace hit list. |
| `/sap/bc/adt/runtime/traces/abaptraces/parameters`| `POST` | **Trace Config**: Set trace parameters. |
| `/sap/bc/adt/feeds` | `GET` | **Feeds**: Catalog of ABAP System Monitoring feed sources (Gateway error log, dumps, ATC verdicts, RAP contract violations, etc.) — most are empty unless that SAP feature is actively used; probe live before wiring one up. |
| `/sap/bc/adt/gw/errorlog` | `GET` | **Gateway Error Log**: Recent OData/Gateway (Backend + Client) service errors, system-wide, no filter/paging support (SAP silently ignores query params here). Wired up as `GetDiagnostics(resource=GW_ERRORLOG)` — see `CLAUDE.md`. |
| `/sap/bc/adt/runtime/dumps` | `GET` | **Dumps**: ABAP Short Dumps. |

## 9. ABAP Git
Endpoints for abapGit integration (if installed).

| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/abapgit/repos` | `GET/POST`| **Repos**: List or Create repositories. |
| `/sap/bc/adt/abapgit/externalrepoinfo` | `POST` | **Info**: Check external git repo info. |
| `/sap/bc/adt/abapgit/repos/{id}/pull` | `POST` | **Pull**: Pull changes. |
| `/sap/bc/adt/abapgit/repos/{id}/branches/...` | `POST` | **Branch**: Switch branch. |

## 10. System
| Endpoint (Relative Path) | Method | Description |
| :--- | :--- | :--- |
| `/sap/bc/adt/system/users` | `GET` | **Users**: List system users. |
| `/sap/bc/adt/urifragmentmappings` | `GET` | **Fragments**: Map URI fragments to locations. |

## 11. Custom `zmcp` Endpoints (project-built, NOT SAP-standard ADT)

These are **not** ADT resources — SAP ships no REST surface for the gaps they cover (SU21
authorization objects, cross-request object reassignment, language-specific text-pool writes,
classic Dynpro screens, one-off dispatch utilities). Each is a standalone SICF service under `default_host/zmcp/*`,
backed by its own ABAP `IF_HTTP_EXTENSION` handler class in package `ZMCP`, created via this
project's own `ManageSicfNode(action=create_sicf_node)` tool rather than a manual SAP Basis SICF
step — see `CLAUDE.md`'s `ManageSicfNode`-adjacent tool sections for the live incident history
behind each one. All seven require `sap-client` + Basic Authentication like any other endpoint in
this document, plus CSRF handling on any non-`GET` call (`X-CSRF-Token: Fetch` on the first
request, then present the token on the mutating one) — same `makeAdtRequest` plumbing as every
ADT call in this codebase, nothing endpoint-specific.

| Endpoint (Relative Path) | Method | Handler class | Description |
| :--- | :--- | :--- | :--- |
| `/zmcp/dispatch` | `GET/POST` | `ZCL_MCP_DISPATCH` | **Shared action router** — the original bootstrap node. Query/body param `action` selects a `CASE`-dispatched ABAP-side branch (`ping`, `echo_upper`, `create_sicf_node`, `delete_sicf_node`); `payload` is opaque, its shape defined by the chosen action. Reserved for small, genuinely reusable utility actions — a feature with its own real surface area gets its own standalone endpoint instead (see the three below), not a new `WHEN` branch here. Wired up as `ManageSicfNode`. |
| `/zmcp/auth_object` | `POST` | `ZCL_HTTP_MCP_AUTH_OBJECT` | **SU21 Authorization Object create/update**, wrapping `CL_SUSO_APPL` (the real SU21 engine — there is no ADT collection for authorization objects at all). Query params `mode` (`create`/`update`), `object_class` (required on create, optional class change on update), `object_name`, `description`, `devclass`, `trkorr`, `activities` (comma-separated permitted `ACTVT` codes, e.g. `02,03`, written to `TACTZ`); body is a comma-separated field-name list. Plain-text response, not ADT XML. HTTP 400 for validation failures (including an invalid activity list), 404 not found, 409 already exists or field list locked (the object is in use), 422 SU21 save failed. Wired up as `ManageAuthObject` — see `CLAUDE.md`'s `ManageAuthObject Tool` section for the two-phase `CL_SUSO_APPL` save mechanism and live-verified DDIC facts. |
| `/zmcp/transport_admin` | `POST` | `ZCL_HTTP_MCP_TRANSPORT_ADMIN` | **Move/reassign or remove a repository object's CTS registration**, dispatched by form param `action` (`move_object`, default, or `delete_object`). `move_object` wraps `ZCL_MCP_TRANSPORT_ADMIN=>move_object` (layered on `TR_MOVE_OBJECTS`, the engine behind SE01/SE09's right-click "Move"); params `pgmid` (default `R3TR`), `object_type`, `object_name`, `target_trkorr`. `delete_object` wraps `ZCL_MCP_TRANSPORT_ADMIN=>delete_object` (layered on `TR_DELETE_COMM_OBJECT_KEYS`, the engine behind SE01/SE09's right-click "Delete Object" — confirmed live: no ADT REST endpoint reaches this on this SAP release, its `removeobject` HATEOAS link is registered but never dispatched by SAP's own backend class); params `pgmid`, `object_type`, `object_name`, `trkorr` (the task/request currently holding the entry). No body either way. Wired up as `ManageTransport` `action=move_object`/`merge`/`remove_object` — see `CLAUDE.md`'s `ManageTransport — move_object / merge` and `— remove_object` sections for the full mechanism history and task-vs-request resolution trap. |
| `/zmcp/textpool` | `GET/PUT` | `ZCL_HTTP_MCP_TEXTPOOL` | **Language-specific text-pool read/write** (symbols, selections, headings, title), bypassing `/sap/bc/adt/textelements/...`'s complete lack of a language parameter (proven live: byte-identical output regardless of session language/headers/query params) and its non-deterministic write behavior across session languages. `GET` query params `program`, `language` (ISO 2-char like `ZF`/`EN`, or internal 1-char SAP code like `M`/`E` — resolved server-side via `CONVERSION_EXIT_ISOLA_INPUT`), `category`. `PUT` adds `devclass`, optional `trkorr`, optional `delete_keys` (comma-separated, `symbols`/`selections` categories only); body is the new text-pool content, `Content-Type: text/plain; charset=utf-8`. Wired up as `TextPoolLang`. |
| `/zmcp/dynpro` | `GET/POST/DELETE` | `ZCL_HTTP_MCP_DYNPRO` | **Classic Dynpro (SAP GUI screen) read/write.** Standard ADT has none: a program's `objectstructure` lists its screens as `PROG/PS` with a VIT URI (`/sap/bc/adt/vit/wb/object_type/progps/object_name/{PROG padded to 40}{DYNNR}`), but that URI only returns basic properties — element list and flow logic live compressed in `DYNPSOURCE`. Wraps `RPY_DYNPRO_READ` / `RPY_DYNPRO_INSERT` / `RS_SCRP_DELETE` / `RS_SCRP_CONS_CHECK_TODO_SINGLE` via `ZCL_MCP_DYNPRO`. `GET ?program=X` → JSON list `[{dynnr,type,description}]`; `GET ?program=X&dynnr=NNNN` → JSON `{header, containers, fields_to_containers, flow_logic, params}` (the `RPY_*` external structures, lower-case DDIC names — the shape `RPY_DYNPRO_INSERT` takes); `GET …&check=true` → SE51 consistency check. `POST ?program&dynnr&mode=create\|update[&trkorr]` with that JSON as body; `DELETE ?program&dynnr[&trkorr]`. POST and `check=true` set header `x-mcp-check: errors\|warnings\|ok`. Type codes (`RPY_DYHEAD-TYPE`): `N` normal, `I` subscreen, `M` modal dialog, `S`/`J`/`W` selection screen (normal / `AS SUBSCREEN` / as modal dialog). Plain-text errors: 400 bad input / not supported / transport problem, 403 no `S_DEVELOP`, 404 not found, 409 already exists or locked in a different request, 422 generation failed or missing `CALL SUBSCREEN` (nothing saved), 500 read failed. Own exception class `ZCX_MCP_DYNPRO` (no dispatcher dependency). Wired up as `GetCode resource=DYNPRO` and `ManageDynpro`. |
| `/zmcp/lock_admin` | `POST` | `ZCL_HTTP_MCP_LOCK_ADMIN` | **Report or delete the connecting user's own SM12 enqueue entries for one object** (`UnlockObject force=true`). Form params `object_name`, `delete=X` (without it: report only). `ENQUEUE_READ` with `guname = sy-uname`, whole-name match (client prefix and `U+FFFF` padding stripped), each entry re-checked for user and client, then `ENQUE_DELETE` (one U — `ENQUEUE_DELETE` does not exist). Cannot tell an orphan from a live editor of the same user. |
| `/zmcp/session_admin` | `POST` | `ZCL_HTTP_MCP_SESSION_ADMIN` | **List or end the connecting user's own ABAP sessions on every application server** (`ManageSessions`). Form params `action=list|end`, `ids=server:tid,…`, `min_age` (minutes, default 2). `TH_SERVER_LIST` + `TH_USER_LIST DESTINATION <server>`; `end` uses `TH_DELETE_USER` and refuses the current session, non-HTTP kinds, sessions younger than `min_age`, and `tid = -1`; every id is re-validated against a fresh list because tids are reused at once. |
