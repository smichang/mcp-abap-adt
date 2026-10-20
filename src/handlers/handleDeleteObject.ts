import { McpError, ErrorCode } from '../lib/utils';
import { isDifferentChange } from '../lib/transportCheck';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { getConfig } from '../index';
import { AxiosError } from 'axios';
import { resolveAnyObject } from '../lib/resolveObject';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

// SAP needs an inactive class's CTS entry and inactive-object record removed before its
// repository object is deleted. Refuse the generic delete until that cleanup is complete.
async function isInactiveForCurrentUser(baseUrl: string, objectName: string, objectUri: string): Promise<boolean> {
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/activation/inactiveobjects`, 'GET', 15000);
        const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        let inactive = false;

        const visit = (node: any): void => {
            if (inactive || !node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                node.forEach(visit);
                return;
            }
            const attrs = node._attributes;
            if (attrs) {
                const name = Object.keys(attrs).find(key => key === 'name' || key.endsWith(':name'));
                const uri = Object.keys(attrs).find(key => key === 'uri' || key.endsWith(':uri'));
                if ((name && String(attrs[name]).toUpperCase() === objectName) ||
                    (uri && String(attrs[uri]) === objectUri)) {
                    inactive = true;
                    return;
                }
            }
            Object.keys(node).forEach(key => {
                if (key !== '_attributes' && key !== '_text') visit(node[key]);
            });
        };

        visit(parsed);
        return inactive;
    } catch {
        // This safety check must not turn a read-side failure into a false claim that the
        // object is inactive. The normal lock/delete flow will still validate SAP access.
        return false;
    }
}

// Best-effort unlock for the failure paths below — mirrors WriteProgram's attemptUnlock.
async function attemptUnlock(objectUrl: string, lockHandle: string): Promise<string | null> {
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

const MAX_BATCH_DELETE = 20;

// object_names[]: delete several objects in one call (the lifecycle test needed one call per object —
// six for a program with five includes). Sequential, in the order given — each delete takes the stateful
// gate on its own, and a program must go BEFORE the includes it includes (SAP keeps an include that a
// program still includes). A failure does not stop the rest; the answer lists every object.
export async function handleDeleteObject(args: any) {
    if (args?.object_names === undefined) return deleteOne(args);
    try {
        if (args?.object_name) throw new McpError(ErrorCode.InvalidParams, 'pass either object_name or object_names, not both');
        const raw = Array.isArray(args.object_names) ? args.object_names : [];
        if (raw.length === 0) throw new McpError(ErrorCode.InvalidParams, 'object_names must be a non-empty array of names (or { object_name, object_type })');
        if (raw.length > MAX_BATCH_DELETE) throw new McpError(ErrorCode.InvalidParams, `object_names has ${raw.length} entries; the maximum is ${MAX_BATCH_DELETE} per call`);
        const lines: string[] = [];
        let failed = 0;
        for (const entry of raw) {
            const e = typeof entry === 'string' ? { object_name: entry } : (entry ?? {});
            const name = String(e.object_name ?? '').toUpperCase();
            if (!name) { failed++; lines.push('? : skipped — an entry has no object_name'); continue; }
            const res = await deleteOne({ object_name: name, object_type: e.object_type ?? args.object_type, transport_number: e.transport_number ?? args.transport_number });
            const first = (res.content?.[0]?.text ?? '').split('\n').find((l: string) => l.trim()) ?? '';
            const detail = res.isError ? (res.content?.[0]?.text ?? '').split('\n').filter((l: string) => l.trim()).slice(0, 3).join(' | ') : first;
            if (res.isError) failed++;
            lines.push(`${res.isError ? '✗' : '✓'} ${name}: ${detail}`);
        }
        lines.unshift(`Deleted ${raw.length - failed} of ${raw.length} object(s)${failed ? ` — ${failed} failed` : ''}:`);
        return { isError: failed > 0, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}

async function deleteOne(args: any) {
    const objectName = args?.object_name ? String(args.object_name).toUpperCase() : '';
    const gate = acquireStatefulOperationLock(`DeleteObject(${objectName || 'unknown'})`);
    if (!gate.ok) return { isError: true, content: [{ type: 'text', text: gate.message }] };
    try {
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : '';
        if (!objectName) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }

        const baseUrl = String(await getBaseUrl());

        const objectType = args?.object_type ? String(args.object_type).toUpperCase() : undefined;
        let resolution;
        try {
            resolution = await resolveAnyObject(baseUrl, objectName, objectType);
        } catch (error) {
            return return_error(error);
        }
        if ('error' in resolution) {
            return { isError: true, content: [{ type: 'text', text: resolution.error }] };
        }
        const resolved = resolution;
        const objectUrl = `${baseUrl}${resolved.uri}`;

        if (resolved.type === 'CLAS/OC' && await isInactiveForCurrentUser(baseUrl, objectName, resolved.uri)) {
            return {
                isError: true,
                content: [{ type: 'text', text:
                    `Refusing to delete inactive class '${objectName}' until its inactive state is cleaned up. First correct the full source and retry WriteProgram. If SAP rejects that write, use SAP GUI/Eclipse ADT to remove the class's CTS/deletion entry from its change request, remove its inactive-object entry, then delete the repository object. Once those three steps complete, the name can be recreated.`
                }]
            };
        }

        // ── Step 1: Lock ──────────────────────────────────────────────
        // Same purge-before-lock precaution as every other stateful-session call site in this
        // codebase (see utils.ts's stale sap-contextid note) — a leftover cookie from an
        // earlier interrupted call would otherwise self-conflict on a genuinely free object.
        removeCookie('sap-contextid');
        let lockHandle: string;
        let existingCorrNr = '';
        let existingCorrText = '';
        try {
            const lockResponse = await makeAdtRequest(
                objectUrl, 'POST', 15000, '',
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
                refreshStatefulOperationToken(ctxMatch[1]);
            }

            const convert = require('xml-js');
            const lockXml = typeof lockResponse.data === 'string' ? lockResponse.data : String(lockResponse.data || '');
            const lockParsed = convert.xml2js(lockXml, { compact: true }) as any;
            const lockData = lockParsed?.['asx:abap']?.['asx:values']?.['DATA'] || {};
            lockHandle = lockData?.['LOCK_HANDLE']?._text || '';
            existingCorrNr = lockData?.['CORRNR']?._text || '';
            existingCorrText = lockData?.['CORRTEXT']?._text || '';
            if (!lockHandle) throw new Error('Lock handle not found in response');
        } catch (error) {
            let reason = '';
            if (error instanceof AxiosError && error.response?.data) {
                reason = parseAdtErrorXml(String(error.response.data)) || '';
            }
            if (!reason) reason = error instanceof Error ? error.message : String(error);

            const editingUserMatch = reason.match(/User\s+([^\s]+)\s+is currently editing/i);
            const editingUser = editingUserMatch ? editingUserMatch[1] : '';
            const configuredUser = getConfig().username?.toUpperCase() || '';

            const lines = [`Failed to lock ${resolved.type} '${objectName}' for deletion.`, `Reason: ${reason}`];
            if (editingUser && editingUser.toUpperCase() === configuredUser) {
                lines.push(`This is your own configured SAP user (${configuredUser}) — likely a leftover SAP GUI/ADT session or an orphaned lock. Try UnlockObject first.`);
            } else if (editingUser) {
                lines.push(`This is a different user (${editingUser}) — do not force this; coordinate with them first.`);
            }
            return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // ── Guard: never silently reassign the object's registration ──
        // Same protection as WriteProgram's reassignment guard: if the object is already
        // locked under a different open transport than the one the caller supplied, refuse
        // rather than let the delete move its registration.
        if (transportNumber && existingCorrNr && await isDifferentChange(baseUrl, resolved.uri, existingCorrNr, transportNumber)) {
            const unlockError = await attemptUnlock(objectUrl, lockHandle);
            const txt = existingCorrText ? ` ("${existingCorrText}")` : '';
            const lines = [
                `${resolved.type} '${objectName}' is already locked in change request ${existingCorrNr}${txt}.`,
                `Refusing to record the delete under ${transportNumber} — re-run with transport_number=${existingCorrNr}, or omit transport_number to use the existing one.`
            ];
            if (unlockError) lines.push(`Additionally, failed to release the lock taken for this check.\nReason: ${unlockError}\nLock handle: ${lockHandle}. Run UnlockObject('${objectName}') before retrying.`);
            return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const effectiveTransport = transportNumber || existingCorrNr;

        // ── Step 2: Delete ────────────────────────────────────────────
        // No return body on success — SAP throws on failure instead (verified live against a
        // function module). On failure the lock is still held, so unlock before reporting.
        try {
            const params: Record<string, string> = { lockHandle };
            if (effectiveTransport) params['corrNr'] = effectiveTransport;
            await makeAdtRequest(
                objectUrl, 'DELETE', 20000, undefined, params,
                { 'Accept': 'application/*', 'X-sap-adt-sessiontype': 'stateful' }
            );
        } catch (error) {
            const unlockError = await attemptUnlock(objectUrl, lockHandle);
            const unlockNote = unlockError
                ? `\nAdditionally, failed to release the lock.\nReason: ${unlockError}\nLock handle: ${lockHandle}. Run UnlockObject('${objectName}') before retrying.`
                : '';

            if (error instanceof AxiosError && error.response?.data) {
                const errMsg = parseAdtErrorXml(String(error.response.data));
                if (errMsg) {
                    const lines = [`Failed to delete ${resolved.type} '${objectName}'.`, `Reason: ${errMsg}`];
                    // The container object (e.g. R3TR FUGR for a function module) needs its own
                    // registration in the SAME transport as the delete — a different open
                    // transport already holding it blocks the delete even though the member's
                    // own LIMU entry is in the transport you passed. Verified live 2026-08-27.
                    const containerLockMatch = errMsg.match(/is already locked in request (\S+)/i);
                    if (containerLockMatch) {
                        lines.push(`The object's CTS container is locked under a different transport (${containerLockMatch[1]}). Options: retry with transport_number=${containerLockMatch[1]}, release that transport first (ManageTransport action=release, releasing its task before the request itself), or merge the two requests.`);
                    }
                    lines.push(unlockNote.trim());
                    return { isError: true, content: [{ type: 'text', text: lines.join('\n').trim() }] };
                }
            }
            const baseResult = return_error(error);
            if (unlockNote && baseResult?.content?.[0]?.type === 'text') {
                baseResult.content[0].text += unlockNote;
            }
            return baseResult;
        }
        // The object is gone, but its enqueue entry is not: an ADT DELETE does not release the
        // LOCK (SM12 kept a TRDIR entry for a program deleted this way, 2026-10-08), so the name
        // stayed "currently being edited" by our own user until the session timed out. Unlock
        // explicitly, like ManageMessageClass does.
        const unlockError = await attemptUnlock(objectUrl, lockHandle);

        const lines = [`Deleted ${resolved.type} '${objectName}'.`];
        if (unlockError) lines.push(`Note: releasing the lock afterwards failed (${unlockError}) — an SM12 entry may remain for '${objectName}' until the session times out.`);
        if (effectiveTransport) {
            lines.push(`Recorded in transport ${effectiveTransport}.`);
            lines.push(`The object may still appear in that transport's object list as the deletion record — this is normal CTS behavior, not a failed delete.`);
        }
        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    } finally {
        releaseStatefulOperationLock();
    }
}
