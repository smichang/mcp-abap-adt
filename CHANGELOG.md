# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `ManageSessions action=end` reported a successful end as `still there` when SAP reused the freed `tid` at once; the verification now also compares logon time and terminal (same fix as in the original project). The two `regex =` activation warnings became `pcre =`.

## [3.5.0] - 2026-10-12

### Added
- `ManageSessions` (`list` / `end`): list and end the connection user's own ABAP sessions on every application server; standalone SICF endpoint `session_admin`. Own user, HTTP sessions only, never the calling session, no "end all"; ids are reused at once, so an id is only valid in the latest list. The `list` header also names the current session (system, client, user, language, application server). Live-verified here, including a real `end`; a freed `tid` can be reused at once, so the final check compares server, tid, logon time and terminal.
- `UnlockObject force=true`: delete the connection user's own orphan SM12 locks through the standalone endpoint `lock_admin` (`ENQUE_DELETE`, whole-name match).
- `scripts/adt-session-check.js`: bare-client check whether the SAP system keeps a stateful ADT session alive (LOCK → follow-up → UNLOCK); the cause of the intermittent `400 Session not found` is a fault of the SAP system, not of the tools.
- Live integration tests for `ManageAuthObject` (against a permanent anchor object) and `ManageSessions`.

### Fixed
- CSRF expiry in all ABAP HTTP handlers compared raw `TIMESTAMP` values instead of seconds (`CL_ABAP_TSTMP=>SUBTRACT` now).
- `create_sicf_node` sets `LOG_FLAG`, so generated nodes use the Alternative Logon Procedure.
- `UnlockObject` schema: `object_type` was outside `properties`.
- Tests no longer rewrite a program found by search pattern; they create their own `$TMP`/`ZMCP_*` fixtures.

- The server announced itself as version 3.4.1; it now reads its version from `package.json`.

### Removed
- `Dockerfile` and `smithery.yaml` (inherited from upstream, never used here; the old image would also have copied a local `.env` into itself). The server runs with `node dist/index.js`.

### Changed
- `abap-tasks/README.md` corrected after a first install on a clean system (message classes `ZMCP_DISPATCH`/`ZMCP_TEXTPOOL` are required for readable errors); project skill extended with the recovery procedure for orphaned sessions and locks.

## [3.4.1]

First public release. Derived from [mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) with a large set of additions:

- Read tools consolidated into `GetCode`, `GetDiagnostics` and `GetMeta` dispatchers (`resource` enum).
- Write tools: `WriteProgram`, `ManageDDIC`, `ManageMessageClass`, `ManageTransport`, `ManageDynpro`, `ManageAuthObject`, `TextPoolLang`, `ManageSicfNode`, `ActivateObjects`, `DeleteObject`, `UnlockObject`.
- `RunUnitTest` and `RunATCCheck`, with `background=true` / `output_file` mode for long-running calls and offset paging with a short-lived result cache for list tools.
- Cross-process stateful-operation gate so only one ADT `LOCK` session runs at a time per SAP system.
- Optional encrypted secrets keystore as an alternative to a plaintext `.env`.
- Optional ABAP-side SICF endpoints (see `abap-tasks/`) for capabilities standard ADT lacks.
