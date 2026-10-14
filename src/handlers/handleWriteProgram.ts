import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { getExistingTasks } from './handleManageTransport';
import { acquireStatefulOperationLock, releaseStatefulOperationLock, refreshStatefulOperationToken } from '../lib/writeLock';
import { getConfig } from '../index';
import { AxiosError } from 'axios';
import { promises as fs } from 'fs';
import * as path from 'path';
import { runSyntaxCheck, formatSyntaxMessages } from '../lib/syntaxCheck';
import { validateEdits, applyEdits, PatchEdit } from '../lib/sourcePatch';

interface ObjectInfo {
    uri: string;      // e.g. /sap/bc/adt/programs/includes/ZRPP0057NF03
    type: string;     // e.g. PROG/P, PROG/I, FUGR/FF
    name: string;     // e.g. ZRPP0057NF03
    typeLabel: string; // e.g. "program", "include", "function module"
}

const CREATION_TYPES: Record<string, { creationPath: string; rootName: string; nameSpace: string; typeId: string; contentType?: string }> = {
    'PROG': {
        creationPath: 'programs/programs',
        rootName: 'program:abapProgram',
        nameSpace: 'xmlns:program="http://www.sap.com/adt/programs/programs"',
        typeId: 'PROG/P'
    },
    'INCL': {
        creationPath: 'programs/includes',
        rootName: 'include:abapInclude',
        nameSpace: 'xmlns:include="http://www.sap.com/adt/programs/includes"',
        typeId: 'PROG/I'
    },
    'FUGR': {
        creationPath: 'functions/groups',
        rootName: 'group:abapFunctionGroup',
        nameSpace: 'xmlns:group="http://www.sap.com/adt/functions/groups"',
        typeId: 'FUGR/F',
        contentType: 'application/vnd.sap.adt.functions.fugrs.v2+xml'
    },
    'CLAS': {
        creationPath: 'oo/classes',
        rootName: 'class:abapClass',
        nameSpace: 'xmlns:class="http://www.sap.com/adt/oo/classes"',
        typeId: 'CLAS/OC'
    }
};

// SAP repository object name length limits — all live-verified against this system
// 2026-08-31 ( for the original FUNC finding that prompted this,
// and the mcp-abap-adt session that re-verified every value below with disposable $TMP
// objects, cleaned up after). Two different failure shapes were found, both needing this
// client-side guard:
//   - CLAS, FUGR, FUNC: SAP's classic name field (CHAR30 for CLAS/FUNC, CHAR26 for FUGR)
//     silently TRUNCATES an over-length name on create — no error. Reproduced live: a
//     31-char CLAS name created as a 30-char object; a 31-char FUNC name created as a
//     30-char object; a 29-char FUGR name created as a 26-char object.
//   - PROG, INCL: SAP HARD-REJECTS ("Program name too long. Names longer than 30 chars for
//     internal use only") rather than truncating — no silent-corruption risk, but the raw
//     SAP error is confusing next to this tool's own clean validation elsewhere, so it's
//     still checked here for a consistent, clear error. (Originally guessed at 40 for both
//     from general ABAP knowledge before this was live-verified — that guess was wrong;
//     the real ceiling for both is 30, confirmed by a clean create+activate at exactly 30
//     chars and a hard SAP rejection at 41.)
const MAX_NAME_LENGTH: Record<string, number> = {
    'PROG': 30, 'INCL': 30, 'FUGR': 26, 'CLAS': 30, 'FUNC': 30
};

function validateNameLength(name: string, objectType: string, label: string): void {
    const max = MAX_NAME_LENGTH[objectType];
    if (max && name.length > max) {
        throw new McpError(ErrorCode.InvalidParams,
            `${label} '${name}' is ${name.length} characters — exceeds SAP's ${max}-character limit for ${objectType} names and would be silently truncated on create. Shorten it before retrying.`);
    }
}

export async function handleWriteProgram(args: any) {
    const lockLabel = args?.program_name ? `WriteProgram(${String(args.program_name).toUpperCase()})` : 'WriteProgram';
    const gate = acquireStatefulOperationLock(lockLabel);
    if (!gate.ok) {
        return { isError: true, content: [{ type: 'text', text: gate.message }] };
    }
    try {
        return await writeProgramCore(args);
    } finally {
        releaseStatefulOperationLock();
    }
}

async function writeProgramCore(args: any) {
    try {
        const programName = args?.program_name ? String(args.program_name).toUpperCase() : '';
        const sourceCodeArg = args?.source_code ?? '';
        const sourceFile = args?.source_file ? String(args.source_file) : '';
        const includeRawSapResponse = args?.include_raw_sap_response === true;
        const textSymbolsArg = args?.text_symbols ?? '';
        const textSymbolsFile = args?.text_symbols_file ? String(args.text_symbols_file) : '';
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : '';
        const transportDescription = args?.transport_description ? String(args.transport_description) : '';
        const activate = args?.activate !== false; // default true
        const checkOnly = args?.check_only === true;
        const patchMode = args?.edits !== undefined;
        const syntaxCheck = checkOnly || args?.syntax_check === true;
        const description = args?.description ? String(args.description) : '';
        const packageName = args?.package_name ? String(args.package_name).toUpperCase() : '';
        const objectType = args?.object_type ? String(args.object_type).toUpperCase() : 'PROG';
        const functionGroup = args?.function_group ? String(args.function_group).toUpperCase() : '';

        if (!programName) {
            throw new McpError(ErrorCode.InvalidParams, 'program_name is required');
        }
        if (transportDescription) {
            if (transportDescription.length > 60) {
                throw new McpError(ErrorCode.InvalidParams, `transport_description exceeds SAP limit of 60 characters (got ${transportDescription.length})`);
            }
            if (!packageName) {
                throw new McpError(ErrorCode.InvalidParams, 'package_name is required together with transport_description (used as the new transport\'s DEVCLASS)');
            }
        }

        if (patchMode && objectType === 'FUGR') {
            throw new McpError(ErrorCode.InvalidParams, 'edits cannot be used with object_type=FUGR (a function group has no writable source).');
        }

        // ── FUGR is a container, not a source object ──────────────────
        // A function group has no writable /source/main (its source/main is SAP-generated
        // boilerplate listing the TOP/UXX includes), so the lock→PUT→activate flow does not
        // apply. WriteProgram only *creates* the empty container here; function modules and
        // includes inside it are written separately once it exists (FUGR/FF / FUGR/I).
        if (objectType === 'FUGR') {
            validateNameLength(programName, 'FUGR', 'function group name');
            const baseUrl = await getBaseUrl();
            const existing = await resolveObjectInfo(String(baseUrl), programName);
            if (existing) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Function group '${programName}' already exists (${existing.type}). WriteProgram creates new function groups only; it cannot overwrite a container.` }]
                };
            }
            if (!description || !packageName) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `To create function group '${programName}', provide 'description' and 'package_name'.` }]
                };
            }
            let fugrTransportNumber = transportNumber;
            let fugrTaskNumber = '';
            let fugrAutoCreated = false;
            if (!fugrTransportNumber && transportDescription) {
                const deferredRef = `/sap/bc/adt/${CREATION_TYPES['FUGR'].creationPath}/${encodeURIComponent(programName)}`;
                const tRes = await createTransportForObject(String(baseUrl), deferredRef, transportDescription, packageName);
                if (tRes.error) return { isError: true, content: [{ type: 'text', text: tRes.error }] };
                fugrTransportNumber = tRes.transportNumber!;
                fugrTaskNumber = tRes.taskNumber || '';
                fugrAutoCreated = true;
            }
            const createResult = await createObject(String(baseUrl), programName, 'FUGR', description, packageName, fugrTransportNumber);
            if (createResult.error) {
                const cleanup = fugrAutoCreated ? await discardAutoCreatedTransport(String(baseUrl), fugrTransportNumber) : '';
                return { isError: true, content: [{ type: 'text', text: createResult.error + cleanup }] };
            }
            const lines = [`Created function group '${programName}' in package '${packageName}'.`];
            if (fugrTransportNumber) lines.push(`Transport: ${fugrTransportNumber}${transportDescription ? ' (auto-created)' : ''}`);
            if (fugrTaskNumber) lines.push(`Task: ${fugrTaskNumber}`);
            lines.push(`SAP generated the TOP/UXX includes. Add function modules with SE37/SE80, then write their source via WriteProgram.`);
            return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Exactly one of source_code or source_file is required. source_file wins on collision.
        // Patch mode (edits[]) replaces both: the source is read from SAP and patched further below.
        let sourceCode: string = '';
        let patchEdits: PatchEdit[] = [];
        if (patchMode) {
            if (sourceFile || (typeof sourceCodeArg === 'string' && sourceCodeArg.trim().length > 0)) {
                throw new McpError(ErrorCode.InvalidParams, 'edits cannot be combined with source_code or source_file — use edits to patch the current SAP source, or source_code for a full rewrite.');
            }
            try {
                patchEdits = validateEdits(args.edits);
            } catch (e: any) {
                throw new McpError(ErrorCode.InvalidParams, e?.message || String(e));
            }
        } else if (sourceFile) {
            const resolved = path.resolve(sourceFile);
            try {
                sourceCode = await fs.readFile(resolved, 'utf8');
            } catch (e: any) {
                throw new McpError(ErrorCode.InvalidParams, `Could not read source_file '${resolved}': ${e?.message || String(e)}`);
            }
            if (sourceCode.trim().length === 0) {
                throw new McpError(ErrorCode.InvalidParams, `source_file '${resolved}' is empty`);
            }
        } else {
            if (typeof sourceCodeArg !== 'string' || sourceCodeArg.trim().length === 0) {
                throw new McpError(ErrorCode.InvalidParams, 'Either source_code (inline) or source_file (path) is required');
            }
            sourceCode = sourceCodeArg;
        }
        if (!patchMode) validateSourceLineLengths(sourceCode);
        let sourceDiagnostics = patchMode ? '' : describeSource(sourceCode, !!sourceFile);

        // Optional text-pool categories — read each from its file param if given, otherwise inline.
        const loadTextCategory = async (
            inlineArg: any,
            fileArg: string,
            label: string
        ): Promise<string | null> => {
            if (fileArg) {
                const resolved = path.resolve(fileArg);
                try {
                    return await fs.readFile(resolved, 'utf8');
                } catch (e: any) {
                    throw new McpError(ErrorCode.InvalidParams, `Could not read ${label} '${resolved}': ${e?.message || String(e)}`);
                }
            }
            if (typeof inlineArg === 'string' && inlineArg.length > 0) return inlineArg;
            return null;
        };
        const textSymbols    = await loadTextCategory(textSymbolsArg, textSymbolsFile, 'text_symbols_file');
        const selectionTexts = await loadTextCategory(args?.selection_texts, args?.selection_texts_file ? String(args.selection_texts_file) : '', 'selection_texts_file');
        const listHeadings   = await loadTextCategory(args?.list_headings,   args?.list_headings_file   ? String(args.list_headings_file)   : '', 'list_headings_file');
        const hasAnyTextElements = textSymbols !== null || selectionTexts !== null || listHeadings !== null;

        const baseUrl = await getBaseUrl();
        let created = false;
        let effectiveTransportNumber = transportNumber; // may be filled in below by an auto-created, properly-described transport
        let autoCreatedTaskNumber = '';

        // Auto-detect object type (program, include, or function module) via search
        let objInfo = await resolveObjectInfo(String(baseUrl), programName);

        // ── Patch mode: read the current source from SAP and apply edits[] to it ──
        // Fails fast, before any lock, when an anchor is missing or ambiguous. The source is read
        // again after the LOCK (below) and the edits re-applied if it changed in between, so a
        // concurrent change is never overwritten.
        let patchBaseSource = '';
        let patchSummary = '';
        if (patchMode) {
            if (!objInfo) {
                return { isError: true, content: [{ type: 'text', text: `edits needs an existing object, but '${programName}' was not found. Use source_code (+ description, package_name) to create it.` }] };
            }
            try {
                patchBaseSource = await readCurrentSource(`${baseUrl}${objInfo.uri}/source/main`);
            } catch (e: any) {
                return return_error(e);
            }
            const patched = applyEdits(patchBaseSource, patchEdits);
            if (!patched.ok) {
                return { isError: true, content: [{ type: 'text', text: `${patched.error}\nNothing was locked or written.` }] };
            }
            sourceCode = patched.text;
            validateSourceLineLengths(sourceCode);
            sourceDiagnostics = describeSource(sourceCode, false);
            patchSummary = describePatch(patchEdits, patched.applied);
        }

        // Optional pre-write syntax check (stateless, no lock): refuse a bad edit before it costs a
        // lock → PUT → unlock → activate cycle. Only possible for an object that already exists;
        // a brand-new one is created below and then written normally. A failing check *call*
        // never blocks a normal write — only a reported error does.
        let syntaxNote = '';
        if (syntaxCheck) {
            if (!objInfo) {
                if (checkOnly) {
                    return { isError: true, content: [{ type: 'text', text: `check_only needs an existing object, but '${programName}' was not found.` }] };
                }
            } else {
                try {
                    const check = await runSyntaxCheck(String(baseUrl), objInfo.uri, sourceCode);
                    const report = formatSyntaxMessages(check);
                    if (check.errors > 0) {
                        return { isError: true, content: [{ type: 'text', text: `${report}\nNothing was locked or written.` }] };
                    }
                    if (checkOnly) {
                        return { isError: false, content: [{ type: 'text', text: `${patchSummary ? patchSummary + '\n' : ''}${report}\nCheck only — nothing was locked or written.` }] };
                    }
                    syntaxNote = `\n${report}`;
                } catch (e: any) {
                    if (checkOnly) return return_error(e);
                    syntaxNote = `\nSyntax check could not run (${e?.message || String(e)}) — continued with the write.`;
                }
            }
        }

        // If object doesn't exist, try to create it
        if (!objInfo) {
            if (!description || !packageName) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Object '${programName}' not found in SAP system.\nTo create it, provide 'description' and 'package_name' parameters.` }]
                };
            }
            validateNameLength(programName, objectType === 'FUNC' ? 'FUNC' : (CREATION_TYPES[objectType] ? objectType : 'PROG'), objectType === 'FUNC' ? 'function module name' : 'object name');
            if (objectType === 'FUNC' && functionGroup) {
                validateNameLength(functionGroup, 'FUGR', 'function group name');
            }

            let preCreatedTransport = false; // transport made by this call, before the object exists
            // Create the transport BEFORE the object itself, using a deferred (not-yet-existing)
            // object reference, so the create call below can pass corrNr and never trigger SAP's
            // own auto-generated "Generated Request for Change Recording" transport.
            if (!effectiveTransportNumber && transportDescription) {
                const deferredRef = objectType === 'FUNC'
                    ? `/sap/bc/adt/functions/groups/${encodeURIComponent(functionGroup.toLowerCase())}/fmodules/${encodeURIComponent(programName)}`
                    : `/sap/bc/adt/${(CREATION_TYPES[objectType] || CREATION_TYPES['PROG']).creationPath}/${encodeURIComponent(programName)}`;
                const tRes = await createTransportForObject(String(baseUrl), deferredRef, transportDescription, packageName);
                if (tRes.error) return { isError: true, content: [{ type: 'text', text: tRes.error }] };
                effectiveTransportNumber = tRes.transportNumber!;
                autoCreatedTaskNumber = tRes.taskNumber || '';
                preCreatedTransport = true;
            }

            if (objectType === 'FUNC') {
                // Function module: needs a host function group. Ensure the group exists
                // (create it on demand), then create the bare FM shell. Its signature
                // (IMPORTING/EXPORTING/…) comes from the inline header in source/main, which
                // the PUT below writes — so we create an empty shell here.
                if (!functionGroup) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `To create function module '${programName}', provide 'function_group' (the host function group).` }]
                    };
                }
                const fgResult = await ensureFunctionGroup(String(baseUrl), functionGroup, description, packageName, effectiveTransportNumber);
                if (fgResult.error) {
                    const cleanup = preCreatedTransport ? await discardAutoCreatedTransport(String(baseUrl), effectiveTransportNumber) : '';
                    return { isError: true, content: [{ type: 'text', text: fgResult.error + cleanup }] };
                }
                const fmResult = await createFunctionModule(String(baseUrl), programName, functionGroup, description, effectiveTransportNumber);
                if (fmResult.error) {
                    return { isError: true, content: [{ type: 'text', text: fmResult.error }] };
                }
            } else {
                const createResult = await createObject(String(baseUrl), programName, objectType, description, packageName, effectiveTransportNumber);
                if (createResult.error) {
                    const cleanup = preCreatedTransport ? await discardAutoCreatedTransport(String(baseUrl), effectiveTransportNumber) : '';
                    return { isError: true, content: [{ type: 'text', text: createResult.error + cleanup }] };
                }
            }

            // Re-resolve after creation. Build the URI directly from the same creation path we
            // just POSTed to, and verify it with a metadata GET, rather than re-discovering it
            // through SAP's quickSearch index — that index does not reliably return a
            // freshly-created, still-inactive PROG/P object (live-verified: CLAS/CDS resolved
            // immediately after create, PROG did not — see
            // prior testing). Fall back to the
            // old search-based resolution only if the deterministic URL doesn't check out.
            objInfo = directObjectInfo(objectType, programName, functionGroup);
            if (objInfo && !(await verifyObjectUrl(String(baseUrl), objInfo.uri))) {
                objInfo = null;
            }
            if (!objInfo) {
                objInfo = await resolveObjectInfo(String(baseUrl), programName);
            }
            if (!objInfo) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Object '${programName}' was created but could not be resolved. Try again.` }]
                };
            }
            created = true;
        }
        // Existing object + transport_description: the transport is created AFTER the lock (below),
        // once the lock result shows whether the object already sits in a request. Creating it
        // first left an empty CR behind whenever the lock failed or the object was already in
        // another request.

        const objectUrl = `${baseUrl}${objInfo.uri}`;
        const sourceUrl = `${objectUrl}/source/main`;

        // ── Step 1: Lock ──────────────────────────────────────────────
        let lockHandle: string;
        let existingCorrNr = '';   // transport the object is already locked under (lock-result CORRNR)
        let existingCorrText = ''; // its description (CORRTEXT)
        // Purge any sap-contextid left over from an earlier call that never reached its own
        // removeCookie (e.g. process killed mid-flight) — otherwise this LOCK POST rides that
        // stale session and self-conflicts with "User X is currently editing" on a free object.
        removeCookie('sap-contextid');
        try {
            const lockResponse = await makeAdtRequest(
                String(objectUrl), 'POST', 15000, '',
                { _action: 'LOCK', accessMode: 'MODIFY' },
                {
                    'Accept': 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
                    'X-sap-adt-sessiontype': 'stateful'
                }
            );
            const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
            const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
            if (ctxMatch) {
                appendCookie(ctxMatch[1]);
                refreshStatefulOperationToken(ctxMatch[1]); // show the real sap-contextid, not the pending placeholder
            }

            const lockXml = typeof lockResponse.data === 'string' ? lockResponse.data : String(lockResponse.data || '');
            const convert = require('xml-js');
            const lockParsed = convert.xml2js(lockXml, { compact: true }) as any;
            const lockData = lockParsed?.['asx:abap']?.['asx:values']?.['DATA'] || {};
            lockHandle = lockData?.['LOCK_HANDLE']?._text || '';
            existingCorrNr = lockData?.['CORRNR']?._text || '';
            existingCorrText = lockData?.['CORRTEXT']?._text || '';
            if (!lockHandle) throw new Error('Lock handle not found in response');
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    const lines = [`Failed to lock ${objInfo.typeLabel} '${programName}'.`, `Reason: ${errMsg}`];
                    const lockedByLine = describeLockHolder(errMsg);
                    if (lockedByLine) lines.push(lockedByLine);
                    return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
                }
            }
            return return_error(error);
        }

        // ── Guard: never reassign an object to a different change request ──
        // The lock-result CORRNR is the transport this object is already locked under.
        // If the caller passes a different transport_number, SAP would SILENTLY move the
        // object out of its current request into the new one — a data-integrity hazard.
        // Refuse: unlock and report the conflict so the caller can decide.
        if (effectiveTransportNumber && existingCorrNr && existingCorrNr !== effectiveTransportNumber) {
            const unlockError = await attemptUnlock(objectUrl, lockHandle);

            const label = objInfo.typeLabel.charAt(0).toUpperCase() + objInfo.typeLabel.slice(1);
            const txt = existingCorrText ? ` ("${existingCorrText}")` : '';
            const lines = [
                `${label} '${programName}' is already locked in change request ${existingCorrNr}${txt}.`,
                `Refusing to reassign it to ${effectiveTransportNumber} — an object must stay in a single change request.`,
                `Re-run with transport_number=${existingCorrNr}, or omit transport_number to keep using the existing one.`
            ];
            if (unlockError) lines.push(`Additionally, failed to release the lock taken for this check.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object may now remain locked — retry with UnlockObject('${programName}') before the next attempt.`);
            return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // ── Deferred transport creation (existing object, transport_description) ──
        // Only now is it known that the lock succeeded. If the object is already in a change
        // request, SAP keeps using that one and no new CR is created.
        let reusedExistingTransportNote = '';
        if (!created && !effectiveTransportNumber && transportDescription) {
            if (existingCorrNr) {
                effectiveTransportNumber = existingCorrNr; // pass it as corrNr so SAP doesn't reject the PUT against its own registration
                reusedExistingTransportNote = `transport_description ignored: ${programName} is already in change request ${existingCorrNr}, which was kept.`;
            } else {
                const tRes = await createTransportForObject(String(baseUrl), objInfo.uri, transportDescription, packageName);
                if (tRes.error) {
                    const unlockError = await attemptUnlock(objectUrl, lockHandle);
                    const lines = [tRes.error];
                    if (unlockError) lines.push(`Additionally, failed to release the lock.\nReason: ${unlockError}\nLock handle: ${lockHandle}. Retry with UnlockObject('${programName}') before the next attempt.`);
                    return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
                }
                effectiveTransportNumber = tRes.transportNumber!;
                autoCreatedTaskNumber = tRes.taskNumber || '';
            }
        }

        // ── Patch mode: re-read inside the lock; re-apply if SAP's source moved since the first read ──
        if (patchMode) {
            let failure = '';
            try {
                const lockedSource = await readCurrentSource(sourceUrl);
                if (lockedSource !== patchBaseSource) {
                    const again = applyEdits(lockedSource, patchEdits);
                    if (again.ok) {
                        sourceCode = again.text;
                        sourceDiagnostics = describeSource(sourceCode, false);
                        patchSummary = describePatch(patchEdits, again.applied) + ' (SAP source had changed since it was first read — edits re-applied to the newer text)';
                    } else {
                        failure = `The source of '${programName}' changed in SAP after it was first read, and the edits no longer apply: ${again.error}`;
                    }
                }
            } catch (e: any) {
                failure = `Could not re-read the source after locking: ${e?.message || String(e)}`;
            }
            if (failure) {
                const unlockError = await attemptUnlock(objectUrl, lockHandle);
                const extra = unlockError ? `\nAdditionally, failed to release the lock.\nReason: ${unlockError}\nLock handle: ${lockHandle}. Retry with UnlockObject('${programName}').` : '';
                return { isError: true, content: [{ type: 'text', text: `${failure}\nNothing was written.${extra}` }] };
            }
        }

        // ── Step 2: PUT source code ───────────────────────────────────
        try {
            const putParams: Record<string, string> = { lockHandle };
            if (effectiveTransportNumber) putParams['corrNr'] = effectiveTransportNumber;

            await makeAdtRequest(
                String(sourceUrl), 'PUT', 30000, sourceCode,
                putParams,
                { 'Content-Type': 'text/plain; charset=utf-8', 'X-sap-adt-sessiontype': 'stateful' }
            );
        } catch (error) {
            const unlockError = await attemptUnlock(objectUrl, lockHandle);
            const unlockNote = unlockError
                ? `\nAdditionally, failed to release the lock.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object may now remain locked — retry with UnlockObject('${programName}') before the next attempt.`
                : '';

            if (error instanceof AxiosError && error.response?.data) {
                const rawResponse = String(error.response.data);
                const errMsg = parseAdtErrorXml(rawResponse);
                const lines = [
                    `Failed to write source for ${objInfo.typeLabel} '${programName}'.`,
                    sourceDiagnostics,
                    `Reason: ${errMsg || `HTTP ${error.response.status}`}`,
                    `DIAGNOSIS: SAP rejected the source PUT before activation. The available error does not establish a CTS or repository-state cause. Investigate a source-size, parser, syntax, lock, or transport issue.`
                ];
                if (includeRawSapResponse) {
                    lines.splice(3, 0, `Raw SAP ADT response:\n${rawResponse}`);
                } else {
                    lines.push(`Raw SAP ADT response omitted. Re-run with include_raw_sap_response=true to return it for diagnosis.`);
                }
                const splitterGuidance = getSourceSplitterGuidance(rawResponse);
                if (splitterGuidance) lines.push(splitterGuidance);
                const tablesHint = getTablesStructureHint(rawResponse, sourceCode);
                if (tablesHint) lines.push(tablesHint);
                if (unlockNote) lines.push(unlockNote.trim());
                return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
            }
            const baseResult = return_error(error);
            if (unlockNote && baseResult?.content?.[0]?.type === 'text') {
                baseResult.content[0].text += unlockNote;
            }
            return baseResult;
        }

        // ── Step 2b: PUT text-element categories (optional, programs only) ───
        // Text-elements at /sap/bc/adt/textelements/programs/{name} is a SEPARATE lockable
        // resource (REPT / PROG/PX) in SAP — the main program lock handle does NOT grant
        // write access here. We acquire one lock against the text-elements URL and PUT each
        // requested subobject (symbols / selections / headings) under that single lock.
        const textElErrors: string[] = [];
        if (hasAnyTextElements) {
            if (objInfo.type !== 'PROG/P') {
                textElErrors.push(`Text elements supported only for PROG/P; object is ${objInfo.type}. Skipped.`);
            } else {
                const textElUrl = `${baseUrl}/sap/bc/adt/textelements/programs/${encodeURIComponent(objInfo.name.toLowerCase())}`;
                let textLockHandle: string | null = null;
                try {
                    const lockResp = await makeAdtRequest(
                        String(textElUrl), 'POST', 15000, '',
                        { _action: 'LOCK', accessMode: 'MODIFY' },
                        {
                            'Accept': 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
                            'X-sap-adt-sessiontype': 'stateful'
                        }
                    );
                    const convert = require('xml-js');
                    const lockParsed = convert.xml2js(
                        typeof lockResp.data === 'string' ? lockResp.data : String(lockResp.data || ''),
                        { compact: true }
                    ) as any;
                    textLockHandle = lockParsed?.['asx:abap']?.['asx:values']?.['DATA']?.['LOCK_HANDLE']?._text || '';
                    if (!textLockHandle) throw new Error('Text-elements lock handle missing');

                    const putCategory = async (category: 'symbols' | 'selections' | 'headings', body: string, mime: string) => {
                        const putParams: Record<string, string> = { lockHandle: textLockHandle! };
                        if (effectiveTransportNumber) putParams['corrNr'] = effectiveTransportNumber;
                        await makeAdtRequest(
                            `${textElUrl}/source/${category}`, 'PUT', 30000, body, putParams,
                            {
                                'Content-Type': `${mime}; charset=utf-8`,
                                'X-sap-adt-sessiontype': 'stateful'
                            }
                        );
                    };

                    const categories: { cat: 'symbols' | 'selections' | 'headings'; body: string | null; mime: string; label: string }[] = [
                        { cat: 'symbols',    body: textSymbols,    mime: 'application/vnd.sap.adt.textelements.symbols.v1',    label: 'symbols' },
                        { cat: 'selections', body: selectionTexts, mime: 'application/vnd.sap.adt.textelements.selections.v1', label: 'selections' },
                        { cat: 'headings',   body: listHeadings,   mime: 'application/vnd.sap.adt.textelements.headings.v1',   label: 'headings' }
                    ];
                    for (const c of categories) {
                        if (c.body === null) continue;
                        try {
                            await putCategory(c.cat, c.body, c.mime);
                        } catch (error) {
                            let msg: string;
                            if (error instanceof AxiosError && error.response?.data) {
                                msg = parseAdtErrorXml(String(error.response.data)) || `HTTP ${error.response?.status}`;
                            } else {
                                msg = error instanceof Error ? error.message : String(error);
                            }
                            textElErrors.push(`${c.label}: ${msg}`);
                        }
                    }
                } catch (error) {
                    if (error instanceof AxiosError && error.response?.data) {
                        const errMsg = parseAdtErrorXml(String(error.response.data));
                        textElErrors.push(`lock: ${errMsg || `HTTP ${error.response?.status}`}`);
                    } else {
                        textElErrors.push(`lock: ${error instanceof Error ? error.message : String(error)}`);
                    }
                } finally {
                    if (textLockHandle) {
                        try {
                            await makeAdtRequest(
                                String(textElUrl), 'POST', 10000, '',
                                { _action: 'UNLOCK', lockHandle: encodeURIComponent(textLockHandle) },
                                { 'X-sap-adt-sessiontype': 'stateful' }
                            );
                        } catch (_) { /* swallow — main flow continues */ }
                    }
                }
            }
        }
        // For backward-compat with the existing result-formatting code below
        const textSymbolsError: string | null = textElErrors.length > 0 ? textElErrors.join('; ') : null;

        // ── Step 3: Unlock ────────────────────────────────────────────
        // Source is already written at this point regardless of what follows. A failed
        // unlock here means the object stays locked, and activation (step 4) is documented
        // to fail while a lock is held — so skip that doomed call and say so plainly instead
        // of letting it surface as a separate, harder-to-diagnose activation error.
        const unlockError = await attemptUnlock(objectUrl, lockHandle);

        // ── Step 4: Activate (optional) ───────────────────────────────
        let activationResult = '';
        if (unlockError) {
            activationResult = `\n\nActivation SKIPPED — unlock FAILED after writing source.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object likely remains locked. Run UnlockObject('${programName}') to clear it, then call WriteProgram again (or activate manually) once it succeeds.`;
        } else if (activate) {
            try {
                const refs: string[] = [
                    `<adtcore:objectReference adtcore:uri="${objInfo.uri}" adtcore:name="${objInfo.name}"/>`
                ];
                // If any text-element category was written successfully, include the PROG/PX
                // text-elements reference so SAP activates the text pool in the same call.
                if (hasAnyTextElements && textElErrors.length === 0 && objInfo.type === 'PROG/P') {
                    const textElUri = `/sap/bc/adt/textelements/programs/${objInfo.name.toLowerCase()}`;
                    refs.push(`<adtcore:objectReference adtcore:uri="${textElUri}" adtcore:name="${objInfo.name}"/>`);
                }
                const activationBody =
                    `<?xml version="1.0" encoding="UTF-8"?>` +
                    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
                    refs.join('') +
                    `</adtcore:objectReferences>`;

                const actResponse = await makeAdtRequest(
                    `${baseUrl}/sap/bc/adt/activation`, 'POST', 30000,
                    activationBody, { method: 'activate', preauditRequested: true },
                    {
                        'Content-Type': 'application/xml',
                        'Accept': 'application/xml',
                    }
                );

                const actData = typeof actResponse.data === 'string' ? actResponse.data : String(actResponse.data || '');

                const hasBody = actData.trim().length > 0;
                // activationExecuted="false" alone is NOT a failure — it just means SAP found
                // nothing to activate (e.g. this exact source was already active from a prior
                // no-op write). Only a real <msg type="E"> (or an explicit fail/error status)
                // is a genuine failure — same classification ActivateObjects already uses.
                const generated = actData.includes('generationExecuted="true"');
                const activationSkipped = actData.includes('activationExecuted="false"');
                const activationFailed = hasBody && (
                    actData.includes('type="E"') ||
                    actData.includes('status="fail"') ||
                    actData.includes('severity="error"')
                );

                if (activationFailed) {
                    try {
                        const convert = require('xml-js');
                        const parsed = convert.xml2js(actData, { compact: false }) as any;
                        const messages: string[] = [];

                        function extractMessages(node: any) {
                            if (!node) return;
                            if (node.name === 'msg' && node.attributes) {
                                const msgType = node.attributes['type'] || '';
                                const line = node.attributes['line'] || '';
                                const objDescr = node.attributes['objDescr'] || '';
                                const texts: string[] = [];
                                const shortTextNode = node.elements?.find((e: any) => e.name === 'shortText');
                                if (shortTextNode?.elements) {
                                    for (const txtNode of shortTextNode.elements) {
                                        if (txtNode.name === 'txt' && txtNode.elements?.[0]?.text) {
                                            texts.push(txtNode.elements[0].text);
                                        }
                                    }
                                }
                                if (texts.length > 0) {
                                    let msg = `  [${msgType}]`;
                                    if (objDescr) msg += ` ${objDescr}`;
                                    if (line && line !== '0') msg += ` Line ${line}`;
                                    msg += `: ${texts.join(' — ')}`;
                                    messages.push(msg);
                                }
                            }
                            if (node.elements) {
                                for (const child of node.elements) {
                                    extractMessages(child);
                                }
                            }
                        }
                        extractMessages(parsed);

                        if (messages.length > 0) {
                            activationResult = `\n\nActivation FAILED with errors:\n${messages.join('\n')}`;
                            const tablesHint = getTablesStructureHint(messages.join('\n'), sourceCode);
                            if (tablesHint) activationResult += `\n${tablesHint}`;
                        } else {
                            activationResult = `\n\nActivation FAILED. Raw response:\n${actData.substring(0, 2000)}`;
                        }
                    } catch (_) {
                        activationResult = `\n\nActivation FAILED. Raw response:\n${actData.substring(0, 2000)}`;
                    }
                } else {
                    const label = objInfo.typeLabel.charAt(0).toUpperCase() + objInfo.typeLabel.slice(1);
                    activationResult = activationSkipped
                        ? `\n${label} — nothing to activate (source unchanged from active version${generated ? '; generation refreshed' : ''}).`
                        : `\n${label} activated successfully.`;
                }
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    activationResult = `\n\nActivation failed: ${errMsg || String(error.response.data).substring(0, 500)}`;
                } else {
                    activationResult = `\n\nActivation failed: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
        }

        // ── Result ────────────────────────────────────────────────────
        const lines: string[] = [];
        if (created) {
            lines.push(`Created ${objInfo.typeLabel} '${programName}' in package '${packageName}'.`);
        }
        lines.push(`Source code written to ${objInfo.typeLabel} '${programName}'.`);
        if (created && objInfo.type === 'CLAS/OC' && /activation failed/i.test(activationResult)) {
            lines.push(`RECOVERY: This was the class's first activation. Correct the complete source and retry WriteProgram. If SAP rejects the overwrite, use SAP GUI/Eclipse ADT to remove the class's CTS/deletion entry from its change request, remove its inactive-object entry, then delete the repository object before recreating the name.`);
        }
        if (effectiveTransportNumber) lines.push(`Transport: ${effectiveTransportNumber}${!transportNumber && transportDescription && !reusedExistingTransportNote ? ' (auto-created)' : ''}`);
        if (autoCreatedTaskNumber) lines.push(`Task: ${autoCreatedTaskNumber}`);
        if (reusedExistingTransportNote) lines.push(reusedExistingTransportNote);
        lines.push(sourceDiagnostics);
        if (patchSummary) lines.push(patchSummary);
        if (syntaxNote) lines.push(syntaxNote.trim());
        if (hasAnyTextElements) {
            const written: string[] = [];
            if (textSymbols !== null)    written.push(`symbols(${textSymbols.length}c)`);
            if (selectionTexts !== null) written.push(`selections(${selectionTexts.length}c)`);
            if (listHeadings !== null)   written.push(`headings(${listHeadings.length}c)`);
            if (textSymbolsError) {
                lines.push(`Text elements: FAILED — ${textSymbolsError}`);
            } else {
                lines.push(`Text elements written: ${written.join(', ')}`);
            }
        }
        if (activationResult) {
            lines.push(activationResult);
            if (patchMode && activationResult.includes('FAILED')) {
                lines.push(`The patched source IS saved, but '${programName}' is INACTIVE. Repair it with another edits[] call (patches apply to the inactive working version), or rewrite with source_code. SAP's activation messages can report "Line 1" instead of the real line — use syntax_check=true (or check_only=true) to get the exact line:col before saving.`);
            }
        } else if (!activate) {
            lines.push(`Not activated (activate=false) — the saved source stays inactive until a later write without activate=false, or ActivateObjects.`);
        }

        const hasError = activationResult.includes('FAILED') || !!textSymbolsError;
        return {
            isError: hasError,
            content: [{ type: 'text', text: lines.join('\n') }]
        };
    } catch (error) {
        return return_error(error);
    }
}

async function readCurrentSource(sourceUrl: string): Promise<string> {
    const r = await makeAdtRequest(sourceUrl, 'GET', 30000, undefined, undefined, { 'Accept': 'text/plain' });
    return typeof r.data === 'string' ? r.data : String(r.data ?? '');
}

// Line counts come from the edits themselves (O(edit size)) rather than a diff of the whole
// source, which is O(lines²) and would eat the time patch mode exists to save.
function describePatch(edits: PatchEdit[], applied: { replacements: number; line: number }[]): string {
    const lineCount = (t: string) => t.length === 0 ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
    let added = 0, removed = 0;
    applied.forEach((a, i) => {
        // anchor context (identical leading/trailing lines of old and new) is not a change
        const o = edits[i].old_string.replace(/\r\n/g, '\n').split('\n');
        const n = edits[i].new_string.replace(/\r\n/g, '\n').split('\n');
        let head = 0;
        while (head < o.length && head < n.length && o[head] === n[head]) head++;
        let tail = 0;
        while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++;
        const oldChanged = o.slice(head, o.length - tail).join('\n');
        const newChanged = n.slice(head, n.length - tail).join('\n');
        added += a.replacements * lineCount(newChanged);
        removed += a.replacements * lineCount(oldChanged);
    });
    const where = applied.map(a => `${a.replacements > 1 ? `${a.replacements}x from ` : ''}line ${a.line}`).join(', ');
    return `Patched with ${applied.length} edit(s): +${added} −${removed} lines (${where}).`;
}

function describeSource(sourceCode: string, fromSourceFile: boolean): string {
    const lines = sourceCode.split(/\r?\n/);
    const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return `Source diagnostics: ${Buffer.byteLength(sourceCode, 'utf8')} bytes, ${lines.length} lines, maximum line length ${maxLineLength} characters, source_file=${fromSourceFile ? 'yes' : 'no'}.`;
}

function validateSourceLineLengths(sourceCode: string): void {
    const lines = sourceCode.split(/\r?\n/);
    const overlongLine = lines.findIndex(line => line.length > 255);
    if (overlongLine >= 0) {
        throw new McpError(ErrorCode.InvalidParams,
            `Line ${overlongLine + 1} exceeds SAP's 255-character source-line limit (${lines[overlongLine].length} characters). Source code cannot be processed.`);
    }
}

// ADT's inline FM signature rejects `TABLES <p> STRUCTURE <type>` with "Parameter <P> declares
// no type"; `LIKE <type>` is the accepted form (STRUCTURE only exists in SE37's form editor).
function getTablesStructureHint(errorText: string, sourceCode: string): string | null {
    if (!/declares no type/i.test(errorText)) return null;
    if (!/\bTABLES\b[\s\S]*?\bSTRUCTURE\b/i.test(sourceCode)) return null;
    return `HINT: ADT inline FM signatures reject 'TABLES <param> STRUCTURE <type>' ("declares no type"). Rewrite each TABLES parameter as 'LIKE <DDIC structure>' and retry.`;
}

function getSourceSplitterGuidance(rawResponse: string): string | null {
    if (!/OO_SOURCE_BASED/i.test(rawResponse)) return null;
    if (/T100KEY[-:]?NO(?:[^0-9]{0,80})0*11\b/i.test(rawResponse) || /can't be separated into its different source parts/i.test(rawResponse)) {
        return `SOURCE SPLITTER ERROR (OO_SOURCE_BASED011): SAP could not separate the class into definition sections or method implementations before syntax checking. Check CLASS-METHODS section order (IMPORTING, EXPORTING, CHANGING, RETURNING) and bisect the class definition before changing CTS state.`;
    }
    if (/T100KEY[-:]?NO(?:[^0-9]{0,80})0*12\b/i.test(rawResponse) || /unknown comments.*can't be stored/i.test(rawResponse)) {
        return `SOURCE SPLITTER ERROR (OO_SOURCE_BASED012): SAP rejected comments it cannot store. Remove banner comments outside methods, including comments between the definition and implementation blocks; keep explanatory comments inside METHOD ... ENDMETHOD.`;
    }
    return `SOURCE SPLITTER ERROR: SAP rejected the class source before activation. Request include_raw_sap_response=true and inspect the OO_SOURCE_BASED message before changing CTS or repository state.`;
}

async function createObject(
    baseUrl: string, name: string, objectType: string,
    description: string, packageName: string, transportNumber: string
): Promise<{ error?: string }> {
    const typeDef = CREATION_TYPES[objectType];
    if (!typeDef) {
        return { error: `Unsupported object_type '${objectType}'. Supported: PROG, INCL, FUGR, CLAS` };
    }

    const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<${typeDef.rootName} ${typeDef.nameSpace}` +
        ` xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:description="${escapeXml(description)}"` +
        ` adtcore:name="${name}" adtcore:type="${typeDef.typeId}">` +
        `<adtcore:packageRef adtcore:name="${packageName}"/>` +
        `</${typeDef.rootName}>`;

    const url = `${baseUrl}/sap/bc/adt/${typeDef.creationPath}`;
    const params: Record<string, string> = {};
    if (transportNumber) params['corrNr'] = transportNumber;

    try {
        await makeAdtRequest(url, 'POST', 30000, body, params, {
            'Content-Type': typeDef.contentType || 'application/*'
        });
        return {};
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { error: `Failed to create ${objectType} '${name}'.\nReason: ${errMsg}` };
        }
        return { error: `Failed to create ${objectType} '${name}': ${error instanceof Error ? error.message : String(error)}` };
    }
}

// Ensure a function group exists, creating it (FUGR/F) on demand. Idempotent: a 200 on the
// container GET means it already exists and we leave it untouched.
async function ensureFunctionGroup(
    baseUrl: string, group: string, description: string, packageName: string, transportNumber: string
): Promise<{ error?: string }> {
    const groupUrl = `${baseUrl}/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}`;
    try {
        await makeAdtRequest(groupUrl, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        return {}; // already exists
    } catch (error) {
        if (!(error instanceof AxiosError) || error.response?.status !== 404) {
            // Unexpected error (not a clean "missing") — surface it
            const msg = error instanceof AxiosError && error.response?.data
                ? (parseAdtErrorXml(String(error.response.data)) || `HTTP ${error.response?.status}`)
                : (error instanceof Error ? error.message : String(error));
            return { error: `Failed to check function group '${group}': ${msg}` };
        }
    }
    // 404 → create it
    const createResult = await createObject(baseUrl, group, 'FUGR', description, packageName, transportNumber);
    if (createResult.error) return { error: createResult.error };
    return {};
}

// Create a bare function-module shell (FUGR/FF) inside an existing group. The signature and
// body are written afterwards via the FM's source/main (the inline FUNCTION-header form).
async function createFunctionModule(
    baseUrl: string, fmName: string, group: string, description: string, transportNumber: string
): Promise<{ error?: string }> {
    const groupLower = group.toLowerCase();
    const containerUri = `/sap/bc/adt/functions/groups/${groupLower}`;
    const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<fmodule:abapFunctionModule xmlns:fmodule="http://www.sap.com/adt/functions/fmodules"` +
        ` xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:description="${escapeXml(description)}"` +
        ` adtcore:name="${fmName}" adtcore:type="FUGR/FF">` +
        `<adtcore:containerRef adtcore:uri="${containerUri}" adtcore:type="FUGR/F" adtcore:name="${group}"/>` +
        `</fmodule:abapFunctionModule>`;

    const url = `${baseUrl}${containerUri}/fmodules`;
    const params: Record<string, string> = {};
    if (transportNumber) params['corrNr'] = transportNumber;

    try {
        await makeAdtRequest(url, 'POST', 30000, body, params, {
            'Content-Type': 'application/vnd.sap.adt.functions.fmodules.v3+xml'
        });
        return {};
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { error: `Failed to create function module '${fmName}' in group '${group}'.\nReason: ${errMsg}` };
        }
        return { error: `Failed to create function module '${fmName}' in group '${group}': ${error instanceof Error ? error.message : String(error)}` };
    }
}

export function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Best-effort unlock used on every exit path that holds a lock handle. Returns null on
// success, or the parsed SAP error text on failure — callers surface that text instead of
// silently swallowing it, so a stray lock is never left unreported (see UnlockObject to
// recover from one after the fact).
export async function attemptUnlock(objectUrl: string, lockHandle: string): Promise<string | null> {
    try {
        await makeAdtRequest(String(objectUrl), 'POST', 15000, '',
            { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
            { 'X-sap-adt-sessiontype': 'stateless' });
        return null;
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return errMsg;
        }
        return error instanceof Error ? error.message : String(error);
    } finally {
        removeCookie('sap-contextid');
    }
}

// Extracts the editing user from a "User X is currently editing Y" lock-conflict message
// and flags whether it is this connection's own configured user (a leftover SAP GUI/ADT
// session, or a lock orphaned by an earlier interrupted call) versus a different developer
// (never force-unlock — coordinate with them, or escalate to SAP Basis/SM12).
export function describeLockHolder(errMsg: string): string | null {
    const match = errMsg.match(/User\s+([^\s]+)\s+is currently editing/i);
    if (!match) return null;
    const editingUser = match[1];
    const configuredUser = getConfig().username?.toUpperCase() || '';
    if (editingUser.toUpperCase() === configuredUser) {
        return `This is your own configured SAP user (${configuredUser}) — likely a leftover SAP GUI/ADT session, or a lock orphaned by an earlier interrupted WriteProgram call. Try UnlockObject, or close the leftover session.`;
    }
    return `This is a different user (${editingUser}) — do not force-unlock without checking with them.`;
}

// Explicitly creates a transport with a proper description, instead of letting SAP
// auto-generate one (with the generic text "Generated Request for Change Recording") the
// first time a source PUT or object-create happens without a corrNr. `ref` may point at an
// object that does not exist yet — SAP derives the transport layer/target purely from
// DEVCLASS and the URL's shape, not from the object actually existing (verified live).
// Best-effort cleanup of a transport WriteProgram itself just auto-created, when the object
// create that needed it as corrNr then failed — otherwise an empty request is orphaned.
// SAP only deletes an unreleased transport with no registered objects, so this is refused
// harmlessly if the failed create did register something. Returns a line for the error text.
async function discardAutoCreatedTransport(baseUrl: string, transportNumber: string): Promise<string> {
    try {
        await makeAdtRequest(`${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`,
            'DELETE', 20000, undefined, undefined, { 'Accept': 'application/*' });
        return `\nThe transport ${transportNumber} auto-created for this call was empty and has been deleted again.`;
    } catch (error) {
        let reason = error instanceof Error ? error.message : String(error);
        if (error instanceof AxiosError && error.response?.data) reason = parseAdtErrorXml(String(error.response.data)) || reason;
        return `\nThe transport ${transportNumber} auto-created for this call could NOT be deleted (${reason}) — remove it with ManageTransport action=delete.`;
    }
}

export async function createTransportForObject(
    baseUrl: string, ref: string, description: string, devClass: string
): Promise<{ transportNumber?: string; taskNumber?: string; error?: string }> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <DEVCLASS>${escapeXml(devClass)}</DEVCLASS>
      <REQUEST_TEXT>${escapeXml(description)}</REQUEST_TEXT>
      <REF>${escapeXml(ref)}</REF>
      <OPERATION>I</OPERATION>
    </DATA>
  </asx:values>
</asx:abap>`;
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/cts/transports`, 'POST', 30000, body, undefined, {
            'Content-Type': 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest',
            'Accept': 'text/plain'
        });
        const responseText = typeof response.data === 'string' ? response.data : String(response.data || '');
        const transportNumber = responseText.trim().split('/').pop() || '';
        if (!transportNumber) return { error: 'Failed to auto-create transport: SAP returned an empty response.' };

        // SAP already attaches a task to the request as part of creating it (verified live) —
        // read it back purely for the caller's visibility, don't place a second one on top.
        const existingTasks = await getExistingTasks(baseUrl, transportNumber);
        return { transportNumber, taskNumber: existingTasks[0] };
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { error: `Failed to auto-create transport.\nReason: ${errMsg}` };
        }
        return { error: `Failed to auto-create transport: ${error instanceof Error ? error.message : String(error)}` };
    }
}

// Builds the object's ADT URI from the exact creation path just POSTed to, rather than
// re-discovering it via search. FUNC has no CREATION_TYPES entry (see the FUGR-container note
// above) so it's handled separately using the same group/name shape createFunctionModule() used.
function directObjectInfo(objectType: string, name: string, functionGroup?: string): ObjectInfo | null {
    if (objectType === 'FUNC') {
        if (!functionGroup) return null;
        return {
            uri: `/sap/bc/adt/functions/groups/${functionGroup.toLowerCase()}/fmodules/${name}`,
            type: 'FUGR/FF',
            name,
            typeLabel: 'function module'
        };
    }
    const typeDef = CREATION_TYPES[objectType];
    if (!typeDef) return null;
    const typeLabel = objectType === 'INCL' ? 'include' : objectType === 'CLAS' ? 'class' : 'program';
    return {
        uri: `/sap/bc/adt/${typeDef.creationPath}/${name}`,
        type: typeDef.typeId,
        name,
        typeLabel
    };
}

// Confirms a just-created object's deterministic URI actually resolves before trusting it —
// a lightweight metadata GET (no /source/main), same call shape as the HATEOAS discovery
// pattern used elsewhere in this codebase.
async function verifyObjectUrl(baseUrl: string, uri: string): Promise<boolean> {
    try {
        await makeAdtRequest(`${baseUrl}${uri}`, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        return true;
    } catch {
        return false;
    }
}

async function resolveObjectInfo(baseUrl: string, objectName: string): Promise<ObjectInfo | null> {
    try {
        const searchUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(objectName)}&maxResults=10`;
        const response = await makeAdtRequest(searchUrl, 'GET', 15000);
        const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? response);

        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];
        const refKey = Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
        if (!refKey) return null;

        const rawRefs = root[refKey];
        const refs = Array.isArray(rawRefs) ? rawRefs : [rawRefs];

        const getAttr = (attrs: any, localName: string): string => {
            const key = Object.keys(attrs).find((k: string) => k === localName || k.endsWith(':' + localName));
            return key ? String(attrs[key] || '') : '';
        };

        for (const ref of refs) {
            const attrs = ref._attributes || {};
            const name = getAttr(attrs, 'name').toUpperCase();
            const type = getAttr(attrs, 'type').toUpperCase();
            const uri = getAttr(attrs, 'uri');

            if (name === objectName && uri) {
                const typeLabel = type === 'PROG/I' ? 'include'
                    : type === 'FUGR/FF' ? 'function module'
                    : type === 'CLAS/OC' ? 'class'
                    : 'program';
                return { uri, type, name, typeLabel };
            }
        }
    } catch {
        // Fall through
    }
    return null;
}
