#!/usr/bin/env node
// Converts this server's plaintext .env into an encrypted secrets keystore
// (secret/keystore.key + secret/secrets.json), so a deployment server never
// needs a readable .env sitting on disk.
// for the full design.
//
// Run this ON THE SERVER ITSELF, in a real terminal — never through an AI tool,
// since it reads/writes real SAP credentials.
//
// Usage:
//   node scripts/setup-secrets.js                          bootstrap/convert .env -> secret/
//   node scripts/setup-secrets.js --rotate KEY              change one secret's value in place
//   node scripts/setup-secrets.js --env FILE --out DIR      bootstrap a SECOND (or Nth) keystore,
//                                                            e.g. for a different SAP client/system,
//                                                            from a differently-named .env file into
//                                                            a differently-named output dir
//   node scripts/setup-secrets.js --rotate KEY --out DIR    rotate a secret in a non-default keystore
//
// Each keystore is a self-contained SAP_URL/SAP_USERNAME/SAP_PASSWORD/SAP_CLIENT set — to talk to a
// second SAP client, bootstrap a second keystore under a different --out dir (e.g. `secret-800/`) from
// a second .env file (e.g. `.env.800`), then register a second entry in your MCP client config pointing
// SECRETS_KEYSTORE/SECRETS_KEYSTORE_PASSWORD_FILE at that dir's files. See CLAUDE.md "Secrets Keystore".
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
    const out = { _: [] };
    const isFlagValue = (v) => v !== undefined && !v.startsWith('--');
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--env' && isFlagValue(argv[i + 1])) { out.env = argv[++i]; }
        else if (a === '--out' && isFlagValue(argv[i + 1])) { out.out = argv[++i]; }
        else if (a === '--rotate') { out.rotate = isFlagValue(argv[i + 1]) ? argv[++i] : ''; }
        else out._.push(a);
    }
    return out;
}

const cliArgs = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(ROOT, cliArgs.out || 'secret');
const OUT_FILE = path.join(OUT_DIR, 'secrets.json');
const KEY_FILE = path.join(OUT_DIR, 'keystore.key');
const DOTENV = path.resolve(ROOT, cliArgs.env || '.env');
const DOTENV_EXAMPLE = path.join(ROOT, '.env.example');

// Everything this server reads from .env — see CLAUDE.md "Architecture" section.
const REQUIRED_KEYS = ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'SAP_CLIENT'];

/** Plain visible-input prompt (y/N confirmations, anything non-sensitive). */
function readVisible(promptText) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(promptText, (answer) => { rl.close(); resolve(answer); });
    });
}

/**
 * Masked-input prompt for an actual secret value. Reads raw keypresses off
 * stdin instead of going through readline's `_writeToOutput` hook — that hook
 * is undocumented, and overriding it can leave the prompt text itself
 * unwritten depending on terminal/Node version (seen live: the prompt never
 * appeared, input was still accepted once Enter was pressed). Falls back to a
 * normal (visible) readline prompt when stdin isn't a TTY, e.g. piped input.
 */
function readHidden(promptText) {
    if (!process.stdin.isTTY) return readVisible(promptText);
    return new Promise((resolve) => {
        process.stdout.write(promptText);
        const stdin = process.stdin;
        stdin.resume();
        stdin.setRawMode(true);
        stdin.setEncoding('utf8');
        let input = '';
        const cleanup = () => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
        };
        // A 'data' event is not guaranteed to be one keypress — a paste, or a
        // scripted write of a whole line at once, delivers several characters in a
        // single chunk. Walk it character by character rather than switching on the
        // chunk as a whole, or a chunk like "secret123\n" falls through to the
        // default case in its entirety and the trailing Enter is never seen.
        const onData = (chunk) => {
            for (const char of chunk) {
                switch (char) {
                    case '\n': case '\r': case '\u0004': // Enter / Ctrl-D
                        cleanup();
                        process.stdout.write('\n');
                        resolve(input);
                        return;
                    case '\u0003': // Ctrl-C
                        cleanup();
                        process.stdout.write('\n');
                        process.exit(1);
                        return;
                    case '\u007f': case '\b': // Backspace
                        input = input.slice(0, -1);
                        break;
                    default:
                        input += char;
                        break;
                }
            }
        };
        stdin.on('data', onData);
    });
}

function encrypt(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key, entry) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]).toString('utf8');
}

function parseDotEnv(text) {
    const out = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) out[key] = value;
    }
    return out;
}

async function rotate(alias) {
    if (!fs.existsSync(OUT_FILE) || !fs.existsSync(KEY_FILE)) {
        console.error(`Error: ${OUT_FILE} / ${KEY_FILE} not found — run this script with no arguments first.`);
        process.exit(1);
    }
    const key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    const secrets = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    if (!alias) {
        console.error(`Usage: node ${path.basename(__filename)} --rotate <KEY>`);
        console.error('Known keys:', Object.keys(secrets).join(', '));
        process.exit(1);
    }
    if (!secrets[alias]) {
        console.error(`Error: key '${alias}' not found. Known keys:`, Object.keys(secrets).join(', '));
        process.exit(1);
    }
    const v1 = await readHidden(`New value for ${alias} (not echoed) — only after changing it upstream in SAP: `);
    const v2 = await readHidden('Re-enter to confirm: ');
    if (v1 !== v2) { console.error('Error: values did not match.'); process.exit(1); }
    secrets[alias] = encrypt(key, v1);
    fs.writeFileSync(OUT_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    console.log(`Rotated: ${alias} updated. Reload the MCP server (/mcp) or restart it now — it only reads the keystore at startup.`);
}

async function bootstrap() {
    if (!fs.existsSync(DOTENV)) {
        if (!fs.existsSync(DOTENV_EXAMPLE)) {
            console.error(`Error: neither ${DOTENV} nor .env.example found.`);
            process.exit(1);
        }
        fs.copyFileSync(DOTENV_EXAMPLE, DOTENV);
        fs.chmodSync(DOTENV, 0o600);
        console.log(`Created ${DOTENV} from .env.example (mode 600). Fill in the real values, then re-run this script.`);
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
    const parsed = parseDotEnv(fs.readFileSync(DOTENV, 'utf8'));

    const missing = REQUIRED_KEYS.filter((k) => !parsed[k]);
    const placeholders = Object.entries(parsed)
        .filter(([, v]) => /your_(username|password|client)|_here$/i.test(v))
        .map(([k]) => k);
    if (missing.length || placeholders.length) {
        if (missing.length) console.error('Missing required key(s):', missing.join(', '));
        if (placeholders.length) console.error('Still placeholder values, not real credentials:', placeholders.join(', '));
        process.exit(1);
    }

    const key = crypto.randomBytes(32);
    const secrets = {};
    let count = 0;
    for (const [k, v] of Object.entries(parsed)) {
        if (!v) continue; // skip blank optional entries
        secrets[k] = encrypt(key, v);
        console.log(`  imported: ${k}`);
        count++;
    }

    // Verify round-trip before touching .env: actually decrypt every entry and
    // diff it against the source plaintext, rather than trusting the encrypt step.
    for (const [k, v] of Object.entries(parsed)) {
        if (!v) continue;
        if (decrypt(key, secrets[k]) !== v) {
            console.error(`Error: round-trip mismatch for ${k} — aborting before touching .env.`);
            process.exit(1);
        }
    }

    fs.writeFileSync(KEY_FILE, key.toString('base64'), { mode: 0o600 });
    fs.writeFileSync(OUT_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });

    const answer = await readVisible(`.env verified in ${OUT_FILE} (${count} secrets). Delete plaintext .env now? [y/N] `);
    if (/^y/i.test(answer)) {
        fs.unlinkSync(DOTENV);
        console.log('.env deleted.');
    } else {
        console.log('.env left in place.');
    }

    console.log('\nDone. Point your MCP client config (env block) at:');
    console.log(`  SECRETS_KEYSTORE=${OUT_FILE}`);
    console.log(`  SECRETS_KEYSTORE_PASSWORD_FILE=${KEY_FILE}`);
}

async function main() {
    if (process.argv.slice(2).includes('--rotate')) {
        await rotate(cliArgs.rotate);
        return;
    }
    await bootstrap();
}

main();
