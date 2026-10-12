import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { unifiedDiff } from '../lib/unidiff';
import { AxiosError } from 'axios';

// ADT source URL prefixes by object type
const TYPE_SOURCE_PREFIX: Record<string, string> = {
    'PROG': '/sap/bc/adt/programs/programs',
    'CLAS': '/sap/bc/adt/oo/classes',
    'INTF': '/sap/bc/adt/oo/interfaces',
    'FUGR': '/sap/bc/adt/functions/groups',
    'INCL': '/sap/bc/adt/programs/includes',
    'TABL': '/sap/bc/adt/ddic/tables',
    'DTEL': '/sap/bc/adt/ddic/dataelements',
    'DOMA': '/sap/bc/adt/ddic/domains',
    'DDLS': '/sap/bc/adt/ddic/ddl/sources',
};

// Known versions-feed path per type (relative to the object URL), so the common case skips the
// metadata round-trip. Verified live 2026-10-07 against each type's own rel=".../versions" link:
// a class has NO source/main/versions (404) — its history is per include, and `includes/main`
// is the global class pool; a CDS source links plain `versions`. Types not listed here, or a
// path that fails, fall back to discovering the link from the object's metadata.
const VERSIONS_PATH: Record<string, string> = {
    'PROG': 'source/main/versions',
    'INCL': 'source/main/versions',
    'INTF': 'source/main/versions',
    'FUGR': 'source/main/versions',
    'CLAS': 'includes/main/versions',
    'DDLS': 'versions',
};

// Program/include is the most common type mix-up; retry the sibling prefix on failure.
const SIBLING_TYPE: Record<string, string> = { 'PROG': 'INCL', 'INCL': 'PROG' };

const VERSIONS_REL = 'http://www.sap.com/adt/relations/versions';

// A class keeps one version history per include. The class's metadata advertises one
// rel=".../versions" link per include it has: includes/{main|definitions|implementations|macros|testclasses}/versions
// (testclasses only when local tests exist). main = the global class pool; definitions = local
// types (CCDEF); implementations = local classes (CCIMP); macros = CCMAC; testclasses = CCAU.
// Active source: main → {class}/source/main (includes/main itself 404s); others → {class}/includes/{name}.
const CLASS_INCLUDES = ['main', 'definitions', 'implementations', 'macros', 'testclasses'];

async function discoverClassIncludes(objectUrl: string): Promise<string[]> {
    try {
        const response = await makeAdtRequest(objectUrl, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        const xml = String(response.data || '');
        const found = [...xml.matchAll(/href="includes\/([a-z]+)\/versions"[^>]*rel="http:\/\/www\.sap\.com\/adt\/relations\/versions"/g)].map(m => m[1]);
        return CLASS_INCLUDES.filter(i => found.includes(i));
    } catch (_) {
        return ['main'];
    }
}

interface VersionEntry {
    verNo: string;       // atom:id, e.g. "00005"
    transport: string;   // transport request name, e.g. "DEVK900123" (may be empty)
    title: string;
    date: string;
    author: string;
    contentSrc: string;  // path to the source AT this version (atom:content/@src)
}

/**
 * Fetch the object's ADT structure XML and extract the versions link href.
 * Fallback path for types whose versions URL is not the predictable source/main/versions.
 */
async function discoverVersionsUrl(objectUrl: string): Promise<string | null> {
    try {
        const response = await makeAdtRequest(
            objectUrl, 'GET', 15000, undefined, undefined,
            { 'Accept': 'application/xml, */*' }
        );
        const xmlData = response.data;
        if (typeof xmlData !== 'string' || !xmlData.trim().startsWith('<')) return null;

        const convert = require('xml-js');
        const parsed = convert.xml2js(xmlData, { compact: true }) as any;

        const findLink = (obj: any): string | null => {
            if (!obj || typeof obj !== 'object') return null;
            for (const key of Object.keys(obj)) {
                if (key === 'atom:link' || key === 'link') {
                    const links = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
                    for (const lnk of links) {
                        if (lnk?._attributes?.rel === VERSIONS_REL && lnk?._attributes?.href) {
                            return lnk._attributes.href as string;
                        }
                    }
                }
                const found = findLink(obj[key]);
                if (found) return found;
            }
            return null;
        };

        return findLink(parsed);
    } catch (_) {
        return null;
    }
}

async function getFeed(versionsUrl: string): Promise<string | null> {
    try {
        const response = await makeAdtRequest(
            versionsUrl, 'GET', 30000, undefined, undefined,
            { 'Accept': 'application/atom+xml;type=feed' }
        );
        const xml = response.data ?? response;
        return typeof xml === 'string' ? xml : String(xml);
    } catch (_) {
        return null;
    }
}

/** GET the versions atom feed for one object URL. Returns the XML, or null on any failure (e.g. 404). */
async function fetchVersionsFeed(objectUrl: string, type: string): Promise<string | null> {
    const known = VERSIONS_PATH[type];
    if (known) {
        const xml = await getFeed(`${objectUrl}/${known}`);
        if (xml) return xml;
    }
    const href = await discoverVersionsUrl(objectUrl);
    if (!href) return null;
    return getFeed(new URL(href, objectUrl + '/').toString());
}

const atomText = (node: any): string => {
    if (!node) return '';
    if (node._text) return String(node._text).trim();
    if (typeof node === 'string') return node.trim();
    return '';
};

/** Parse the versions Atom feed into structured entries (newest first, as SAP returns). */
function parseVersionEntries(xmlData: string): VersionEntry[] | null {
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const feed = parsed?.['atom:feed'] || parsed?.['feed'];
    if (!feed) return null;
    const entryRaw = feed['atom:entry'] || feed['entry'];
    if (!entryRaw) return [];
    const raw: any[] = Array.isArray(entryRaw) ? entryRaw : [entryRaw];

    const TRANSPORT_TYPE = 'application/vnd.sap.adt.transportrequests.v1+xml';
    return raw.map((entry: any): VersionEntry => {
        const author = (entry['atom:author'] || entry['author']) || {};
        const content = entry['atom:content'] || entry['content'];
        const linkRaw = entry['atom:link'] || entry['link'];
        const links = !linkRaw ? [] : (Array.isArray(linkRaw) ? linkRaw : [linkRaw]);
        const tlink = links.find((l: any) => l._attributes?.type === TRANSPORT_TYPE) || links[0];
        return {
            verNo: atomText(entry['atom:id'] || entry['id']),
            transport: tlink?._attributes?.['adtcore:name'] || '',
            title: atomText(entry['atom:title'] || entry['title']),
            date: atomText(entry['atom:updated'] || entry['updated']),
            author: atomText(author['atom:name'] || author['name']),
            contentSrc: content?._attributes?.src || ''
        };
    });
}

function versionTable(entries: VersionEntry[]): string[] {
    const tw = 22, aw = 14, vw = 30;
    const out = [
        `${'Date/Time'.padEnd(tw)}  ${'Author'.padEnd(aw)}  ${'Version/Transport'.padEnd(vw)}  Title`,
        `${'-'.repeat(tw)}  ${'-'.repeat(aw)}  ${'-'.repeat(vw)}  -----`
    ];
    for (const e of entries) out.push(`${e.date.padEnd(tw)}  ${e.author.padEnd(aw)}  ${(e.transport || e.verNo).padEnd(vw)}  ${e.title}`);
    return out;
}

/** List mode for a class: one section per include, so a change to local classes/test classes is visible too. */
async function listClassHistories(objectUrl: string, objectName: string) {
    const includes = await discoverClassIncludes(objectUrl);
    const lines: string[] = [`Version History: ${objectName} (CLAS) — ${includes.length} include(s): ${includes.join(', ')}`];
    for (const inc of includes) {
        const feed = await getFeed(`${objectUrl}/includes/${inc}/versions`);
        const entries = feed ? parseVersionEntries(feed) : null;
        lines.push('', `── include ${inc} ── ${entries ? `${entries.length} version(s)` : 'history unavailable'}`);
        if (entries && entries.length) lines.push(...versionTable(entries));
    }
    lines.push('', 'Tip: pass `class_include` (main|definitions|implementations|macros|testclasses; default main) with `version` to fetch that include\'s source at a version, or with `compare_to` to diff it. A transport that appears only under implementations/definitions/testclasses changed only local classes/types/tests.');
    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

export async function handleGetObjectVersion(args: any) {
    try {
        if (!args?.object_name) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }
        if (!args?.object_type) {
            throw new McpError(ErrorCode.InvalidParams,
                `object_type is required. Supported: ${Object.keys(TYPE_SOURCE_PREFIX).join(', ')}`);
        }

        const objectName = args.object_name.toUpperCase();
        const objectType = args.object_type.toUpperCase();
        const classInclude: string | undefined = args.class_include ? String(args.class_include).toLowerCase() : undefined;
        if (classInclude && !CLASS_INCLUDES.includes(classInclude)) {
            throw new McpError(ErrorCode.InvalidParams, `class_include must be one of ${CLASS_INCLUDES.join(', ')} (got '${args.class_include}')`);
        }
        if (classInclude && objectType !== 'CLAS') {
            throw new McpError(ErrorCode.InvalidParams, 'class_include is only valid for object_type=CLAS');
        }
        const version: string | undefined = args.version ? String(args.version) : undefined;
        const compareTo: string | undefined = args.compare_to ? String(args.compare_to) : undefined;
        const baseUrl = await getBaseUrl();

        if (!TYPE_SOURCE_PREFIX[objectType]) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Unsupported object type: ${objectType}. Supported: ${Object.keys(TYPE_SOURCE_PREFIX).join(', ')}` }]
            };
        }

        // Candidate types to try, in order: the requested one, then its sibling (PROG↔INCL).
        const candidates = [objectType];
        if (SIBLING_TYPE[objectType]) candidates.push(SIBLING_TYPE[objectType]);

        // Resolve the versions feed (and thereby the real object URL / type) across candidates.
        let xmlData: string | null = null;
        let resolvedType = objectType;
        let objectUrl = '';
        for (const t of candidates) {
            const url = `${baseUrl}${TYPE_SOURCE_PREFIX[t]}/${encodeURIComponent(objectName)}`;
            xmlData = await fetchVersionsFeed(url, t);
            if (xmlData) { resolvedType = t; objectUrl = url; break; }
        }
        if (!xmlData) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Could not find versions for '${objectName}' (tried: ${candidates.join(', ')}). The object may not exist or version management may be unavailable.` }]
            };
        }

        const isClass = resolvedType === 'CLAS';
        // Class, list mode, no include chosen → every include's history (a CR may touch only local classes).
        if (isClass && !classInclude && !version && !compareTo) {
            return await listClassHistories(objectUrl, objectName);
        }
        const include = isClass ? (classInclude || 'main') : '';
        let classIncludes: string[] = [];
        if (isClass && include !== 'main') {
            classIncludes = await discoverClassIncludes(objectUrl);
            if (!classIncludes.includes(include)) {
                return { isError: true, content: [{ type: 'text', text: `Class '${objectName}' has no '${include}' include. Available: ${classIncludes.join(', ')}` }] };
            }
            xmlData = await getFeed(`${objectUrl}/includes/${include}/versions`);
            if (!xmlData) return { isError: true, content: [{ type: 'text', text: `Could not read the version history of ${objectName}'s '${include}' include.` }] };
        }
        const label = isClass ? `${resolvedType}, include ${include}` : resolvedType;

        const entries = parseVersionEntries(xmlData);
        if (entries === null) {
            // Couldn't parse — fall back to raw feed.
            return { isError: false, content: [{ type: 'text', text: xmlData }] };
        }

        // SAP's `?version=` query param is ignored on the source endpoint (always returns active);
        // each historical version is fetched via its atom:content src instead.
        const findEntry = (verId: string): VersionEntry | undefined => {
            const key = verId.toUpperCase();
            return entries.find(e => e.transport.toUpperCase() === key || e.verNo.toUpperCase() === key);
        };
        const availableIds = () => entries.map(e => e.transport || e.verNo).filter(Boolean).join(', ') || '(none)';

        // Returns source text for a version id (transport or version number), or "active"/undefined for current source.
        const getVersionSource = async (verId?: string): Promise<string> => {
            if (!verId || verId.toLowerCase() === 'active') {
                const activeUrl = isClass && include !== 'main' ? `${objectUrl}/includes/${include}` : `${objectUrl}/source/main`;
                const r = await makeAdtRequest(activeUrl, 'GET', 30000);
                return typeof r.data === 'string' ? r.data : String(r.data ?? '');
            }
            const ent = findEntry(verId);
            if (!ent || !ent.contentSrc) {
                let hint = '';
                if (isClass) {
                    // Point at the include(s) that do have this version — e.g. a CR that only changed local classes.
                    const others: string[] = [];
                    for (const inc of (classIncludes.length ? classIncludes : await discoverClassIncludes(objectUrl)).filter(i => i !== include)) {
                        const feed = await getFeed(`${objectUrl}/includes/${inc}/versions`);
                        const es = feed ? parseVersionEntries(feed) || [] : [];
                        if (es.some(e => e.transport.toUpperCase() === verId.toUpperCase() || e.verNo.toUpperCase() === verId.toUpperCase())) others.push(inc);
                    }
                    if (others.length) hint = ` It exists in include(s): ${others.join(', ')} — pass class_include.`;
                }
                throw new McpError(ErrorCode.InvalidParams,
                    `Version '${verId}' not found for '${objectName}'${isClass ? ` (include ${include})` : ''}. Available: ${availableIds()}.${hint}`);
            }
            const r = await makeAdtRequest(`${baseUrl}${ent.contentSrc}`, 'GET', 30000);
            return typeof r.data === 'string' ? r.data : String(r.data ?? '');
        };

        // ── compare_to provided → unified diff (baseline compare_to → target version|active) ──
        if (compareTo) {
            const targetLabel = version || 'active';
            try {
                const [baseSrc, targetSrc] = await Promise.all([getVersionSource(compareTo), getVersionSource(version)]);
                const d = unifiedDiff(baseSrc, targetSrc);
                const head = `${objectName} (${label}) — diff ${compareTo} → ${targetLabel}`;
                if (d.skipped) return { isError: false, content: [{ type: 'text', text: `${head}\n\n${d.skipped}` }] };
                if (d.identical) return { isError: false, content: [{ type: 'text', text: `${head}\nVersions ${compareTo} and ${targetLabel} are identical.` }] };
                const footer = d.truncatedLines > 0
                    ? `\n\n… diff truncated — ${d.truncatedLines} more line(s) omitted. These versions differ substantially; fetch a single version's source, or compare nearer versions.`
                    : '';
                return { isError: false, content: [{ type: 'text', text: `${head}  (+${d.added} / -${d.removed} lines)\n\n${d.body}${footer}` }] };
            } catch (error) {
                if (error instanceof McpError) return { isError: true, content: [{ type: 'text', text: error.message }] };
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) return { isError: true, content: [{ type: 'text', text: `Compare failed for '${objectName}' (${compareTo} → ${targetLabel}).\nReason: ${errMsg}` }] };
                }
                return return_error(error);
            }
        }

        // ── version provided → return source at that version ──
        if (version) {
            try {
                const text = await getVersionSource(version);
                return { isError: false, content: [{ type: 'text', text: `${objectName} (${label}) — version: ${version}\n\n${text}` }] };
            } catch (error) {
                if (error instanceof McpError) return { isError: true, content: [{ type: 'text', text: error.message }] };
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) return { isError: true, content: [{ type: 'text', text: `Failed to retrieve version '${version}' for '${objectName}'.\nReason: ${errMsg}` }] };
                }
                return return_error(error);
            }
        }

        // ── no version/compare → list all versions ──
        if (entries.length === 0) {
            return { isError: false, content: [{ type: 'text', text: `No version history found for '${objectName}' (${label}).` }] };
        }

        const lines: string[] = [];
        lines.push(`Version History: ${objectName} (${label}) — ${entries.length} version(s)`);
        lines.push('');
        lines.push(...versionTable(entries));
        lines.push('');
        lines.push('Tip: pass a Version/Transport above as `version` to fetch its source, or as `compare_to` (with optional `version`) to diff.');

        return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}
