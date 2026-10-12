import fs from 'fs';
import crypto from 'crypto';

// ── Secrets keystore resolver ────────────────────────────────────────────
// Opt-in alternative to a plaintext .env on a deployment server. See
// for the full design rationale.
//
// Resolution order for any config value, stopping at the first hit:
//   1. Real process environment variable (set by the OS/CI/MCP client config,
//      *not* filled in later by dotenv from .env) — always wins.
//   2. The keystore, only if SECRETS_KEYSTORE is set. If unset, this tier is a
//      total no-op — this is what makes the whole mechanism non-breaking for
//      local dev running on a plain .env.
//   3. .env file fallback (dotenv has already merged this into process.env by
//      the time resolveSecret() runs) — the original plaintext behavior.
//
// SECRETS_KEYSTORE unset  -> behaves exactly like before (env / .env only)
// SECRETS_KEYSTORE set    -> env / keystore / .env, in that order

interface SecretEntry {
    iv: string;
    tag: string;
    ct: string;
}
type SecretsMap = Record<string, SecretEntry>;
interface KeystoreState {
    key: Buffer;
    secrets: SecretsMap;
}

let _state: KeystoreState | null | undefined; // undefined = not yet attempted; null = no-op
let _realEnvSnapshot: Record<string, string | undefined> | null = null;

function init(): void {
    if (_state !== undefined) return;
    const keystorePath = process.env.SECRETS_KEYSTORE;
    if (!keystorePath) {
        _state = null;
        return;
    }

    let keyB64 = process.env.SECRETS_KEYSTORE_PASSWORD;
    if (!keyB64) {
        const keyFile = process.env.SECRETS_KEYSTORE_PASSWORD_FILE;
        if (!keyFile) {
            throw new Error(
                `SECRETS_KEYSTORE is set (${keystorePath}) but no SECRETS_KEYSTORE_PASSWORD ` +
                `or SECRETS_KEYSTORE_PASSWORD_FILE was provided`
            );
        }
        keyB64 = fs.readFileSync(keyFile, 'utf8').trim();
    }

    // Loud on failure, never swallowed: a missing SECRETS_KEYSTORE is a valid,
    // deliberately-handled no-op (above), but a *misconfigured* one (bad
    // password, malformed JSON, unreadable file) is a completely different
    // situation that must not fail silently into "keystore has no secrets".
    try {
        const key = Buffer.from(keyB64, 'base64');
        const secrets = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
        _state = { key, secrets };
    } catch (e) {
        throw new Error(`Failed to load secrets keystore ${keystorePath}: ${e instanceof Error ? e.message : e}`);
    }
}

/** The secret stored under `alias`, or undefined if no keystore is configured or absent. */
export function getSecret(alias: string): string | undefined {
    init();
    if (!_state) return undefined;
    const entry = _state.secrets[alias];
    if (!entry) return undefined;
    const decipher = crypto.createDecipheriv('aes-256-gcm', _state.key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(entry.ct, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

/** Every alias starting with `prefix`, keyed by the remainder — for per-target secrets
 *  like SOME_PASSWD_<SID>_<CLIENT>. Plain JSON object keys preserve exact case as written. */
export function getSecretsByPrefix(prefix: string): Record<string, string> {
    init();
    const out: Record<string, string> = {};
    if (!_state) return out;
    for (const alias of Object.keys(_state.secrets)) {
        if (alias.startsWith(prefix)) {
            const v = getSecret(alias);
            if (v !== undefined) out[alias.slice(prefix.length)] = v;
        }
    }
    return out;
}

/**
 * Call once, before dotenv populates process.env from .env, so resolveSecret()
 * can tell a real OS/CI-injected env var (must always win) apart from one that
 * will only exist because dotenv filled it in from .env (lowest-priority
 * fallback). Idempotent — later calls are no-ops.
 */
export function captureRealEnv(keys: string[]): void {
    if (_realEnvSnapshot) return;
    _realEnvSnapshot = {};
    for (const k of keys) _realEnvSnapshot[k] = process.env[k];
}

/** process env -> keystore -> .env file (already merged into process.env by dotenv). */
export function resolveSecret(key: string): string | undefined {
    const realEnv = _realEnvSnapshot ? _realEnvSnapshot[key] : process.env[key];
    if (realEnv) return realEnv;
    const ksVal = getSecret(key);
    if (ksVal) return ksVal;
    return process.env[key];
}

/** Which tier actually supplied `key` — for startup diagnostics, never for control flow. */
export function describeResolution(key: string): 'process environment' | 'keystore' | '.env file' | 'NOT FOUND' {
    const realEnv = _realEnvSnapshot ? _realEnvSnapshot[key] : undefined;
    if (realEnv) return 'process environment';
    if (getSecret(key) !== undefined) return 'keystore';
    if (process.env[key]) return '.env file';
    return 'NOT FOUND';
}

/** Test-only: reset module state between test files/suites. */
export function _resetForTests(): void {
    _state = undefined;
    _realEnvSnapshot = null;
}
