import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { maybeBackground } from '../lib/background';

interface ObjectInfo {
    uri: string;
    type: string;
    name: string;
    typeLabel: string;
}

interface IncludeRef {
    name: string;
    type: string;
    uri: string;
}

interface EnhancementEntry {
    name: string;          // ENHO implementation name (e.g. Z_CO08_ZP02_01)
    enhoType: string;      // e.g. ENHO/XHH
    pluginKind: string;    // e.g. sourceCodePlugin, classPlugin
    fullName: string;      // ABAP path expression \PR:SAPLCOKO1\EX:LCOKO1I17_01\EI
    mode: string;          // dynamic / static
    replacing: string;     // true / false
    enhancedName: string;  // host object (e.g. COKO1)
    enhancedType: string;  // FUGR/F
    position: string;      // line info from enh:position uri
    source: string;        // decoded ABAP source
}

export async function handleGetEnhancements(args: any) {
    const name = args?.object_name ? String(args.object_name).toUpperCase() : 'object';
    const slug = `enhancements-${name}`;
    return maybeBackground(args, `Enhancement scan for ${name}`, slug, () => getEnhancementsCore(args));
}

async function getEnhancementsCore(args: any) {
    try {
        if (!args?.object_name) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }

        const objectName = String(args.object_name).toUpperCase();
        const withSource = args?.with_source !== false; // default true
        const scanAll = args?.scan_all === true; // opt-in for function group expansion
        const maxIncludes = Math.max(1, Number(args?.max_includes) || 100); // cap scan_all fan-out (default 100)
        const baseUrl = String(await getBaseUrl());

        const objInfo = await resolveObjectInfo(baseUrl, objectName);
        if (!objInfo) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Object '${objectName}' not found in SAP system.` }]
            };
        }

        // ── Case A: ENHO/* — enhancement implementation itself ──
        if (objInfo.type.startsWith('ENHO')) {
            return await handleEnhoObject(baseUrl, objInfo);
        }

        // ── Case B: Function group (FUGR/F) or its main include (FUGR/I named SAPLxxx) ──
        const groupName = detectFunctionGroup(objInfo);
        if (groupName) {
            if (!scanAll) {
                return await handleFunctionGroupList(baseUrl, groupName, objInfo);
            }
            return await handleFunctionGroup(baseUrl, groupName, objInfo, withSource, maxIncludes);
        }

        // ── Case C: Single source-bearing object ──
        return await handleSingleObject(baseUrl, objInfo, withSource);
    } catch (error) {
        return return_error(error);
    }
}

async function handleFunctionGroupList(baseUrl: string, groupName: string, objInfo: ObjectInfo): Promise<any> {
    // Fast, lightweight: list includes via SearchObject pattern (L{group}*)
    const searchUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent('L' + groupName + '*')}&maxResults=300`;
    let includes: { name: string; type: string }[] = [];
    try {
        const response = await makeAdtRequest(searchUrl, 'GET', 15000);
        const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;
        const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
        const root = rootKey ? parsed[rootKey] : null;
        const refKey = root ? Object.keys(root).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference') : null;
        if (refKey) {
            const raw = root[refKey];
            const refs = Array.isArray(raw) ? raw : [raw];
            for (const ref of refs) {
                const attrs = ref._attributes || {};
                const getAttr = (ln: string): string => {
                    const k = Object.keys(attrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                    return k ? String(attrs[k] || '') : '';
                };
                const name = getAttr('name');
                const type = getAttr('type');
                if (name && type.startsWith('FUGR/')) includes.push({ name, type });
            }
        }
    } catch {
        // Fall through to empty list
    }

    const lines: string[] = [];
    lines.push(`Function group ${groupName}: ${includes.length}${includes.length >= 300 ? '+' : ''} include(s). Retry with scan_all=true to aggregate (slow), or call GetEnhancements on an include:`);
    for (const inc of includes.slice(0, 30)) {
        lines.push(`  ${inc.name}`);
    }
    if (includes.length > 30) {
        lines.push(`  … and ${includes.length - 30} more (use SearchObject query=L${groupName}* to see all).`);
    }
    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─────────────────────────────────────────────────────────────────────
// Case A: ENHO/* — fetch source + try to find host object
// ─────────────────────────────────────────────────────────────────────
async function handleEnhoObject(baseUrl: string, objInfo: ObjectInfo): Promise<any> {
    const sourceUrl = `${baseUrl}${objInfo.uri}/source/main`;
    const metaUrl = `${baseUrl}${objInfo.uri}`;

    let src = '';
    try {
        const r = await makeAdtRequest(sourceUrl, 'GET', 30000);
        src = typeof r.data === 'string' ? r.data : String(r.data ?? '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Enhancement source read failed for '${objInfo.name}'.\nReason: ${errMsg}` }]
                };
            }
        }
        return return_error(error);
    }

    // Try to find host object reference in the ENHO metadata
    const hostInfo = await fetchEnhoHost(baseUrl, metaUrl);

    const lines: string[] = [];
    lines.push(`ENHO ${objInfo.name} (${objInfo.type})`);
    if (hostInfo.length > 0) {
        const hosts = hostInfo.map(h => `${h.name}${h.type ? `(${h.type})` : ''}`).join(', ');
        lines.push(`host: ${hosts}`);
    }
    lines.push(src);

    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

async function fetchEnhoHost(baseUrl: string, metaUrl: string): Promise<{ name: string; type: string; uri: string }[]> {
    try {
        const response = await makeAdtRequest(metaUrl, 'GET', 15000, undefined, undefined, {
            'Accept': 'application/xml, application/*, */*'
        });
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        if (!xml) return [];

        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;

        const refs: { name: string; type: string; uri: string }[] = [];
        const seen = new Set<string>();

        const walk = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
                if (key.startsWith('_')) continue;
                const lower = key.toLowerCase();
                // Look for any adtcore:objectReference or *:reference / *:enhancementreference
                if (lower.endsWith(':objectreference') || lower === 'objectreference'
                    || lower.endsWith(':reference') || lower === 'reference'
                    || lower.endsWith(':enhancedobjectreference')
                    || lower.endsWith(':enhanceablereference')) {
                    const val = obj[key];
                    const arr = Array.isArray(val) ? val : [val];
                    for (const item of arr) {
                        const attrs = item?._attributes || {};
                        const getAttr = (ln: string): string => {
                            const k = Object.keys(attrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                            return k ? String(attrs[k] || '') : '';
                        };
                        const name = getAttr('name');
                        const type = getAttr('type');
                        const uri = getAttr('uri');
                        if (name) {
                            const dedupe = `${name}|${type}|${uri}`;
                            if (!seen.has(dedupe)) {
                                seen.add(dedupe);
                                refs.push({ name, type, uri });
                            }
                        }
                    }
                }
                walk(obj[key]);
            }
        };
        walk(parsed);
        return refs;
    } catch {
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────
// Case B: Function group expansion via nodestructure
// ─────────────────────────────────────────────────────────────────────
function detectFunctionGroup(objInfo: ObjectInfo): string | null {
    const t = objInfo.type.toUpperCase();
    const n = objInfo.name.toUpperCase();
    if (t === 'FUGR/F') {
        const m = objInfo.uri.match(/^\/sap\/bc\/adt\/functions\/groups\/([^\/]+)/i);
        return m ? m[1].toUpperCase() : n;
    }
    // Function group main include (auto-generated wrapper SAPLxxx)
    if (t === 'FUGR/I' && n.startsWith('SAPL')) {
        return n.substring(4);
    }
    return null;
}

async function handleFunctionGroup(
    baseUrl: string, groupName: string, objInfo: ObjectInfo, withSource: boolean, maxIncludes: number
): Promise<any> {
    let includes: IncludeRef[];
    try {
        includes = await listFunctionGroupIncludes(baseUrl, groupName);
    } catch (error) {
        return return_error(error);
    }
    if (includes.length === 0) {
        return {
            isError: false,
            content: [{ type: 'text', text: `Function group ${groupName}: no includes found.` }]
        };
    }

    const totalIncludes = includes.length;
    const truncated = totalIncludes > maxIncludes;
    if (truncated) includes = includes.slice(0, maxIncludes);

    const lines: string[] = [];
    lines.push(`Enhancements for function group ${groupName} (${objInfo.type})`);
    lines.push(truncated
        ? `Scanning ${includes.length} of ${totalIncludes} include(s) (capped at max_includes=${maxIncludes}; raise it to scan more)…`
        : `Scanning ${includes.length} include(s)…`);
    lines.push('');

    let totalEnhancements = 0;
    let skipped = 0;
    const optionValue = withSource ? 'X' : '';

    // Concurrency-limited fan-out — SAP HTTPS without keep-alive throttles around 5-10 sockets
    const CONCURRENCY = 5;
    const PROBE_TIMEOUT = 10000;
    const results: { inc: IncludeRef; entries: EnhancementEntry[]; failed: boolean }[] = [];
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const i = cursor++;
            if (i >= includes.length) return;
            const inc = includes[i];
            if (!inc.uri) { results.push({ inc, entries: [], failed: true }); continue; }
            const sourceMainUri = inc.uri.endsWith('/source/main') ? inc.uri : `${inc.uri}/source/main`;
            const url = `${baseUrl}${sourceMainUri}/enhancements/elements?options=withsource:${optionValue}`;
            try {
                const response = await makeAdtRequest(url, 'GET', PROBE_TIMEOUT, undefined, undefined, {
                    'Content-Type': '*/*',
                    'Accept': '*/*'
                });
                const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
                results.push({ inc, entries: parseEnhancementEntries(xmlData), failed: false });
            } catch {
                results.push({ inc, entries: [], failed: true });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, includes.length) }, () => worker()));

    // Preserve original include order in output
    const byUri = new Map(results.map(r => [r.inc.uri, r]));
    for (const inc of includes) {
        const r = byUri.get(inc.uri);
        if (!r) continue;
        if (r.failed) { skipped++; continue; }
        if (r.entries.length > 0) {
            totalEnhancements += r.entries.length;
            lines.push(`── ${inc.name} (${inc.type}) — ${r.entries.length} enhancement(s)`);
            appendEntriesFormatted(lines, r.entries, withSource);
            lines.push('');
        }
    }

    if (totalEnhancements === 0) {
        lines.push(`No enhancements found across ${includes.length} include(s).`);
    } else {
        lines.push(`Total: ${totalEnhancements} enhancement(s) across function group ${groupName}.`);
    }
    if (skipped > 0) {
        lines.push(`(${skipped} include(s) had no enhancements endpoint and were skipped.)`);
    }
    if (truncated) {
        lines.push(`(Scan capped at ${maxIncludes} of ${totalIncludes} includes — pass max_includes to scan more.)`);
    }

    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

async function listFunctionGroupIncludes(baseUrl: string, groupName: string): Promise<IncludeRef[]> {
    const url = `${baseUrl}/sap/bc/adt/repository/nodestructure`;
    const params = {
        parent_type: 'FUGR/F',
        parent_name: groupName,
        withShortDescriptions: true
    };
    const response = await makeAdtRequest(url, 'POST', 30000, undefined, params);
    const convert = require('xml-js');
    const result = convert.xml2js(response.data, { compact: true }) as any;
    const nodes = result?.['asx:abap']?.['asx:values']?.DATA?.TREE_CONTENT?.SEU_ADT_REPOSITORY_OBJ_NODE || [];
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    return arr
        .filter((n: any) => n?.OBJECT_NAME?._text && n?.OBJECT_URI?._text)
        .map((n: any) => ({
            name: String(n.OBJECT_NAME._text),
            type: String(n.OBJECT_TYPE?._text || ''),
            uri: String(n.OBJECT_URI._text)
        }));
}

// ─────────────────────────────────────────────────────────────────────
// Case C: Single object — original flow
// ─────────────────────────────────────────────────────────────────────
async function handleSingleObject(baseUrl: string, objInfo: ObjectInfo, withSource: boolean): Promise<any> {
    const optionValue = withSource ? 'X' : '';
    const url = `${baseUrl}${objInfo.uri}/source/main/enhancements/elements?options=withsource:${optionValue}`;

    let xmlData: string;
    try {
        const response = await makeAdtRequest(url, 'GET', 60000, undefined, undefined, {
            'Content-Type': '*/*',
            'Accept': '*/*'
        });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            if (errMsg) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Enhancement read failed for ${objInfo.typeLabel} '${objInfo.name}'.\nReason: ${errMsg}` }]
                };
            }
        }
        return return_error(error);
    }

    const entries = parseEnhancementEntries(xmlData);
    const headerLine = `${objInfo.name} (${objInfo.type}): ${entries.length} enhancement(s)`;
    if (entries.length === 0) {
        // Heuristic: only show raw XML if the body has actual enhancement payload tags
        // (enhancementImplementations / sourceCodePlugin). An empty <enh:enhancements/>
        // root means "no enhancements" — don't dump it.
        const hasPayload = xmlData && /enhancementImplementations|sourceCodePlugin|classPlugin/i.test(xmlData);
        if (hasPayload) {
            return { isError: false, content: [{ type: 'text', text: `${objInfo.name}: parser missed entries — raw XML:\n${xmlData}` }] };
        }
        return { isError: false, content: [{ type: 'text', text: `${objInfo.name}: no enhancements.` }] };
    }

    const lines: string[] = [headerLine];
    appendEntriesFormatted(lines, entries, withSource);
    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─────────────────────────────────────────────────────────────────────
// Shared parsing / formatting
// ─────────────────────────────────────────────────────────────────────
function parseEnhancementEntries(xmlData: string): EnhancementEntry[] {
    try {
        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;

        // Locate all <enh:enhancementImplementations> nodes (one per ENHO attached to this object)
        const implsList: any[] = [];
        const walk = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
                if (key.startsWith('_')) continue;
                if (key.toLowerCase().endsWith(':enhancementimplementations') || key.toLowerCase() === 'enhancementimplementations') {
                    const v = obj[key];
                    const arr = Array.isArray(v) ? v : [v];
                    implsList.push(...arr);
                }
                walk(obj[key]);
            }
        };
        walk(parsed);
        if (implsList.length === 0) return [];

        const out: EnhancementEntry[] = [];
        for (const impl of implsList) {
            const implAttrs = impl._attributes || {};
            const getImplAttr = (ln: string): string => {
                const k = Object.keys(implAttrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                return k ? String(implAttrs[k] || '') : '';
            };
            const enhoName = getImplAttr('name');
            const enhoType = getImplAttr('type');

            // Find <enh:enhancedObject>
            let enhancedName = '';
            let enhancedType = '';
            const enhObjKey = Object.keys(impl).find((k: string) => k.toLowerCase().endsWith(':enhancedobject') || k.toLowerCase() === 'enhancedobject');
            if (enhObjKey) {
                const eo = impl[enhObjKey];
                const eoAttrs = (Array.isArray(eo) ? eo[0] : eo)?._attributes || {};
                const getEoAttr = (ln: string): string => {
                    const k = Object.keys(eoAttrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                    return k ? String(eoAttrs[k] || '') : '';
                };
                enhancedName = getEoAttr('name');
                enhancedType = getEoAttr('type');
            }

            // Find plugins inside <enh:elements>
            const elementsKey = Object.keys(impl).find((k: string) => k.toLowerCase().endsWith(':elements') || k.toLowerCase() === 'elements');
            if (!elementsKey) {
                // No elements — still emit a stub entry so the ENHO is visible
                out.push({
                    name: enhoName, enhoType, pluginKind: '', fullName: '',
                    mode: '', replacing: '', enhancedName, enhancedType, position: '', source: ''
                });
                continue;
            }
            const elements = impl[elementsKey];
            // Each child key is a plugin variant (sourceCodePlugin, classPlugin, etc.)
            for (const pluginKey of Object.keys(elements)) {
                if (pluginKey.startsWith('_')) continue;
                const rawPlugin = elements[pluginKey];
                const plugins = Array.isArray(rawPlugin) ? rawPlugin : [rawPlugin];
                const kindLabel = pluginKey.split(':').pop() || pluginKey;
                for (const p of plugins) {
                    const pAttrs = p._attributes || {};
                    const getP = (ln: string): string => {
                        const k = Object.keys(pAttrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                        return k ? String(pAttrs[k] || '') : '';
                    };

                    // Decode source (base64-encoded inside <enh:source>)
                    const sourceKey = Object.keys(p).find((k: string) => k.toLowerCase().endsWith(':source') || k.toLowerCase() === 'source');
                    let source = '';
                    if (sourceKey) {
                        const node = p[sourceKey];
                        const raw = node?._text || node?._cdata || (typeof node === 'string' ? node : '');
                        if (raw) source = tryDecodeBase64(String(raw).replace(/\s+/g, ''));
                    }

                    // Extract position from nested <enh:option> > <enh:sourceCodePluginOption> > <enh:position>
                    let position = '';
                    const findPosition = (obj: any, depth = 0): string => {
                        if (depth > 5 || !obj || typeof obj !== 'object') return '';
                        for (const k of Object.keys(obj)) {
                            if (k.startsWith('_')) continue;
                            if (k.toLowerCase().endsWith(':position') || k.toLowerCase() === 'position') {
                                const node = obj[k];
                                const a = (Array.isArray(node) ? node[0] : node)?._attributes || {};
                                const uriKey = Object.keys(a).find((x: string) => x === 'uri' || x.endsWith(':uri'));
                                if (uriKey) return String(a[uriKey] || '');
                            }
                            const sub = findPosition(obj[k], depth + 1);
                            if (sub) return sub;
                        }
                        return '';
                    };
                    position = findPosition(p);

                    out.push({
                        name: enhoName,
                        enhoType,
                        pluginKind: kindLabel,
                        fullName: getP('full_name'),
                        mode: getP('mode'),
                        replacing: getP('replacing'),
                        enhancedName,
                        enhancedType,
                        position,
                        source
                    });
                }
            }
        }
        return out;
    } catch {
        return [];
    }
}

function tryDecodeBase64(s: string): string {
    if (!s) return '';
    // Heuristic: only attempt if the string looks like base64 (no obvious ABAP keywords)
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) {
        try {
            const decoded = Buffer.from(s, 'base64').toString('utf8');
            if (decoded && /[\x20-\x7E -￿\n\r\t]/.test(decoded)) return decoded;
        } catch { /* fall through */ }
    }
    return s;
}

function appendEntriesFormatted(lines: string[], entries: EnhancementEntry[], withSource: boolean) {
    entries.forEach((e) => {
        const bits: string[] = [`${e.name}${e.enhoType ? `(${e.enhoType})` : ''}`];
        if (e.pluginKind)   bits.push(e.pluginKind);
        if (e.mode)         bits.push(`${e.mode}${e.replacing === 'true' ? '/replacing' : ''}`);
        if (e.enhancedName) bits.push(`@${e.enhancedName}`);
        // Extract just "line N" from the position uri, if present
        const lineMatch = e.position.match(/start=(\d+)/);
        if (lineMatch) bits.push(`line ${lineMatch[1]}`);
        lines.push(`- ${bits.join(' · ')}`);
        if (e.fullName) lines.push(`  ${e.fullName}`);
        if (withSource && e.source) {
            for (const ln of e.source.split('\n')) lines.push(`  | ${ln}`);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Resolve object via search
// ─────────────────────────────────────────────────────────────────────
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
                    : type === 'FUGR/I' ? 'function group include'
                    : type === 'FUGR/F' ? 'function group'
                    : type === 'FUGR/FF' ? 'function module'
                    : type === 'CLAS/OC' ? 'class'
                    : type === 'INTF/OI' ? 'interface'
                    : type.startsWith('ENHO') ? 'enhancement implementation'
                    : 'program';
                return { uri, type, name, typeLabel };
            }
        }
    } catch {
        // Fall through
    }
    return null;
}
