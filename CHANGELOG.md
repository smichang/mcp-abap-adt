# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.1]

First public release. Derived from [mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) with a large set of additions:

- Read tools consolidated into `GetCode`, `GetDiagnostics` and `GetMeta` dispatchers (`resource` enum).
- Write tools: `WriteProgram`, `ManageDDIC`, `ManageMessageClass`, `ManageTransport`, `ManageDynpro`, `ManageAuthObject`, `TextPoolLang`, `ManageSicfNode`, `ActivateObjects`, `DeleteObject`, `UnlockObject`.
- `RunUnitTest` and `RunATCCheck`, with `background=true` / `output_file` mode for long-running calls and offset paging with a short-lived result cache for list tools.
- Cross-process stateful-operation gate so only one ADT `LOCK` session runs at a time per SAP system.
- Optional encrypted secrets keystore as an alternative to a plaintext `.env`.
- Optional ABAP-side SICF endpoints (see `abap-tasks/`) for capabilities standard ADT lacks.
