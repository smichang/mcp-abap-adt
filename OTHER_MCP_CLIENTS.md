# Other MCP Clients

OpenCode is covered in the main [README](README.md#2-configure-your-mcp-client). This file covers Cline, Claude Code, Roo Code, and Gemini CLI.

All clients need the server built first (`npm install && npm run build`, see the README) and use the absolute path to `dist/index.js`. On Windows, use backslashes in paths (e.g. `C:\path\to\mcp-abap-adt\dist\index.js`).

Every JSON config sample below with an empty or missing `env` block relies on this server's own `.env` at the install path — normal default behavior. If that install has been switched to the [encrypted secrets keystore](README.md#optional-encrypted-secrets-keystore-instead-of-plaintext-env) instead (its `.env` deleted), add the same two variables to each client config's `env` block instead of leaving it empty:

```json
"env": {
  "SECRETS_KEYSTORE": "/absolute/path/to/mcp-abap-adt/secret/secrets.json",
  "SECRETS_KEYSTORE_PASSWORD_FILE": "/absolute/path/to/mcp-abap-adt/secret/keystore.key"
}
```

This applies per config file, not per machine — if several projects each point their own client config at the same shared install, every one of them with an empty `env` block needs this, since dotenv resolves `.env` relative to the server's own directory, not the caller's.

## Cline (VS Code Extension)

Cline is a VS Code extension that connects to MCP servers. Install it from the VS Code marketplace, then open Cline's MCP settings and add this server:

```json
{
  "mcpServers": {
    "mcp-abap-adt": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-abap-adt/dist/index.js"],
      "disabled": false
    }
  }
}
```

On Windows, replace the argument with a JSON-safe path such as `C:/absolute/path/to/mcp-abap-adt/dist/index.js` or use escaped backslashes. Cline should show the server in its MCP Servers panel after reloading the extension. Test it by asking Cline to search for an ABAP object.

Do not copy an `autoApprove` list blindly. If you enable automatic approval, define only the tools allowed by your security policy because this server includes write and activation operations.

## Cline CLI with SAP AI Core

Cline CLI can run this server from a terminal and use SAP AI Core as the model provider. Install and verify it with:

```bash
npm install -g cline
cline --version
cline --help
```

Configure the provider interactively. Use your own SAP AI Core client ID, client secret, token URL, resource group, deployment ID, and orchestration setting:

```bash
cline auth sapaicore \
  --modelid gpt-5.5 \
  --baseurl https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com/v2
```

Cline CLI stores provider settings locally, normally in `~/.cline/data/settings/providers.json` on Linux/macOS or `%USERPROFILE%\.cline\data\settings\providers.json` on Windows. Never commit that file or its credentials. The SAP AI Core provider path requires an OpenAI-compatible deployment.

Add the MCP server to `~/.cline/data/settings/cline_mcp_settings.json` or `%USERPROFILE%\.cline\data\settings\cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "mcp-abap-adt": {
      "timeout": 60,
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-abap-adt/dist/index.js"],
      "env": {}
    }
  }
}
```

Run Cline CLI from this workspace, for example:

```bash
cline \
  --cwd /absolute/path/to/mcp-abap-adt \
    "Use the mcp-abap-adt MCP server and search for ABAP object SAPMV45A"
```

Use `--plan` when you want planning mode. Run `cline config --json` to inspect the effective configuration. Cline CLI versions may have short MCP request timeouts; use `background=true` and `output_file` for supported long-running tools such as `RunATCCheck`, `GetCode` (`resource=WHEREUSED`/`ENHANCEMENTS`), `GetMeta` (`resource=PACKAGE`), and `DataPreview`.

## Claude Code (CLI)

Claude Code is Anthropic's official CLI tool for Claude. To add this MCP server:

1. **Install Claude Code:** If you haven't already, install Claude Code following the instructions at [https://github.com/anthropics/claude-code](https://github.com/anthropics/claude-code)

2. **Add the MCP Server:** Run the following command in your terminal (replace the path with your actual installation path):

   ```bash
   claude mcp add --transport stdio mcp-abap-adt -- node /absolute/path/to/mcp-abap-adt/dist/index.js
   ```

   **Note:** Make sure to use the absolute path to the `dist/index.js` file in your installation.

3. **Verify Installation:** You can list your configured MCP servers with:

   ```bash
   claude mcp list
   ```

4. **Start Using:** Once added, Claude Code will automatically use the ABAP tools when you ask questions about ABAP code.

> **Windows note:** for Claude Code's `mcp add` command on Windows, use: `mcp add C:\path\to\mcp-abap-adt\dist\index.js`

## Roo Code

Configure in Roo Code's MCP settings (`.roo/mcp-config.json`):

```json
{
  "mcpServers": {
    "mcp-abap-adt": {
      "command": "node",
      "args": ["/path/to/mcp-abap-adt/dist/index.js"]
    }
  }
}
```

## Gemini CLI

Configure in Gemini CLI's MCP settings:

- (`~/.gemini/settings.json`) for global settings
- (`project_folder/.gemini/settings.json`) for project-specific settings

```json
{
  "mcpServers": {
    "mcp-abap-adt": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-abap-adt/dist/index.js"]
    }
  }
}
```
