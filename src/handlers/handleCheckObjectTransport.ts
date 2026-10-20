import { McpError, ErrorCode, return_error, getBaseUrl } from '../lib/utils';
import { getConfig } from '../index';
import { resolveAnyObject } from '../lib/resolveObject';
import { fetchTransportCheck, verdictOf, CtsHeader } from '../lib/transportCheck';

// GetMeta resource=TRANSPORT with object_name — "which change request may this object be written
// into, and who holds it?" Read-only: ADT transportchecks, no lock (see lib/transportCheck.ts).

const line = (h: CtsHeader) => `${h.number}  ${h.owner}  "${h.text}"`;

export async function handleCheckObjectTransport(args: any) {
    try {
        const objectName = String(args?.object_name || '').toUpperCase();
        if (!objectName) throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        const baseUrl = String(await getBaseUrl());
        const me = getConfig().username.toUpperCase();

        const resolution = await resolveAnyObject(baseUrl, objectName, args?.type_hint ? String(args.type_hint).toUpperCase() : undefined);
        if ('error' in resolution) {
            return { isError: false, content: [{ type: 'text', text:
                `${resolution.error}\nIf '${objectName}' does not exist yet there is nothing to check: create it with WriteProgram + transport_description (+ package_name).` }] };
        }

        const check = await fetchTransportCheck(baseUrl, resolution.uri);
        const verdict = verdictOf(check, me);
        const out: string[] = [`${resolution.type} ${objectName} (${check.pgmid} ${check.objectType}, package ${check.devclass || '?'}) — ${verdict}`];

        if (verdict === 'LOCAL') {
            out.push('Not recorded in CTS (local package): no transport_number needed.');
        } else if (verdict === 'FREE') {
            out.push('In no open change request. Write with transport_number of one of YOUR open requests below, or transport_description to create one.');
            if (check.candidates.length) out.push('Your open requests:', ...check.candidates.slice(0, 10).map(c => `  ${line(c)}`),
                ...(check.candidates.length > 10 ? [`  … ${check.candidates.length - 10} more`] : []));
        } else {
            for (const h of check.holders) {
                out.push(`Held in request ${line(h.request)}`);
                for (const t of h.tasks) out.push(`  task ${line(t)}`);
            }
            out.push(`SAP only accepts ${check.existingRequestOnly ? 'this existing request' : 'a request of the holder'} for this object; WriteProgram/DeleteObject/ActivateObjects accept the request or its task and refuse any other.`);
            if (verdict === 'HELD_BY_OTHER') {
                out.push(`WARNING: held by another user (not ${me}). Writing records your change in THEIR request — confirm with the owner first; a different transport_number is refused, never reassigned.`);
            }
        }
        if (check.messages.length) out.push('Messages:', ...check.messages.map(m => `  ${m}`));
        return { isError: false, content: [{ type: 'text', text: out.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}
