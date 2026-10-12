import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { getConfig } from '../index';
import { AxiosError } from 'axios';
import { resolveAnyObject } from '../lib/resolveObject';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

export async function handleUnlockObject(args: any) {
    const objectName = args?.object_name ? String(args.object_name).toUpperCase() : '';
    const gate = acquireStatefulOperationLock(`UnlockObject(${objectName || 'unknown'})`);
    if (!gate.ok) return { isError: true, content: [{ type: 'text', text: gate.message }] };
    try {
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

        // ── Attempt LOCK. This is the only way to observe current lock state — ADT has no
        // separate read-only "who holds this lock" endpoint. Success means the object was
        // free (or SAP granted a fresh lock, e.g. the prior holder's session already timed
        // out) — we immediately release it below. Failure means it is genuinely still held,
        // and we take no further action: never force/override another session's lock. ──
        let lockHandle: string;
        let corrNr = '';
        let corrText = '';
        // Purge any sap-contextid left over from an earlier call that never reached its own
        // removeCookie (e.g. process killed mid-flight) — otherwise this LOCK POST rides that
        // stale session and self-conflicts with "User X is currently editing", even though the
        // object is actually free. A brand-new stateful session should never inherit an old one.
        removeCookie('sap-contextid');
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
            corrNr = lockData?.['CORRNR']?._text || '';
            corrText = lockData?.['CORRTEXT']?._text || '';
            if (!lockHandle) throw new Error('Lock handle not found in response');
        } catch (error) {
            // Could not acquire the lock — object is genuinely held by an active session.
            // Report who, and stop. No force-unlock, no override.
            let reason = '';
            if (error instanceof AxiosError && error.response?.data) {
                reason = parseAdtErrorXml(String(error.response.data)) || '';
            }
            if (!reason) reason = error instanceof Error ? error.message : String(error);

            const editingUserMatch = reason.match(/User\s+([^\s]+)\s+is currently editing/i);
            const editingUser = editingUserMatch ? editingUserMatch[1] : '';
            const configuredUser = getConfig().username?.toUpperCase() || '';

            const lines = [`Could not clear the lock on '${objectName}' (${resolved.type}).`, `Reason: ${reason}`];
            if (editingUser && editingUser.toUpperCase() === configuredUser) {
                lines.push(`This is your own configured SAP user (${configuredUser}) — likely an open SAP GUI (SE38/SE80) edit session or an ADT/Eclipse session still active under this account, not a dead lock. Close that session (or wait for it to time out) rather than retrying here.`);
            } else if (editingUser) {
                lines.push(`This is a different user (${editingUser}) — do not force-unlock without checking with them. Coordinate directly, or ask SAP Basis to release it (SM12) if it is confirmed stale.`);
            }
            lines.push('No lock was changed by this call.');
            return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Lock acquired — immediately release it. Net effect: any stray/reclaimable lock is
        // now cleared; a genuinely free object is left exactly as it was.
        try {
            await makeAdtRequest(String(objectUrl), 'POST', 15000, '',
                { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
                { 'X-sap-adt-sessiontype': 'stateless' });
        } catch (error) {
            removeCookie('sap-contextid');
            let reason = '';
            if (error instanceof AxiosError && error.response?.data) {
                reason = parseAdtErrorXml(String(error.response.data)) || '';
            }
            if (!reason) reason = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: 'text', text:
                    `Acquired the lock on '${objectName}' but failed to release it.\nReason: ${reason}\nLock handle: ${lockHandle}\nThe object may now be locked under this handle — retry UnlockObject, or escalate to SAP Basis (SM12) if it persists.` }]
            };
        }
        removeCookie('sap-contextid');

        const lines = [`Lock on '${objectName}' (${resolved.type}) is now clear.`];
        if (corrNr) lines.push(`(It was registered in transport ${corrNr}${corrText ? ` — "${corrText}"` : ''}; the transport registration itself is unaffected by this call.)`);
        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    } finally {
        releaseStatefulOperationLock();
    }
}
