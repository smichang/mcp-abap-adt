# Recovering from orphaned sessions and locks

Load when a write fails with `400 Session not found` right after a successful LOCK, the result
adds "failed to release the lock", or the object stays locked by the configured SAP user.

**Cause:** not established. It comes and goes: a bare HTTP client (LOCK → follow-up request → UNLOCK)
fails on every object while it lasts. The maintainer reports it happens around use of `UnlockObject`;
a controlled test (nine `UnlockObject` calls, on free and on orphan-locked objects) did not trigger
it, so note the exact call order when it happens. Restarting the MCP server does not cure it.

1. **Stop.** Do not retry, do not rerun the test suite, never `pkill` or interrupt a running write.
2. **Check:** `node scripts/adt-session-check.js /sap/bc/adt/oo/classes/<your own object>` prints
   HEALTHY or FAULT. It leaves a lock behind on FAULT. On FAULT do not write; wait or ask Basis
   (SM04/SM21 at that time).
3. **Clear the locks** of the SAP user, per exact object name (the lock report matches whole names;
   a prefix answers "no lock" even when locked):
   - `UnlockObject object_name=… force=true` † deletes the user's own SM12 entries. Ask first: it
     cannot tell an orphan from a live editor of yours. Run `UnlockObject` again without `force` to
     confirm.
   - or delete the entries in SM12.
4. **Locks and sessions are separate.** The failed call also left an ABAP session in SM04. Deleting
   the lock does not end it; it lingers until the HTTP session timeout. End it with
   `ManageSessions action=list`, then `action=end ids=["server:tid"]` for ids you recognize by
   client IP and age — never your own live Eclipse or GUI sessions. Or use SM04.
5. **Verify** with a brand-new `$TMP` name (an existing object may still carry an orphan lock):
   create + write + activate. Only then retry the real work, and delete your probe objects.
6. If the check says HEALTHY but the MCP server still fails, restart it with `/mcp`.

† needs the optional `lock_admin` / `session_admin` endpoints (`abap-tasks/README.md`).
