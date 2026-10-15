import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { AxiosError } from 'axios';
import { getConfig } from '../index';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

// Creates / updates an ABAP package (DEVC/K) over the native ADT contract
// (application/vnd.sap.adt.packages.v2+xml). Delete stays with DeleteObject (generic resolver).
//   create  POST /sap/bc/adt/packages[?corrNr=]        stateless, outside the stateful gate
//   update  LOCK -> GET current -> patch named fields -> PUT ?lockHandle[&corrNr] -> UNLOCK (gated)
const PACKAGE_CT = 'application/vnd.sap.adt.packages.v2+xml';
const PACKAGE_ACCEPT = 'application/vnd.sap.adt.packages.v2+xml, application/vnd.sap.adt.packages.v1+xml';
const PACKAGE_TYPES = ['development', 'structure', 'main'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v: any) => (v === undefined || v === null ? '' : String(v).trim());

function validateName(name: string) {
    if (!name) throw new McpError(ErrorCode.InvalidParams, 'package_name is required');
    if (name.length > 30) throw new McpError(ErrorCode.InvalidParams, `package_name is ${name.length} characters; the maximum is 30`);
    if (!/^(\$|Z|Y|\/)/i.test(name)) throw new McpError(ErrorCode.InvalidParams, 'package_name must be a customer name (Z*, Y*, $*, or a /NAMESPACE/ name)');
}

function validateDescription(d: string) {
    if (d.length > 60) throw new McpError(ErrorCode.InvalidParams, `description is ${d.length} characters; the maximum is 60`);
}

function buildCreateXml(a: Record<string, string>, name: string, description: string): string {
    const lang = a.master_language || 'EN';
    const attr = (k: string, v: string) => (v ? ` ${k}="${esc(v)}"` : '');
    return `<?xml version="1.0" encoding="UTF-8"?>
<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:description="${esc(description)}" adtcore:language="${esc(lang)}" adtcore:name="${esc(name)}" adtcore:type="DEVC/K" adtcore:version="active" adtcore:masterLanguage="${esc(lang)}"${attr('adtcore:responsible', a.responsible)}>
  <adtcore:packageRef adtcore:name="${esc(name)}"/>
  <pak:attributes pak:isEncapsulated="false" pak:packageType="${esc(a.package_type || 'development')}" pak:recordChanges="${a.record_changes === 'true' ? 'true' : 'false'}"/>
  ${a.super_package ? `<pak:superPackage adtcore:name="${esc(a.super_package)}"/>` : '<pak:superPackage/>'}
  ${a.application_component ? `<pak:applicationComponent pak:name="${esc(a.application_component)}"/>` : '<pak:applicationComponent/>'}
  <pak:transport>
    <pak:softwareComponent pak:name="${esc(a.software_component)}"/>
    ${a.transport_layer ? `<pak:transportLayer pak:name="${esc(a.transport_layer)}"/>` : '<pak:transportLayer/>'}
  </pak:transport>
  <pak:translation/>
  <pak:useAccesses/>
  <pak:packageInterfaces/>
  <pak:subPackages/>
</pak:package>`;
}

// Replaces the value of one attribute on the first element whose tag matches; returns null when absent.
function setAttr(xml: string, tag: string, attrName: string, value: string): string | null {
    const re = new RegExp(`(<${tag}\\b[^>]*?\\s${attrName}=")[^"]*(")`);
    return re.test(xml) ? xml.replace(re, (_m, p1, p2) => `${p1}${esc(value)}${p2}`) : null;
}

// Fills `<tag/>` (empty) or `<tag ... name="old"/>` with name="value".
function setRef(xml: string, tag: string, nameAttr: string, value: string): string | null {
    const filled = setAttr(xml, tag, nameAttr, value);
    if (filled) return filled;
    const empty = new RegExp(`<${tag}\\s*/>`);
    return empty.test(xml) ? xml.replace(empty, `<${tag} ${nameAttr}="${esc(value)}"/>`) : null;
}

async function attemptUnlock(url: string, lockHandle: string): Promise<string | null> {
    try {
        await makeAdtRequest(url, 'POST', 15000, '', { _action: 'UNLOCK', lockHandle }, { 'Accept': 'application/*' });
        return null;
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) return parseAdtErrorXml(String(error.response.data)) || error.message;
        return error instanceof Error ? error.message : String(error);
    } finally {
        removeCookie('sap-contextid');
    }
}

function sapFailure(prefix: string, error: unknown) {
    if (error instanceof AxiosError && error.response?.data) {
        const msg = parseAdtErrorXml(String(error.response.data));
        if (msg) return { isError: true, content: [{ type: 'text', text: `${prefix}\nReason: ${msg}` }] };
    }
    return return_error(error);
}

async function createPackage(args: any) {
    const name = str(args.package_name).toUpperCase();
    validateName(name);
    const description = str(args.description) || name;
    validateDescription(description);
    const type = str(args.package_type).toLowerCase() || 'development';
    if (!PACKAGE_TYPES.includes(type)) throw new McpError(ErrorCode.InvalidParams, `package_type must be one of ${PACKAGE_TYPES.join(', ')}`);
    const local = name.startsWith('$');
    const softwareComponent = str(args.software_component).toUpperCase() || (local ? 'LOCAL' : '');
    if (!softwareComponent) throw new McpError(ErrorCode.InvalidParams, 'software_component is required for a transportable package (e.g. HOME, ZLOCAL); a $ package defaults to LOCAL');
    const transport = str(args.transport_number).toUpperCase();
    if (!local && !transport) throw new McpError(ErrorCode.InvalidParams, 'transport_number is required for a transportable (non-$) package; create one with ManageTransport first');

    const xml = buildCreateXml({
        master_language: str(args.master_language).toUpperCase(),
        responsible: str(args.responsible).toUpperCase() || getConfig().username.toUpperCase(),
        package_type: type,
        record_changes: args.record_changes ? 'true' : 'false',
        super_package: str(args.super_package).toUpperCase(),
        application_component: str(args.application_component).toUpperCase(),
        software_component: softwareComponent,
        transport_layer: str(args.transport_layer).toUpperCase(),
    }, name, description);

    const baseUrl = String(await getBaseUrl());
    try {
        await makeAdtRequest(`${baseUrl}/sap/bc/adt/packages`, 'POST', 30000, xml,
            transport ? { corrNr: transport } : undefined,
            { 'Accept': PACKAGE_ACCEPT, 'Content-Type': PACKAGE_CT });
    } catch (error) {
        return sapFailure(`Failed to create package '${name}'.`, error);
    }
    const lines = [`Created package '${name}' ("${description}").`];
    if (transport) lines.push(`Recorded in transport ${transport}.`);
    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

async function updatePackage(args: any) {
    const name = str(args.package_name).toUpperCase();
    validateName(name);
    const description = args.description !== undefined ? str(args.description) : undefined;
    if (description !== undefined) validateDescription(description);
    const edits: Array<{ label: string; apply: (x: string) => string | null }> = [];
    if (description) edits.push({ label: 'description', apply: x => setAttr(x, 'pak:package', 'adtcore:description', description) });
    const sw = str(args.software_component).toUpperCase();
    if (sw) edits.push({ label: 'software_component', apply: x => setRef(x, 'pak:softwareComponent', 'pak:name', sw) });
    const layer = str(args.transport_layer).toUpperCase();
    if (layer) edits.push({ label: 'transport_layer', apply: x => setRef(x, 'pak:transportLayer', 'pak:name', layer) });
    const appc = str(args.application_component).toUpperCase();
    if (appc) edits.push({ label: 'application_component', apply: x => setRef(x, 'pak:applicationComponent', 'pak:name', appc) });
    const sup = str(args.super_package).toUpperCase();
    if (sup) edits.push({ label: 'super_package', apply: x => setRef(x, 'pak:superPackage', 'adtcore:name', sup) });
    if (edits.length === 0) throw new McpError(ErrorCode.InvalidParams, 'nothing to update: pass description, software_component, transport_layer, application_component and/or super_package');
    const transport = str(args.transport_number).toUpperCase();

    const baseUrl = String(await getBaseUrl());
    const url = `${baseUrl}/sap/bc/adt/packages/${encodeURIComponent(name.toLowerCase())}`;

    removeCookie('sap-contextid');
    let lockHandle = '';
    let existingCorr = '';
    try {
        const lockResponse = await makeAdtRequest(url, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
            'Accept': 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
            'X-sap-adt-sessiontype': 'stateful',
        });
        const ctx = ((lockResponse.headers?.['set-cookie'] as string[] | undefined) || []).join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctx) {
            appendCookie(ctx[1]);
            refreshStatefulOperationToken(ctx[1]);
        }
        const lockXml = String(lockResponse.data || '');
        lockHandle = lockXml.match(/<LOCK_HANDLE>([^<]*)</)?.[1] || '';
        existingCorr = lockXml.match(/<CORRNR>([^<]*)</)?.[1] || '';
        if (!lockHandle) throw new Error('Lock handle not found in response');
    } catch (error) {
        removeCookie('sap-contextid');
        return sapFailure(`Failed to lock package '${name}' for update. If it is your own leftover session, try UnlockObject.`, error);
    }

    try {
        // Never let SAP silently move the package into a different request.
        if (transport && existingCorr && existingCorr !== transport) {
            return { isError: true, content: [{ type: 'text', text: `Package '${name}' is already locked in change request ${existingCorr}. Re-run with transport_number=${existingCorr} or omit it. Nothing was written.` }] };
        }
        const corr = transport || existingCorr;

        let current: string;
        try {
            const r = await makeAdtRequest(url, 'GET', 15000, undefined, undefined, { 'Accept': PACKAGE_ACCEPT, 'X-sap-adt-sessiontype': 'stateful' });
            current = String(r.data || '');
        } catch (error) {
            return sapFailure(`Failed to read package '${name}'.`, error);
        }
        if (!current.includes('<pak:package')) {
            return { isError: true, content: [{ type: 'text', text: `Unexpected response reading package '${name}'; nothing written.` }] };
        }

        let next = current;
        for (const e of edits) {
            const out = e.apply(next);
            if (out === null) {
                return { isError: true, content: [{ type: 'text', text: `Could not apply '${e.label}': the package document has no matching element. Nothing was written.` }] };
            }
            next = out;
        }
        if (next === current) {
            return { isError: false, content: [{ type: 'text', text: `Package '${name}' already has the requested values; nothing written.` }] };
        }

        try {
            const params: Record<string, string> = { lockHandle };
            if (corr) params.corrNr = corr;
            await makeAdtRequest(url, 'PUT', 30000, next, params, {
                'Content-Type': PACKAGE_CT, 'Accept': PACKAGE_ACCEPT, 'X-sap-adt-sessiontype': 'stateful',
            });
        } catch (error) {
            return sapFailure(`Failed to update package '${name}'.`, error);
        }
        const lines = [`Updated package '${name}': ${edits.map(e => e.label).join(', ')}.`];
        if (corr) lines.push(`Recorded in transport ${corr}.`);
        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } finally {
        const err = await attemptUnlock(url, lockHandle);
        if (err) console.error(`ManagePackage: unlock of ${name} failed: ${err}`);
    }
}

export async function handleManagePackage(args: any) {
    const action = str(args?.action).toLowerCase();
    if (action !== 'create' && action !== 'update') {
        return return_error(new McpError(ErrorCode.InvalidParams, 'action must be "create" or "update" (use DeleteObject to delete a package)'));
    }
    if (action === 'create') {
        try { return await createPackage(args); } catch (error) { return return_error(error); }
    }
    const gate = acquireStatefulOperationLock(`ManagePackage(${str(args?.package_name).toUpperCase() || 'unknown'})`);
    if (!gate.ok) return { isError: true, content: [{ type: 'text', text: gate.message }] };
    try {
        return await updatePackage(args);
    } catch (error) {
        return return_error(error);
    } finally {
        releaseStatefulOperationLock();
    }
}
