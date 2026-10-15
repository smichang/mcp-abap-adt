# mcp-abap-adt: Your Gateway to ABAP Development Tools (ADT)

This project provides an [MCP](https://modelcontextprotocol.io/) server that lets AI coding agents such as OpenCode, Claude Code or Cline interact with SAP ABAP systems through ADT. It can retrieve source code and metadata, inspect packages and transports, run ABAP Unit and ATC checks, preview data, and write or activate ABAP objects.

**Repository:** <https://github.com/smichang/mcp-abap-adt>

## Purpose

This project exists for three goals:

1. **Free your hands.** The AI agent does the ABAP work end to end — you describe the outcome and review the result instead of clicking through SE80, SE09, SE11, SE91, SE51, SU21 or SM12.
2. **Cover the whole ABAP development cycle.** Every stage has a tool, so no step forces you back into SAP GUI or Eclipse:

   | Stage | Tools |
   |---|---|
   | Discover & read | `SearchObject`, `GetCode` (source, versions, enhancements, where-used, screens), `GetMeta` (packages, types, transactions, transports, message classes, DDIC, inactive objects), `DataPreview` |
   | Create & change | `WriteProgram` (programs, includes, classes and their local test/definition includes, interfaces, function groups/modules, text elements; patch mode via `edits[]`), `ManageDDIC`, `ManageMessageClass`, `ManageDynpro`, `ManageAuthObject`, `ManagePackage`, `TextPoolLang` |
   | Transport | `ManageTransport` (create, rename, assign, move, merge, release, delete) |
   | Activate | `ActivateObjects` (mass activation, RFC toggle) |
   | Test & quality | `RunUnitTest`, `RunATCCheck` (objects, packages, worklists), `RunABAP` (run a class or report, get its output), `GetCode resource=SYNTAX` |
   | Diagnose & recover | `GetDiagnostics` (dumps, traces, gateway errors), `UnlockObject` (incl. `force`), `ManageSessions`, `DeleteObject` |
   | Extend SAP side | `ManageSicfNode` plus the optional ABAP endpoints in [`abap-tasks/`](abap-tasks) |

3. **Recursive self-improvement.** If a manual step is still left — a transaction you had to open, a lock you had to clear in SM12, a setting only SAP GUI exposes — that is a bug in this project, not a fact of life. The agent should:
   1. probe the live system to find an ADT endpoint, a function module or a class that does the job (see "Discovering & Verifying ADT Endpoints" in `CLAUDE.md`);
   2. if standard ADT has no contract, add a small standalone SICF endpoint under [`abap-tasks/`](abap-tasks) (this is how `ManageAuthObject`, `ManageDynpro` and the `ManageTransport` move/merge/remove actions came about);
   3. wrap it as a new tool or a new action of an existing tool, following the 3-step pattern in `CLAUDE.md`, and cover it with a live test that only touches its own `$TMP`/`ZMCP_*` fixtures;
   4. record the traps it hit in `docs/TOOL_INTERNALS.md` and the agent skill, so the next session starts from the improved toolset instead of rediscovering them.

   Each manual step that gets automated shrinks the gap between "the AI can help" and "the AI does it".

## Recommended Setup

1. Install Git, Node.js LTS, and npm.
2. Clone this repository and install dependencies.
3. Create `.env` with the SAP connection settings.
4. Build the server.
5. Register the local MCP server in your MCP client (e.g. `opencode.json`).

## Security Notes

- Never commit `.env`, SAP passwords, OAuth tokens, API keys, or other credentials.
- Do not put SAP credentials in `opencode.json`.
- Treat `WriteProgram`, `ManageDDIC`, `ActivateObjects`, `ManageTransport`, `TextPoolLang` (`action=write`), `ManageSicfNode` (`action=create_sicf_node`/`delete_sicf_node`), `ManageAuthObject`, `ManageDynpro`, `ManageMessageClass`, and `DeleteObject` as write-capable operations.
- `DeleteObject` is destructive and hard to reverse — treat it with extra caution beyond the other write-capable tools.
- Prefer read-only tools when exploring production systems.
- Do not enable automatic approval for write-capable tools unless your local policy allows it.

## 1. Install and Configure

Clone the repository and build it:

```bash
git clone https://github.com/smichang/mcp-abap-adt.git
cd mcp-abap-adt
npm install
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Set these values in `.env`:

```dotenv
SAP_URL=https://your-sap-host:44300
SAP_USERNAME=your_username
SAP_PASSWORD=your_password
SAP_CLIENT=100
SAP_LANGUAGE=EN
```

Build the MCP server:

```bash
npm run build
```

Run `npm run build` again after every source change. The generated server entry point is `dist/index.js`.

### Optional: encrypted secrets keystore instead of plaintext `.env`

Local dev can keep using plaintext `.env` — this is opt-in and never a required migration.
For a deployment server, run `node scripts/setup-secrets.js` to convert an existing `.env`
into an AES-256-GCM encrypted keystore (`secret/secrets.json` + `secret/keystore.key`) and
optionally delete the plaintext file afterward. Point the MCP client's env block at:

```dotenv
SECRETS_KEYSTORE=/path/to/secret/secrets.json
SECRETS_KEYSTORE_PASSWORD_FILE=/path/to/secret/keystore.key
```

Credentials resolve in order — real process env, then the keystore (if `SECRETS_KEYSTORE`
is set), then `.env` — so an operator override always wins and the mechanism is a no-op
when `SECRETS_KEYSTORE` isn't set. Rotate one credential later with
`node scripts/setup-secrets.js --rotate SAP_PASSWORD`. Run the setup script on the server
itself in a real terminal, never through an AI tool — it reads/writes real credentials. See
`docs/TOOL_INTERNALS.md` → "Secrets Keystore" for the full design.

> **If this one `dist/index.js` install is shared by several projects' own MCP config
> files** (each project has its own MCP config, but they all point at the same
> built server), deleting the shared `.env` breaks every one of those configs whose server
> entry has an empty `env` block — that block was silently falling through to the now-gone
> `.env`. Add `SECRETS_KEYSTORE`/`SECRETS_KEYSTORE_PASSWORD_FILE` to each such entry.
> **Leave alone** any entry that already sets its own `SAP_URL`/`SAP_USERNAME`/`SAP_PASSWORD`/`SAP_CLIENT`
> inline (e.g. a per-project override pointing at a different SAP client/system) — a real
> env var always wins over the keystore, so those entries neither need nor use it.

## 2. Configure Your MCP Client

The server is a local stdio MCP server. Build it first, then register it in your client. For OpenCode, add this to `opencode.json` at the workspace root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp-abap-adt": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp-abap-adt/dist/index.js"],
      "enabled": true
    }
  }
}
```

The client starts the server automatically; you do not need to run `npm run start` separately. For Claude Code, Roo Code, Cline, Gemini CLI and others, see [OTHER_MCP_CLIENTS.md](OTHER_MCP_CLIENTS.md).

Test the connection with a request such as:

```text
Use the mcp-abap-adt MCP server and search for ABAP object SAPMV45A.
```

## 3. Optional: ABAP-side Endpoints

A few tools (`ManageAuthObject`, `ManageDynpro`, `TextPoolLang`, `ManageSicfNode`, `ManageSessions`, `UnlockObject force=true`, and the `move_object`/`merge`/`remove_object` actions of `ManageTransport`) cover things standard ADT does not expose. They call small custom SICF services whose source is in [`abap-tasks/`](abap-tasks). To use them, follow [`abap-tasks/README.md`](abap-tasks/README.md): package `ZMCP`, one manual SICF step, after which the AI installs the rest under `default_host/zmcp`; every other tool works against stock ADT.

## Agent Skill

A ready-made skill for coding agents lives in [`.claude/skills/mcp-abap-adt`](.claude/skills/mcp-abap-adt) (`SKILL.md` plus `references/tool-reference.md`). It teaches the lock → write → unlock → activate workflow, transport handling, serialization of lock-taking calls and common failure recoveries. Claude Code and OpenCode discover `.claude/skills` automatically; for other agents copy the folder into their skills directory.

## 4. Run and Debug the Server

Standalone mode is useful for checking that the process starts:

```bash
npm run start
```

Development mode starts the MCP Inspector:

```bash
npm run dev
```

Open the Inspector URL printed in the terminal. It can be used to inspect the available tools and test requests independently of your MCP client.

## 5. Long-Running Tools

Some SAP operations can exceed a client's request timeout. These tools support `background=true` and `output_file`:

- `RunATCCheck`
- `GetCode` (`resource=ENHANCEMENTS` or `resource=WHEREUSED`)
- `GetMeta` (`resource=PACKAGE`)
- `DataPreview`

Example request:

```text
Run an ATC check for transport DEVK900123 in background mode and write the result to /absolute/path/to/atc.md.
```

The tool returns a file path immediately and writes the final result to that file when the SAP operation finishes.

## 6. Troubleshooting

- **`node` or `npm` is not found:** Install Node.js LTS and open a new terminal.
- **The MCP server is unavailable:** Run `npm run build`, confirm `dist/index.js` exists, and check that the path in your MCP client configuration is correct.
- **SAP authentication fails:** Check `SAP_URL`, `SAP_USERNAME`, `SAP_PASSWORD`, and `SAP_CLIENT` in `.env`.
- **A write operation fails:** Check for SAP locks, transport requirements.
- **`WriteProgram` cannot save a source:** The response distinguishes a pre-activation source PUT failure from an activation/compiler failure and reports source bytes, line count, and maximum line length. A physical source line over 255 characters is rejected before SAP is called. For a concise PUT error that needs deeper investigation, retry with `include_raw_sap_response=true`; do not assume a generic save failure is a CTS or inactive-object problem. `OO_SOURCE_BASED011` points to class source splitting (check `CLASS-METHODS` section order); `OO_SOURCE_BASED012` points to source-level comments SAP cannot store.

## 7. Available Tools

The server exposes tools for:

- Reading ABAP programs, includes, classes, interfaces, function modules, tables, structures, DDIC objects, transactions, versions, dumps, traces, enhancements, the Gateway (OData/Fiori) error log, and objects pending activation.
- Searching repository objects and finding where-used references.
- Browsing packages and inspecting CTS transports.
- Running ABAP Unit tests, ATC checks, data previews, and mass activation.
- Writing ABAP source and managing transport requests, including moving/reassigning an object between tasks or requests, merging one transport's objects into another, and clearing a locked object entry left behind after deleting the underlying object.
- Creating or updating DDIC structures, table types, data elements, domains, and CDS view entities via their native ADT contracts.
- Reading and writing a program's text pool (symbols, selections, headings, title) in an explicit target language, independent of the object's master language.
- Creating or deleting a custom SICF node under `default_host/zmcp`.
- Creating or updating a custom SU21 Authorization Object and its fields, including `ACTVT` with its permitted activities (SU21 has no native ADT surface, so this goes through its own standalone endpoint under `default_host/zmcp`). Define the full field list before any code checks the object: SU21 locks the fields once the object is in use.
- Deleting an ABAP repository object (program, include, class, function module, ...) outright, with a lock/unlock cycle and CTS transport handling.
- Reading and writing classic SAP GUI screens (Dynpro) of customer programs: list a program's screens, read a screen's attributes, elements and flow logic, and create/update/delete a screen — including SE51's Attributes tab (screen type, next screen, Settings checkboxes) — with SE51's consistency check after every write. Standard ADT has no screen contract, so this goes through its own standalone endpoint under `default_host/zmcp`.

The exact tool names and input schemas are registered in `src/index.ts`. Use your client's MCP tool list or `npm run dev` with the MCP Inspector for the current schema.

## License

MIT — see [LICENSE](LICENSE). Originally forked from [mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt).
