# ABAP-side endpoints (optional)

Most tools in this server talk to stock ADT and need nothing installed on SAP. A few capabilities have **no ADT REST surface at all**, so they go through small custom HTTP services (plain `IF_HTTP_EXTENSION` classes bound to SICF nodes). This folder holds their source.

| Tool / action | SICF node (under `default_host/zmcp`) | Handler class | Core class |
|---|---|---|---|
| `ManageSicfNode` (create/delete further nodes, `ping`) | `dispatch` | `ZCL_HTTP_MCP_DISPATCH` | `ZCL_MCP_DISPATCH`, `ZCL_MCP_SICF_ADMIN`, `ZCX_MCP_DISPATCH` |
| `TextPoolLang` | `textpool` | `ZCL_HTTP_MCP_TEXTPOOL` | `ZCL_MCP_TEXTPOOL`, `ZCX_MCP_TEXTPOOL` |
| `ManageAuthObject` (SU21) | `auth_object` | `ZCL_HTTP_MCP_AUTH_OBJECT` | `ZCL_MCP_AUTH_OBJECT`, `ZCX_MCP_AUTH_OBJECT` |
| `ManageTransport` `move_object` / `merge` / `remove_object` | `transport_admin` | `ZCL_HTTP_MCP_TRANSPORT_ADMIN` | `ZCL_MCP_TRANSPORT_ADMIN` |
| `ManageDynpro`, `GetCode resource=DYNPRO` | `dynpro` | `ZCL_HTTP_MCP_DYNPRO` | `ZCL_MCP_DYNPRO`, `ZCX_MCP_DYNPRO` |

Naming scheme: package `ZMCP`, SICF parent node `zmcp`, handler `ZCL_HTTP_MCP_<X>`, logic `ZCL_MCP_<X>`, exception `ZCX_MCP_<X>`, message class `ZMCP_<X>`. If you need another prefix, rename consistently — the URLs `/zmcp/<node>` are hard-coded in `src/handlers/`.

Source layout: one file per class, `NAME.clas.abap`, containing the complete class source (definition + implementation). Local test classes are separate files.

## The idea: one manual step, then the AI does the rest

SICF nodes can only be created by something that already runs inside SAP. So:

1. **You** create the package and the parent SICF node once (steps 1–2).
2. **The AI** writes the classes with `WriteProgram` (step 3) — no copy-and-paste into SE24.
3. **You** create exactly one more SICF node by hand: `dispatch`, bound to `ZCL_HTTP_MCP_DISPATCH` (step 4).
4. From then on the AI creates every other node itself with `ManageSicfNode action=create_sicf_node` (step 6).

If you would rather not let the AI write the classes, paste them in by hand in ADT/Eclipse (create class, replace its source with the file, activate) in the order given in step 3.

## Prerequisites

- SAP NetWeaver 7.50+ / S/4HANA (the code uses inline declarations, `xsdbool`, string templates).
- The MCP server already works against the system (`SearchObject` returns results).
- Your SAP user has developer authorization, `S_ICF` / SICF maintenance rights (for step 4 and for `create_sicf_node`), and a workbench transport if the package is transportable.
- The `INDX` cluster table is used for CSRF tokens (area `ZT`, one row per user); standard, nothing to create.

## Step 1 — Package

SE21 (or ADT): create package `ZMCP`, e.g. "MCP ADT gateway endpoints". Use `$TMP`-style local if you only experiment; use a transportable package if you want to move the endpoints to other systems.

## Step 2 — Parent SICF node `zmcp`

1. Transaction `SICF`, hierarchy type `SERVICE`, press F8.
2. Right-click `default_host` → **New Sub-Element** → name `zmcp`, description "MCP endpoints".
3. Save into package `ZMCP`. The node needs **no handler** and no logon data of its own — it is only the parent. Activate it (right-click → Activate Service).

## Step 3 — Classes of the dispatcher (AI or by hand)

Ask the AI (or do it manually) to create these four classes in package `ZMCP`, in this order, activating all four together:

1. `ZCX_MCP_DISPATCH`
2. `ZCL_MCP_SICF_ADMIN`
3. `ZCL_MCP_DISPATCH`
4. `ZCL_HTTP_MCP_DISPATCH`

Optionally also `ZCL_MCP_DISPATCH_TEST` (ABAP Unit; `RunUnitTest` proves the dispatcher logic).

With the MCP tools this is, for each class (one at a time — see "serial writes" in the skill):

```text
WriteProgram program_name=ZCX_MCP_DISPATCH object_type=CLAS package_name=ZMCP
             description="MCP dispatcher exception" transport_number=<yours>
             source_file=abap-tasks/zmcp-dispatcher/src/ZCX_MCP_DISPATCH.clas.abap activate=false
... (the other three the same way, activate=false)
ActivateObjects names=[ZCX_MCP_DISPATCH, ZCL_MCP_SICF_ADMIN, ZCL_MCP_DISPATCH, ZCL_HTTP_MCP_DISPATCH]
```

Optional but recommended: message class `ZMCP_DISPATCH` (`ManageMessageClass`) so error texts render properly:

| No | Text |
|---|---|
| 001 | `Unknown action &1` |
| 002 | `Permission denied for action &1` |
| 003 | `Bad request for action &1: &2` |

The same applies to `ZMCP_TEXTPOOL`, `ZMCP_AUTH_OBJECT` (001–010) and `ZMCP_DYNPRO` (001–010) if you install those endpoints; the handlers build most error text themselves, so a missing message class is cosmetic, not fatal.

## Step 4 — Manual SICF node `dispatch`

1. `SICF` → right-click `default_host/zmcp` → New Sub-Element → name `dispatch`.
2. **Handler List** tab: add `ZCL_HTTP_MCP_DISPATCH`.
3. **Logon Data** tab: set the same logon procedure the ADT node `/sap/bc/adt` uses — *Alternative Logon Procedure* with *Basic Authentication* ticked (open `default_host/sap/bc/adt` side by side and copy). No anonymous user. The handler relies on SICF having authenticated the caller (`sy-uname`).
4. Save into package `ZMCP`, then right-click → **Activate Service**.

## Step 5 — Verify

```bash
curl -k -u USER:PASS -H "sap-client: 100" \
  "https://your-sap-host:44300/zmcp/dispatch?action=ping&payload=hello"
```

Expect `pong`, `uname: USER`, a timestamp and `payload: hello`. Or use the tool: `ManageSicfNode action=ping payload=hello method=GET`.

Failure guide: `404` = node missing or inactive; `401` = logon data not set to Basic Authentication; `403 CSRF token validation failed` on POST = send `X-CSRF-Token: Fetch` first (the MCP tool does this automatically).

## Step 6 — Everything else: the AI takes over

For each further endpoint: write its classes with `WriteProgram`, activate, then create the node.

```text
ManageSicfNode action=create_sicf_node method=POST
  payload="name=textpool\nhandler_class=ZCL_HTTP_MCP_TEXTPOOL\ndocu=MCP text pool endpoint\ntransport=<yours>"
```

`ZCL_MCP_SICF_ADMIN` always creates the node **directly under `default_host/zmcp`**, with package `ZMCP`, active, and the same logon procedure as the dispatcher — it can never create a node elsewhere. Install order of the remaining endpoints is free; each one is independent:

| Endpoint | Classes to write first (in order) | Node `name=` |
|---|---|---|
| Text pool | `ZCX_MCP_TEXTPOOL`, `ZCL_MCP_TEXTPOOL`, `ZCL_HTTP_MCP_TEXTPOOL` | `textpool` |
| SU21 auth object | `ZCX_MCP_AUTH_OBJECT`, `ZCL_MCP_AUTH_OBJECT`, `ZCL_HTTP_MCP_AUTH_OBJECT` | `auth_object` |
| Transport admin | `ZCL_MCP_TRANSPORT_ADMIN`, `ZCL_HTTP_MCP_TRANSPORT_ADMIN` | `transport_admin` |
| Dynpro | `ZCX_MCP_DYNPRO`, `ZCL_MCP_DYNPRO`, `ZCL_HTTP_MCP_DYNPRO` | `dynpro` |

Activate each group with one `ActivateObjects` call (the exception class and core class must be active before the handler compiles).

Deleting a node: `ManageSicfNode action=delete_sicf_node payload="name=textpool"`.

## Adding your own endpoint later

Copy the shape: a handler class implementing `IF_HTTP_EXTENSION` (CSRF-token handling is in `ZCL_HTTP_MCP_DISPATCH` — copy it verbatim), a logic class that raises its own exception, a node created with `create_sicf_node`, and a TypeScript handler in `src/handlers/` that calls `/zmcp/<node>`. Tiny actions (like `ping`) can instead be a new `WHEN` branch in `ZCL_MCP_DISPATCH=>dispatch` — a normal `WriteProgram` change, no new node. See the repo's `CLAUDE.md` for the decision rule and the traps already found (dialog-free CTS APIs, 50-char `get_text()` truncation, `INDX` instead of session memory for CSRF).

## Security notes

- Every endpoint runs as the **authenticated user**; SAP authorizations (`S_DEVELOP`, `S_TRANSPRT`, `S_ICF`, SU21 rights, …) apply exactly as in the GUI. Give the MCP user no more than a developer needs.
- `ZCL_MCP_DISPATCH` is a static `CASE` over known actions — never dynamic class instantiation from the request. Keep it that way.
- Mutating requests require the CSRF token; tokens expire after 15 minutes.
- Restrict network access to the SAP HTTPS port as you would for ADT itself.

## What is *not* included

Test programs for the dynpro endpoint were left out because they depended on screens of a private system. The dispatcher's ABAP Unit class is included.
