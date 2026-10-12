import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { AxiosError } from 'axios';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

interface ResolvedRef {
    name: string;
    uri: string;
    type: string;
}

interface PropertyChangeResult {
    name: string;
    uri?: string;
    type?: string;
    oldType?: string;
    newType?: string;
    changed: boolean;
    error?: string;
}

export async function handleActivateObjects(args: any) {
    const rfcMap = args?.rfc_enabled;
    if (rfcMap && typeof rfcMap === 'object' && !Array.isArray(rfcMap) && Object.keys(rfcMap).length > 0) {
        const gate = acquireStatefulOperationLock('ActivateObjects(rfc_enabled)');
        if (!gate.ok) return { isError: true, content: [{ type: 'text', text: gate.message }] };
        try {
            return await activateObjectsCore(args);
        } finally {
            releaseStatefulOperationLock();
        }
    }
    return activateObjectsCore(args);
}

async function activateObjectsCore(args: any) {
    try {
        const names: string[] = Array.isArray(args?.names) ? args.names.map((n: any) => String(n).toUpperCase()) : [];
        const rfcMapRaw: Record<string, boolean> = (args?.rfc_enabled && typeof args.rfc_enabled === 'object' && !Array.isArray(args.rfc_enabled))
            ? args.rfc_enabled : {};
        const rfcMap: Record<string, boolean> = {};
        for (const k of Object.keys(rfcMapRaw)) rfcMap[k.toUpperCase()] = !!rfcMapRaw[k];
        const rfcNames = Object.keys(rfcMap);
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : '';

        if (names.length === 0 && rfcNames.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'names or rfc_enabled is required');
        }
        const baseUrl = String(await getBaseUrl());

        // ── Step A: apply rfc_enabled property changes first (each is its own lock/PUT/unlock
        // cycle on the function module's object metadata — separate from the source lock).
        // Run sequentially: each cycle uses a stateful session tied to a single shared
        // sap-contextid cookie (appendCookie/removeCookie), so concurrent cycles would race
        // on that cookie and corrupt each other's session. ──
        const propertyResults: PropertyChangeResult[] = [];
        for (const name of rfcNames) {
            propertyResults.push(await setProcessingType(baseUrl, name, rfcMap[name], transportNumber));
        }

        // ── Resolve all activation targets: names ∪ rfc_enabled keys ─────
        const allNames = Array.from(new Set([...names, ...rfcNames]));
        const propByName = new Map(propertyResults.map(r => [r.name, r]));

        const resolved = await Promise.all(allNames.map(async (name) => {
            const propResult = propByName.get(name);
            if (propResult?.uri && propResult?.type) {
                return { name, uri: propResult.uri, type: propResult.type };
            }
            const info = await resolveUri(baseUrl, name);
            return info ? { ...info, name } : null;
        }));

        const refs: ResolvedRef[] = [];
        const missing: string[] = [];
        for (let i = 0; i < allNames.length; i++) {
            if (resolved[i]) refs.push(resolved[i] as ResolvedRef);
            else missing.push(allNames[i]);
        }

        const propertyErrors = propertyResults.filter(r => r.error);
        const propertyLines: string[] = [];
        if (propertyResults.length > 0) {
            propertyLines.push('Property changes:');
            for (const r of propertyResults) {
                if (r.error) propertyLines.push(`  ${r.name}: FAILED — ${r.error}`);
                else if (r.changed) propertyLines.push(`  ${r.name}: ${r.oldType} → ${r.newType}`);
                else propertyLines.push(`  ${r.name}: already ${r.newType} — no change`);
            }
        }

        if (refs.length === 0) {
            const lines = [...propertyLines, `None of the ${allNames.length} object(s) could be resolved: ${missing.join(', ')}`];
            return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Build multi-reference activation body.
        // For executable programs, also reference the text-elements object (PROG/PX) —
        // it is a separate inactive-able object, and a WriteProgram(activate=false) that
        // wrote text symbols/selections/headings leaves it inactive. SAP tolerates the
        // extra reference when the program has no text pool (verified live).
        const refsXml = refs.map(r => {
            let xml = `<adtcore:objectReference adtcore:uri="${escapeXml(r.uri)}" adtcore:name="${escapeXml(r.name)}"/>`;
            if (r.type === 'PROG/P') {
                const textElUri = `/sap/bc/adt/textelements/programs/${encodeURIComponent(r.name.toLowerCase())}`;
                xml += `<adtcore:objectReference adtcore:uri="${escapeXml(textElUri)}" adtcore:name="${escapeXml(r.name)}"/>`;
            }
            return xml;
        }).join('');
        const body =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refsXml}</adtcore:objectReferences>`;

        let actData: string;
        try {
            const response = await makeAdtRequest(
                `${baseUrl}/sap/bc/adt/activation`, 'POST', 60000, body,
                { method: 'activate', preauditRequested: true },
                { 'Content-Type': 'application/xml', 'Accept': 'application/xml' }
            );
            actData = typeof response.data === 'string' ? response.data : String(response.data || '');
        } catch (error) {
            const status = error instanceof AxiosError ? error.response?.status : undefined;
            const rawBody = error instanceof AxiosError ? String(error.response?.data ?? '') : '';
            const parsedMsg = rawBody ? parseAdtErrorXml(rawBody) : '';
            const lines: string[] = [...propertyLines];
            if (propertyLines.length) lines.push('');
            lines.push(`Mass activation request failed${status ? ` (HTTP ${status})` : ''}.`);
            lines.push(`Submitted ${refs.length} object(s):`);
            for (const r of refs) lines.push(`  ${r.name} (${r.type})  uri=${r.uri}`);
            if (parsedMsg) {
                lines.push('');
                lines.push(`Reason: ${parsedMsg}`);
            } else if (rawBody) {
                lines.push('');
                lines.push('Raw response:');
                lines.push(rawBody.slice(0, 2000));
            } else if (error instanceof Error) {
                lines.push('');
                lines.push(`Error: ${error.message}`);
            }
            return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
        }
        const messages = parseActivationMessages(actData);
        const errors = messages.filter(m => m.startsWith('[E]'));
        const warnings = messages.filter(m => m.startsWith('[W]'));
        const activationSkipped = actData.includes('activationExecuted="false"');
        const generated = actData.includes('generationExecuted="true"');

        const lines: string[] = [...propertyLines];
        if (propertyLines.length) lines.push('');
        const summaryPrefix = errors.length > 0 || propertyErrors.length > 0 ? 'FAILED'
            : activationSkipped && !generated ? 'NO-OP'
            : activationSkipped && generated ? 'OK (nothing to activate, generation refreshed)'
            : 'OK';
        lines.push(`Mass activation [${summaryPrefix}]: ${refs.length} object(s)${missing.length ? `, ${missing.length} missing (${missing.join(', ')})` : ''}.`);
        for (const r of refs) lines.push(`  ${r.name} (${r.type}${r.type === 'PROG/P' ? ' +text pool' : ''})`);
        if (errors.length || warnings.length) {
            lines.push('');
            if (errors.length)   { lines.push('Errors:');   lines.push(...errors.map(m => '  ' + m)); }
            if (warnings.length) { lines.push('Warnings:'); lines.push(...warnings.map(m => '  ' + m)); }
        }
        return { isError: errors.length > 0 || propertyErrors.length > 0, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}

// Sets a function module's fmodule:processingType attribute (the SE37 "Remote-Enabled
// Module" checkbox) via lock → PUT metadata → unlock on the FM's own object URL — a
// separate lockable resource from its /source/main. Verified live: normal ↔ rfc only.
async function setProcessingType(
    baseUrl: string, functionName: string, rfcEnabled: boolean, transportNumber: string
): Promise<PropertyChangeResult> {
    let resolved: { uri: string; group: string } | null;
    try {
        resolved = await resolveFunctionModule(baseUrl, functionName);
    } catch (error) {
        return { name: functionName, changed: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!resolved) {
        return { name: functionName, changed: false, error: `function module not found (search returned no exact match)` };
    }
    const objectUrl = `${baseUrl}${resolved.uri}`;

    let currentDescription = '';
    let currentProcessingType = '';
    try {
        const metaResponse = await makeAdtRequest(objectUrl, 'GET', 15000);
        const metaXml = typeof metaResponse.data === 'string' ? metaResponse.data : String(metaResponse.data ?? '');
        const descMatch = metaXml.match(/adtcore:description="([^"]*)"/);
        const typeMatch = metaXml.match(/fmodule:processingType="([^"]*)"/);
        currentDescription = descMatch ? descMatch[1] : '';
        currentProcessingType = typeMatch ? typeMatch[1] : '';
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false, error: errMsg };
        }
        return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false, error: error instanceof Error ? error.message : String(error) };
    }

    const targetProcessingType = rfcEnabled ? 'rfc' : 'normal';
    if (currentProcessingType === targetProcessingType) {
        return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', oldType: currentProcessingType, newType: targetProcessingType, changed: false };
    }

    // Lock (stateful)
    let lockHandle: string;
    let existingCorrNr = '';
    let existingCorrText = '';
    // Purge any sap-contextid left over from an earlier call that never reached its own
    // removeCookie (e.g. process killed mid-flight) — otherwise this LOCK POST rides that
    // stale session and self-conflicts with "User X is currently editing" on a free object.
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
            if (errMsg) return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false, error: `lock failed: ${errMsg}` };
        }
        return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false, error: `lock failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    // Guard: never silently reassign the object to a different transport
    if (transportNumber && existingCorrNr && existingCorrNr !== transportNumber) {
        try {
            await makeAdtRequest(objectUrl, 'POST', 15000, '',
                { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
                { 'X-sap-adt-sessiontype': 'stateless' });
        } catch (_) { /* ignore */ }
        removeCookie('sap-contextid');
        const txt = existingCorrText ? ` ("${existingCorrText}")` : '';
        return {
            name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false,
            error: `already locked in change request ${existingCorrNr}${txt} — refusing to reassign to ${transportNumber}. Re-run with transport_number=${existingCorrNr}, or omit it.`
        };
    }

    // PUT updated metadata (processingType)
    try {
        const putParams: Record<string, string> = { lockHandle };
        if (transportNumber) putParams['corrNr'] = transportNumber;

        const putBody =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<fmodule:abapFunctionModule xmlns:fmodule="http://www.sap.com/adt/functions/fmodules"` +
            ` xmlns:adtcore="http://www.sap.com/adt/core"` +
            ` fmodule:processingType="${targetProcessingType}"` +
            ` adtcore:description="${escapeXml(currentDescription)}"` +
            ` adtcore:name="${functionName}" adtcore:type="FUGR/FF">` +
            `<adtcore:containerRef adtcore:uri="/sap/bc/adt/functions/groups/${resolved.group.toLowerCase()}" adtcore:type="FUGR/F" adtcore:name="${resolved.group}"/>` +
            `</fmodule:abapFunctionModule>`;

        await makeAdtRequest(
            objectUrl, 'PUT', 30000, putBody,
            putParams,
            { 'Content-Type': 'application/vnd.sap.adt.functions.fmodules.v3+xml', 'X-sap-adt-sessiontype': 'stateful' }
        );
    } catch (error) {
        try {
            await makeAdtRequest(objectUrl, 'POST', 15000, '',
                { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
                { 'X-sap-adt-sessiontype': 'stateless' });
        } catch (_) { /* ignore */ }
        removeCookie('sap-contextid');

        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false, error: errMsg };
        }
        return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', changed: false, error: error instanceof Error ? error.message : String(error) };
    }

    // Unlock
    try {
        await makeAdtRequest(objectUrl, 'POST', 15000, '',
            { _action: 'UNLOCK', lockHandle: encodeURIComponent(lockHandle) },
            { 'X-sap-adt-sessiontype': 'stateless' });
    } catch (_) { /* non-fatal */ }
    removeCookie('sap-contextid');

    return { name: functionName, uri: resolved.uri, type: 'FUGR/FF', oldType: currentProcessingType, newType: targetProcessingType, changed: true };
}

// Resolves a function module name to its exact URI/group via quickSearch (objectType=FUGR/FF).
async function resolveFunctionModule(
    baseUrl: string, functionName: string
): Promise<{ uri: string; group: string } | null> {
    const url = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(functionName)}&maxResults=5&objectType=${encodeURIComponent('FUGR/FF')}`;
    const response = await makeAdtRequest(url, 'GET', 15000);
    const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    const convert = require('xml-js');
    const parsed = convert.xml2js(xml, { compact: true }) as any;
    const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
    if (!rootKey) return null;
    const root = parsed[rootKey];
    const refKey = Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
    if (!refKey) return null;
    const raw = root[refKey];
    const refs = Array.isArray(raw) ? raw : [raw];

    for (const ref of refs) {
        const attrs = ref._attributes || {};
        const nameKey = Object.keys(attrs).find((k: string) => k === 'name' || k.endsWith(':name'));
        const name = nameKey ? String(attrs[nameKey] || '') : '';
        if (name.toUpperCase() !== functionName.toUpperCase()) continue;
        const uriKey = Object.keys(attrs).find((k: string) => k === 'uri' || k.endsWith(':uri'));
        const uri = uriKey ? String(attrs[uriKey] || '') : '';
        const match = uri.match(/\/functions\/groups\/([^/]+)\/fmodules\//i);
        if (uri && match) return { uri, group: match[1].toUpperCase() };
    }
    return null;
}

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function resolveUri(baseUrl: string, name: string): Promise<{ uri: string; type: string } | null> {
    try {
        const searchUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(name)}&maxResults=20`;
        const response = await makeAdtRequest(searchUrl, 'GET', 15000);
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (rootKey) {
            const root = parsed[rootKey];
            const refKey = Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
            if (refKey) {
                const raw = root[refKey];
                const refs = Array.isArray(raw) ? raw : [raw];
                for (const ref of refs) {
                    const attrs = ref._attributes || {};
                    const get = (ln: string): string => {
                        const k = Object.keys(attrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                        return k ? String(attrs[k] || '') : '';
                    };
                    if (get('name').toUpperCase() === name) {
                        return { uri: get('uri'), type: get('type').toUpperCase() };
                    }
                }
            }
        }
    } catch { /* swallow — fall through to the inactive-objects fallback below */ }

    // quickSearch's repository index can lag behind a just-created object (same class of
    // bug fixed in WriteProgram's own post-create resolution, 2026-09-10, commit 11c2e16) —
    // this bites exactly the multi-object create-then-activate workflow this gateway itself
    // recommends (WriteProgram(activate=false) xN -> one ActivateObjects call). SAP's
    // inactiveobjects listing reflects a fresh, still-inactive object immediately, so try it
    // as a second-chance lookup before giving up.
    return resolveViaInactiveObjects(baseUrl, name);
}

async function resolveViaInactiveObjects(baseUrl: string, name: string): Promise<{ uri: string; type: string } | null> {
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/activation/inactiveobjects`, 'GET', 15000);
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        if (!rootKey) return null;
        const root = parsed[rootKey];
        const entryKey = Object.keys(root).find((k: string) => k.endsWith(':entry') || k === 'entry');
        if (!entryKey) return null;
        const entries = Array.isArray(root[entryKey]) ? root[entryKey] : [root[entryKey]];
        for (const entry of entries) {
            const objKey = Object.keys(entry).find((k: string) => k.endsWith(':object') || k === 'object');
            if (!objKey) continue;
            const refKey = Object.keys(entry[objKey]).find((k: string) => k.endsWith(':ref') || k === 'ref');
            if (!refKey) continue;
            const attrs = entry[objKey][refKey]._attributes || {};
            const get = (ln: string): string => {
                const k = Object.keys(attrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                return k ? String(attrs[k] || '') : '';
            };
            if (get('name').toUpperCase() === name) {
                return { uri: get('uri'), type: get('type').toUpperCase() };
            }
        }
    } catch { /* swallow */ }
    return null;
}

function parseActivationMessages(xml: string): string[] {
    try {
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: false }) as any;
        const messages: string[] = [];
        function walk(node: any) {
            if (!node) return;
            if (node.name === 'msg' && node.attributes) {
                const t = node.attributes['type'] || '';
                const line = node.attributes['line'] || '';
                const obj = node.attributes['objDescr'] || '';
                const shortText = node.elements?.find((e: any) => e.name === 'shortText');
                const txts: string[] = [];
                if (shortText?.elements) {
                    for (const e of shortText.elements) {
                        if (e.name === 'txt' && e.elements?.[0]?.text) txts.push(e.elements[0].text);
                    }
                }
                if (txts.length) {
                    let m = `[${t}]`;
                    if (obj) m += ` ${obj}`;
                    if (line && line !== '0') m += ` line ${line}`;
                    m += `: ${txts.join(' — ')}`;
                    messages.push(m);
                }
            }
            if (node.elements) for (const c of node.elements) walk(c);
        }
        walk(parsed);
        return messages;
    } catch {
        return [];
    }
}
