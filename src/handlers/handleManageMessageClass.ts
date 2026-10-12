import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { escapeXml, attemptUnlock, describeLockHolder, createTransportForObject } from './handleWriteProgram';
import { AxiosError } from 'axios';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

type ToolResult = any;

// Native ADT message-class contract (SE91 equivalent), live-probed 2026-10-07 on a $TMP class:
//   POST   /sap/bc/adt/messageclass                 create (201)
//   POST   /sap/bc/adt/messageclass/{name}?_action=LOCK|UNLOCK
//   PUT    /sap/bc/adt/messageclass/{name}?lockHandle=…   mc:messageClass document; only the
//          <mc:messages> it carries are inserted/updated (omitted messages are left alone)
//   DELETE /sap/bc/adt/messageclass/{name}?lockHandle=…   then UNLOCK anyway — without it the
//          deleted name stays enqueued by our session ("User X is currently editing") and
//          can't be re-created until that session times out
// No activation step — a message class reads back as version="active" right after the PUT.
//
// Deleting a single message: the PUT never infers deletions from messages missing in the
// document (CL_ADT_MC_RES_CONTROLLER->DO_UPDATE has that loop commented out). It deletes only
// numbers listed as <mc:deletedmessages mc:msgno="…"/> AFTER the <mc:messages> elements
// (ST_ADT_MESSAGE_CLASS, root field TT_DELETEDMESSAGE). The per-message resource
// …/messages/{no} (CL_ADT_MSG_ATOM_RES_CONT) only implements GET and LOCK_MSG — no DELETE/PUT.
//
// LANGUAGE (found 2026-10-07 after a real class was damaged): DO_UPDATE reads the existing texts
// and writes every incoming message in `adtcore:language` (update_message: T100-SPRSL =
// iv_language). Omit it and SAP compares against the empty language, treats every message as new
// and writes all of them with SPRSL = ' ' — a real class got 37 blank-language rows that way. So every
// write PUT carries adtcore:language explicitly (default: the class's real master language from
// T100A — ADT's GET reports adtcore:masterLanguage wrongly, e.g. "EN" for a class whose
// T100A-MASTERLANG is M/ZF), and carries only the messages being written. Deletion is
// language-sensitive the other way round: API DELETE removes the message in ALL languages (plus
// its long text) only when the language is empty or equals the logon language, otherwise just
// that language's T100 row — so deletions go in their own PUT with no adtcore:language and no
// <mc:messages>. Reads honour the `sap-language` header (unknown ISO codes silently fall back to
// the logon language, so the returned adtcore:language is checked).
const COLLECTION = '/sap/bc/adt/messageclass';
const MIME = 'application/vnd.sap.adt.mc.messageclass+xml';
const LOCK_ACCEPT = 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result';

const MAX_NAME_LENGTH = 20;   // T100A-ARBGB is CHAR20
const MAX_TEXT_LENGTH = 73;   // T100-TEXT is CHAR73
const MAX_DESCRIPTION_LENGTH = 60;

interface Message {
    number: string;
    text: string;
    selfExplanatory?: boolean;   // undefined on input = not given
}

interface MessageClassMeta {
    description: string;
    packageName: string;
    language: string;   // language the texts were read in (adtcore:language)
    messages: Message[];
}

function err(text: string): ToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
}

export async function handleManageMessageClass(args: any): Promise<ToolResult> {
    const name = args?.message_class ? String(args.message_class).toUpperCase() : 'unknown';
    const gate = acquireStatefulOperationLock(`ManageMessageClass(${name})`);
    if (!gate.ok) return err(gate.message);
    try {
        return await manageMessageClassCore(args);
    } finally {
        releaseStatefulOperationLock();
    }
}

async function manageMessageClassCore(args: any): Promise<ToolResult> {
    try {
        const action = args?.action ? String(args.action).toLowerCase() : '';
        const name = args?.message_class ? String(args.message_class).toUpperCase() : '';
        const description = args?.description ? String(args.description) : '';
        const packageName = args?.package_name ? String(args.package_name).toUpperCase() : '';
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : '';
        const transportDescription = args?.transport_description ? String(args.transport_description) : '';

        if (!['create', 'update', 'delete'].includes(action)) {
            throw new McpError(ErrorCode.InvalidParams, `action must be create, update or delete (got '${args?.action}')`);
        }
        if (!name) throw new McpError(ErrorCode.InvalidParams, 'message_class is required');
        if (!/^[ZY]/.test(name)) {
            throw new McpError(ErrorCode.InvalidParams, `message_class '${name}' must be in the customer namespace (start with Z or Y)`);
        }
        if (!/^[A-Z0-9_]+$/.test(name)) {
            throw new McpError(ErrorCode.InvalidParams, `message_class '${name}' may only contain letters, digits and underscores`);
        }
        if (name.length > MAX_NAME_LENGTH) {
            throw new McpError(ErrorCode.InvalidParams, `message_class '${name}' is ${name.length} characters — exceeds SAP's ${MAX_NAME_LENGTH}-character limit.`);
        }
        if (description.length > MAX_DESCRIPTION_LENGTH) {
            throw new McpError(ErrorCode.InvalidParams, `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})`);
        }
        if (transportNumber && transportDescription) {
            throw new McpError(ErrorCode.InvalidParams, 'transport_number and transport_description are mutually exclusive');
        }
        if (transportDescription) {
            if (transportDescription.length > 60) {
                throw new McpError(ErrorCode.InvalidParams, `transport_description exceeds SAP limit of 60 characters (got ${transportDescription.length})`);
            }
            if (!packageName) {
                throw new McpError(ErrorCode.InvalidParams, "package_name is required together with transport_description (used as the new transport's DEVCLASS)");
            }
        }
        if (action === 'create' && (!description || !packageName)) {
            throw new McpError(ErrorCode.InvalidParams, 'description and package_name are required for action=create');
        }

        const replaceAll = args?.replace_all === true;
        const languageArg = args?.language ? String(args.language).toUpperCase() : '';
        if (languageArg && !/^[A-Z0-9]{2}$/.test(languageArg)) {
            throw new McpError(ErrorCode.InvalidParams, `language must be a 2-character ISO language code such as EN, DE or ZF (got '${args?.language}')`);
        }
        const messages = parseMessagesArg(args?.messages);
        const deleteNumbers = parseDeleteArg(args?.delete_messages);
        const overlap = deleteNumbers.filter(n => messages.some(m => m.number === n));
        if (overlap.length) {
            throw new McpError(ErrorCode.InvalidParams, `message number(s) ${overlap.join(', ')} appear in both messages and delete_messages`);
        }
        if (action !== 'update' && (deleteNumbers.length || replaceAll)) {
            throw new McpError(ErrorCode.InvalidParams, 'delete_messages and replace_all are only valid for action=update');
        }
        if (replaceAll && deleteNumbers.length) {
            throw new McpError(ErrorCode.InvalidParams, 'replace_all already deletes every message not in messages — do not combine it with delete_messages');
        }
        if (replaceAll && !messages.length) {
            throw new McpError(ErrorCode.InvalidParams, 'replace_all needs a non-empty messages list (it would otherwise delete every message) — use delete_messages to remove specific ones');
        }
        if (action === 'update' && !messages.length && !deleteNumbers.length && !description) {
            throw new McpError(ErrorCode.InvalidParams, 'action=update needs at least one of messages, delete_messages or description');
        }
        if (action === 'delete' && messages.length) {
            throw new McpError(ErrorCode.InvalidParams, 'messages is not valid for action=delete');
        }

        const baseUrl = String(await getBaseUrl());
        const uriPath = `${COLLECTION}/${name.toLowerCase()}`;
        const objectUrl = `${baseUrl}${uriPath}`;

        if (languageArg && !(await isoLanguageExists(baseUrl, languageArg))) {
            throw new McpError(ErrorCode.InvalidParams, `language '${languageArg}' is not an ISO language code known to this system (T002-LAISO)`);
        }
        const exists = (await readMessageClass(objectUrl)) !== null;
        if (action === 'create' && exists) {
            return err(`Message class '${name}' already exists. Use action=update to modify it.`);
        }
        if (action !== 'create' && !exists) {
            return err(`Message class '${name}' not found.${action === 'update' ? ' Use action=create to create it.' : ''}`);
        }
        // The class's real master language (T100A), not ADT's adtcore:masterLanguage, which is unreliable.
        const masterIso = action === 'create' ? (languageArg || 'EN') : await masterLanguageIso(baseUrl, name);
        if (!masterIso) return err(`Could not determine the master language of message class '${name}' (T100A/T002). Nothing was changed.`);
        const targetIso = languageArg || masterIso;
        const isTranslation = targetIso !== masterIso;
        if (isTranslation && (deleteNumbers.length || replaceAll)) {
            throw new McpError(ErrorCode.InvalidParams,
                `delete_messages/replace_all delete messages in ALL languages and can't be combined with a translation language (${targetIso}, master ${masterIso}). Run the deletion without 'language'.`);
        }
        const current = await readMessageClass(objectUrl, action === 'create' ? undefined : targetIso);
        if (action !== 'create' && (!current || current.language !== targetIso)) {
            return err(`Could not read message class '${name}' in language ${targetIso} (SAP answered in '${current?.language || '?'}' — is the language installed?). Nothing was changed.`);
        }

        // update/delete without a transport fall back to the request the class is already locked
        // in (CORRNR from the LOCK) — reassignmentGuard refuses only when there's none at all.
        if (action === 'create' && packageName !== '$TMP' && !transportNumber && !transportDescription) {
            return err(`Message class '${name}' targets package '${packageName}', not $TMP — transport_number or transport_description is required.`);
        }

        let effectiveTransport = transportNumber;
        let autoTaskNumber = '';
        if (!effectiveTransport && transportDescription) {
            const tRes = await createTransportForObject(baseUrl, uriPath, transportDescription, packageName);
            if (tRes.error) return err(tRes.error);
            effectiveTransport = tRes.transportNumber!;
            autoTaskNumber = tRes.taskNumber || '';
        }
        const transportLines = (): string[] => {
            const lines: string[] = [];
            if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${!transportNumber && transportDescription ? ' (auto-created)' : ''}`);
            if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
            return lines;
        };

        // ── create: POST the header, then (if messages were given) the normal update tail ──
        if (action === 'create') {
            const createParams: Record<string, string> = {};
            if (effectiveTransport) createParams['corrNr'] = effectiveTransport;
            try {
                await makeAdtRequest(`${baseUrl}${COLLECTION}`, 'POST', 30000,
                    messageClassBody({ name, description, packageName, masterIso, languageIso: masterIso, messages: [] }), createParams,
                    { 'Content-Type': `${MIME}; charset=UTF-8`, 'Accept': MIME });
            } catch (error) {
                const result = sapFail(error, `Failed to create message class '${name}'`);
                // A name deleted by a session that never unlocked stays enqueued even though the
                // object is gone (found live) — tell the caller it isn't a real editor.
                const text: string = result?.content?.[0]?.text || '';
                if (/is currently editing/i.test(text)) {
                    result.content[0].text += `\nThe class does not exist, so this is a leftover lock on the name — typically from an earlier delete whose session never released it. It clears when that SAP session times out, or remove it in SM12.`;
                }
                return result;
            }
            const lines = [`Created message class '${name}' ("${description}") in package '${packageName}', master language ${masterIso}.`, ...transportLines()];
            if (!messages.length) return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };

            const putResult = await lockAndPut(objectUrl, name, effectiveTransport, [
                messageClassBody({ name, description, packageName, masterIso, languageIso: masterIso, messages: sortMessages(messages) })]);
            if (putResult.error) {
                lines.push(`Header created, but writing the messages failed:\n${putResult.error}`);
                return err(lines.join('\n'));
            }
            const readBack = await readBackSummary(objectUrl, masterIso, messages);
            lines.push(readBack);
            return { isError: readBack.startsWith('Read-back WARNING'), content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // ── delete: lock → DELETE (lock is gone with the object, no unlock on success) ──
        if (action === 'delete') {
            const lock = await acquireLock(objectUrl, name);
            if ('error' in lock) return lock.error;
            const guard = await reassignmentGuard(objectUrl, lock, effectiveTransport, name);
            if (guard) return guard;
            const delParams: Record<string, string> = { lockHandle: lock.lockHandle };
            const corr = effectiveTransport || lock.corrNr;
            if (corr) delParams['corrNr'] = corr;
            try {
                await makeAdtRequest(objectUrl, 'DELETE', 30000, undefined, delParams, { 'X-sap-adt-sessiontype': 'stateful' });
            } catch (error) {
                const unlockError = await attemptUnlock(objectUrl, lock.lockHandle);
                return sapFail(error, `Failed to delete message class '${name}'${unlockNote(unlockError, lock.lockHandle, name)}`);
            }
            // The object is gone but the enqueue entry isn't — release it explicitly.
            const unlockError = await attemptUnlock(objectUrl, lock.lockHandle);
            const lines = [`Deleted message class '${name}' (${current!.messages.length} message(s), all languages).`];
            if (corr) lines.push(`Transport: ${corr}`);
            if (unlockError) lines.push(`Note: releasing the lock afterwards failed (${unlockError}) — re-creating '${name}' may be blocked until the session times out.`);
            return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // ── update: lock → PUT(s) → unlock ──
        // Writes carry only the given messages, in targetIso. Deletions (all languages) go in a
        // separate PUT without adtcore:language — see the LANGUAGE note at the top.
        const master = isTranslation ? await readMessageClass(objectUrl, masterIso) : current!;
        const inMaster = new Set((master?.messages || []).map(m => m.number));
        const missing = deleteNumbers.filter(n => !inMaster.has(n));
        if (missing.length) {
            return err(`Cannot delete message(s) ${missing.join(', ')} — not present in message class '${name}'. Nothing was changed.`);
        }
        if (isTranslation) {
            const noMaster = messages.filter(m => !inMaster.has(m.number)).map(m => m.number);
            if (noMaster.length) {
                return err(`Message(s) ${noMaster.join(', ')} don't exist in the master language ${masterIso} — create them there first, then translate to ${targetIso}. Nothing was changed.`);
            }
        }
        const toDelete = replaceAll
            ? [...inMaster].filter(n => !messages.some(m => m.number === n)).sort()
            : deleteNumbers;
        // The self-explanatory flag is language-independent (T100U): keep the current one unless given.
        const writes = sortMessages(messages.map(m => {
            const prior = (master?.messages || []).find(c => c.number === m.number);
            return { ...m, selfExplanatory: m.selfExplanatory ?? prior?.selfExplanatory ?? true };
        }));

        const effectiveDescription = description || current!.description;
        const bodies: string[] = [];
        if (writes.length || description) {
            bodies.push(messageClassBody({ name, description: effectiveDescription, packageName: current!.packageName, masterIso, languageIso: targetIso, messages: writes }));
        }
        if (toDelete.length) {
            bodies.push(messageClassBody({ name, description: effectiveDescription, packageName: current!.packageName, masterIso, languageIso: '', messages: [], deleteNumbers: toDelete }));
        }
        const putResult = await lockAndPut(objectUrl, name, effectiveTransport, bodies);
        if (putResult.error) return err(putResult.error);

        const changed = messages.filter(m => current!.messages.some(c => c.number === m.number)).map(m => m.number);
        const added = messages.filter(m => !current!.messages.some(c => c.number === m.number)).map(m => m.number);
        const parts: string[] = [];
        if (added.length) parts.push(`added ${added.join(', ')}`);
        if (changed.length) parts.push(`changed ${changed.join(', ')}`);
        if (toDelete.length) parts.push(`deleted ${toDelete.join(', ')} (all languages)`);
        if (description && description !== current!.description) parts.push('description updated');
        const lines = [`Message class '${name}' updated${parts.length ? ': ' + parts.join('; ') : ''}.`,
            `Language: ${targetIso}${isTranslation ? ` (translation; master ${masterIso})` : ' (master)'}`, ...transportLines()];
        if (!effectiveTransport && putResult.corrNr) lines.push(`Transport: ${putResult.corrNr} (existing)`);
        const readBack = await readBackSummary(objectUrl, targetIso, messages, description || undefined, toDelete);
        lines.push(readBack);
        return { isError: readBack.startsWith('Read-back WARNING'), content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}

function parseMessagesArg(raw: any): Message[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new McpError(ErrorCode.InvalidParams, 'messages must be an array of { number, text, self_explanatory? }');
    const seen = new Set<string>();
    return raw.map((m: any, i: number) => {
        const number = normalizeNumber(m?.number, `messages[${i}].number`);
        if (seen.has(number)) throw new McpError(ErrorCode.InvalidParams, `message number ${number} appears more than once in messages`);
        seen.add(number);
        const text = m?.text === undefined || m?.text === null ? '' : String(m.text);
        if (!text.trim()) throw new McpError(ErrorCode.InvalidParams, `messages[${i}] (number ${number}): text is required`);
        if (text.length > MAX_TEXT_LENGTH) {
            throw new McpError(ErrorCode.InvalidParams, `message ${number}: text is ${text.length} characters — exceeds SAP's ${MAX_TEXT_LENGTH}-character limit (T100-TEXT).`);
        }
        // undefined = "not given": a new message defaults to true, an overwritten one keeps its flag
        return { number, text, selfExplanatory: m?.self_explanatory === undefined || m?.self_explanatory === null ? undefined : m.self_explanatory !== false };
    });
}

function parseDeleteArg(raw: any): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new McpError(ErrorCode.InvalidParams, 'delete_messages must be an array of message numbers');
    return [...new Set(raw.map((n: any, i: number) => normalizeNumber(n, `delete_messages[${i}]`)))];
}

function normalizeNumber(raw: any, label: string): string {
    const s = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!/^\d{1,3}$/.test(s)) throw new McpError(ErrorCode.InvalidParams, `${label} must be a message number 000-999 (got '${raw}')`);
    return s.padStart(3, '0');
}

function sortMessages(list: Message[]): Message[] {
    return [...list].sort((a, b) => a.number.localeCompare(b.number));
}

interface BodySpec {
    name: string; description: string; packageName: string;
    masterIso: string;
    languageIso: string;        // '' = omit adtcore:language (deletion-only PUT: delete in all languages)
    messages: Message[];
    deleteNumbers?: string[];
}

function messageClassBody(b: BodySpec): string {
    const { name, description, packageName, masterIso, languageIso, messages } = b;
    const deleteNumbers = b.deleteNumbers || [];
    if (!languageIso && messages.length) throw new Error('internal: messages must never be written without adtcore:language');
    const msgXml = messages.map(m =>
        // Never send mc:documented: DO_UPDATE deletes a message's long text when it receives
        // selfexplainatory="true" together with documented="true".
        `<mc:messages mc:msgno="${m.number}" mc:msgtext="${escapeXml(m.text)}" mc:selfexplainatory="${m.selfExplanatory ?? true}"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>` +
        `<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:name="${name}" adtcore:type="MSAG/N" adtcore:description="${escapeXml(description)}" adtcore:masterLanguage="${masterIso}"` +
        (languageIso ? ` adtcore:language="${languageIso}"` : '') + `>` +
        `<adtcore:packageRef adtcore:name="${escapeXml(packageName)}"/>` +
        msgXml +
        deleteNumbers.map(n => `<mc:deletedmessages mc:msgno="${n}"/>`).join('') +   // must follow every <mc:messages>
        `</mc:messageClass>`;
}

async function readMessageClass(objectUrl: string, languageIso?: string): Promise<MessageClassMeta | null> {
    let xmlData: string;
    try {
        const headers: Record<string, string> = { 'Accept': MIME };
        if (languageIso) headers['sap-language'] = languageIso;   // overrides the configured logon language
        const response = await makeAdtRequest(objectUrl, 'GET', 15000, undefined, undefined, headers);
        xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) return null;
        throw error;
    }
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const root = parsed?.['mc:messageClass'];
    if (!root) return null;
    const attrs = root._attributes || {};
    const raw = root['mc:messages'] ? [root['mc:messages']].flat() : [];
    return {
        description: attrs['adtcore:description'] || '',
        packageName: root['adtcore:packageRef']?._attributes?.['adtcore:name'] || '',
        language: String(attrs['adtcore:language'] || '').toUpperCase(),
        messages: raw.map((m: any) => {
            const a = m._attributes || {};
            return {
                number: a['mc:msgno'] || '',
                text: a['mc:msgtext'] || '',
                selfExplanatory: a['mc:selfexplainatory'] === 'true'
            };
        }).filter((m: Message) => m.number)
    };
}

interface LockInfo { lockHandle: string; corrNr: string; corrText: string; isLocal: boolean; }

async function acquireLock(objectUrl: string, name: string): Promise<LockInfo | { error: ToolResult }> {
    try {
        // Purge any leftover stateful session before LOCK (see CLAUDE.md "Why removeCookie runs before every LOCK").
        removeCookie('sap-contextid');
        const lockResponse = await makeAdtRequest(objectUrl, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
            'Accept': LOCK_ACCEPT,
            'X-sap-adt-sessiontype': 'stateful'
        });
        const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
        const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctxMatch) {
            appendCookie(ctxMatch[1]);
            refreshStatefulOperationToken(ctxMatch[1]);
        }
        const convert = require('xml-js');
        const data = convert.xml2js(String(lockResponse.data || ''), { compact: true })?.['asx:abap']?.['asx:values']?.['DATA'] || {};
        const lockHandle = data?.['LOCK_HANDLE']?._text || '';
        if (!lockHandle) throw new Error('Lock handle not found in response');
        return {
            lockHandle, corrNr: data?.['CORRNR']?._text || '', corrText: data?.['CORRTEXT']?._text || '',
            isLocal: (data?.['IS_LOCAL']?._text || '') === 'X'
        };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) {
                const lines = [`Failed to lock message class '${name}'.`, `Reason: ${errMsg}`];
                const holder = describeLockHolder(errMsg);
                if (holder) lines.push(holder);
                return { error: err(lines.join('\n')) };
            }
        }
        return { error: return_error(error) };
    }
}

// Same guard as WriteProgram/ManageDDIC: never let SAP silently move the object into a
// different change request than the one it's already locked in.
async function reassignmentGuard(objectUrl: string, lock: LockInfo, effectiveTransport: string, name: string): Promise<ToolResult | null> {
    if (!effectiveTransport && !lock.corrNr && !lock.isLocal) {
        const unlockError = await attemptUnlock(objectUrl, lock.lockHandle);
        return err(`Message class '${name}' is transportable and not yet in any change request — pass transport_number or transport_description.`
            + unlockNote(unlockError, lock.lockHandle, name));
    }
    if (!(effectiveTransport && lock.corrNr && lock.corrNr !== effectiveTransport)) return null;
    const unlockError = await attemptUnlock(objectUrl, lock.lockHandle);
    const txt = lock.corrText ? ` ("${lock.corrText}")` : '';
    return err([
        `Message class '${name}' is already locked in change request ${lock.corrNr}${txt}.`,
        `Refusing to reassign it to ${effectiveTransport} — an object must stay in a single change request.`,
        `Re-run with transport_number=${lock.corrNr}, or omit transport_number to keep using the existing one.`
    ].join('\n') + unlockNote(unlockError, lock.lockHandle, name));
}

/** lock → guard → PUT → unlock. `error` is null on success; `corrNr` is the request the class was already in. */
async function lockAndPut(objectUrl: string, name: string, effectiveTransport: string, bodies: string[]): Promise<{ error: string | null; corrNr: string }> {
    const lock = await acquireLock(objectUrl, name);
    if ('error' in lock) return { error: lock.error.content?.[0]?.text || 'Lock failed', corrNr: '' };
    const fail = (error: string) => ({ error, corrNr: lock.corrNr });
    const guard = await reassignmentGuard(objectUrl, lock, effectiveTransport, name);
    if (guard) return fail(guard.content[0].text);
    try {
        const putParams: Record<string, string> = { lockHandle: lock.lockHandle };
        const corr = effectiveTransport || lock.corrNr;
        if (corr) putParams['corrNr'] = corr;
        for (const body of bodies) {
            await makeAdtRequest(objectUrl, 'PUT', 30000, body, putParams, {
                'Content-Type': `${MIME}; charset=UTF-8`,
                'Accept': MIME,
                'X-sap-adt-sessiontype': 'stateful'
            });
        }
    } catch (error) {
        const unlockError = await attemptUnlock(objectUrl, lock.lockHandle);
        const reason = error instanceof AxiosError && error.response?.data
            ? (parseAdtErrorXml(String(error.response.data)) || String(error.response.data))
            : (error instanceof Error ? error.message : String(error));
        return fail(`Failed to write message class '${name}'.\nReason: ${reason}${unlockNote(unlockError, lock.lockHandle, name)}`);
    }
    const unlockError = await attemptUnlock(objectUrl, lock.lockHandle);
    if (unlockError) {
        return fail(`Messages were written, but the unlock FAILED.\nReason: ${unlockError}\nLock handle: ${lock.lockHandle}. Run UnlockObject('${name}') to clear it.`);
    }
    return { error: null, corrNr: lock.corrNr };
}

async function readBackSummary(objectUrl: string, languageIso: string, expected: Message[], expectedDescription?: string, deleted: string[] = []): Promise<string> {
    try {
        const after = await readMessageClass(objectUrl, languageIso);
        if (!after) return 'Read-back: message class not found after write (unexpected).';
        if (after.language !== languageIso) return `Read-back WARNING: SAP answered in '${after.language}', not ${languageIso} — the written texts could not be verified.`;
        const byNumber = new Map(after.messages.map(m => [m.number, m]));
        const problems: string[] = [];
        const missing = expected.filter(m => !byNumber.has(m.number)).map(m => m.number);
        const wrong = expected.filter(m => byNumber.has(m.number) && byNumber.get(m.number)!.text !== m.text).map(m => m.number);
        if (missing.length) problems.push(`missing ${missing.join(', ')}`);
        if (wrong.length) problems.push(`text differs for ${wrong.join(', ')}`);
        const notDeleted = deleted.filter(n => byNumber.has(n));
        if (notDeleted.length) problems.push(`still present ${notDeleted.join(', ')}`);
        if (expectedDescription && after.description !== expectedDescription) problems.push(`description reads "${after.description}"`);
        return problems.length
            ? `Read-back WARNING (${languageIso}): ${problems.join('; ')} (${after.messages.length} message(s) total).`
            : `Read-back OK (${languageIso}): ${after.messages.length} message(s) total.`;
    } catch (_e) {
        return 'Read-back: failed to re-read message class (non-fatal).';
    }
}

/** One freestyle DataPreview SELECT (stateless); returns the first row's column values in order. */
async function firstRow(baseUrl: string, sql: string): Promise<string[] | null> {
    const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/datapreview/freestyle`, 'POST', 15000, sql, { rowNumber: 1 },
        { 'Accept': 'application/*', 'Content-Type': 'text/plain' });
    const xml = String(response.data || '');
    if (!/<dataPreview:totalRows>\s*[1-9]/.test(xml)) return null;
    return [...xml.matchAll(/<dataPreview:data>([^<]*)<\/dataPreview:data>/g)].map(m => m[1].trim());
}

/** The class's master language as ISO code, from T100A-MASTERLANG (ADT's own masterLanguage is unreliable). */
async function masterLanguageIso(baseUrl: string, name: string): Promise<string> {
    // name is validated [A-Z0-9_] — safe to inline
    const row = await firstRow(baseUrl, `SELECT t~masterlang, s~laiso FROM t100a AS t INNER JOIN t002 AS s ON s~spras = t~masterlang WHERE t~arbgb = '${name}'`);
    return row?.[1] ? row[1].toUpperCase() : '';
}

async function isoLanguageExists(baseUrl: string, iso: string): Promise<boolean> {
    // iso is validated [A-Z0-9]{2}
    return (await firstRow(baseUrl, `SELECT spras, laiso FROM t002 WHERE laiso = '${iso}'`)) !== null;
}

function unlockNote(unlockError: string | null, lockHandle: string, name: string): string {
    return unlockError
        ? `\nAdditionally, failed to release the lock.\nReason: ${unlockError}\nLock handle: ${lockHandle}. Retry with UnlockObject('${name}') before the next attempt.`
        : '';
}

function sapFail(error: unknown, prefix: string): ToolResult {
    if (error instanceof AxiosError && error.response?.data) {
        const errMsg = parseAdtErrorXml(String(error.response.data));
        if (errMsg) return err(`${prefix}.\nReason: ${errMsg}`);
    }
    const baseResult = return_error(error);
    if (baseResult?.content?.[0]?.type === 'text') {
        baseResult.content[0].text = `${prefix}: ${baseResult.content[0].text}`;
    }
    return baseResult;
}
