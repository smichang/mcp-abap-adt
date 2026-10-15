import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { maybeBackground } from '../lib/background';
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';

const SYNC_TIMEOUT_MS = 60000;          // what a synchronous call waits for SAP
const BACKGROUND_TIMEOUT_MS = 600000;   // a background run may take much longer (IF_MESSAGE: 47,828 usages)

export async function handleGetWhereUsed(args: any) {
    const name = args?.object_name ? String(args.object_name).toUpperCase() : 'object';
    const slug = `whereused-${name}`;
    const label = `Where-used for ${name}`;
    // an explicit background run is not held to the synchronous 60 s
    if (args?.background === true) return maybeBackground(args, label, slug, () => getWhereUsedCore(args, BACKGROUND_TIMEOUT_MS));

    const res: any = await maybeBackground(args, label, slug, () => getWhereUsedCore(args, SYNC_TIMEOUT_MS));
    // (maybeBackground rebuilds the result when output_file is set and drops the flag, so match the text too)
    const timedOut = res?.timedOut === true || /^Where-used for '.*' timed out after \d+ s\./.test(String(res?.content?.[0]?.text ?? ''));
    if (!timedOut) return res;
    // The object is used too widely to answer within the synchronous window (a very common standard
    // interface/class has tens of thousands of usages and failed at exactly 60 s). Don't just fail:
    // run it again in the background with the long timeout and hand back where the result will be.
    const started: any = await maybeBackground({ ...args, background: true }, label, slug, () => getWhereUsedCore(args, BACKGROUND_TIMEOUT_MS));
    const where = started?.content?.[0]?.text ?? '';
    return {
        isError: false,
        content: [{ type: 'text', text: `${label} did not finish within ${SYNC_TIMEOUT_MS / 1000} s — ${name} is used very widely. Continued automatically in the background (timeout ${BACKGROUND_TIMEOUT_MS / 60000} min):\n${where}\nOnce the file shows the list it is also cached, so repeated calls with another offset/max_results page without a new SAP query.` }]
    };
}

async function getWhereUsedCore(args: any, timeoutMs: number = SYNC_TIMEOUT_MS) {
    try {
        if (!args?.object_name) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }
        if (!args?.object_type) {
            throw new McpError(ErrorCode.InvalidParams, 'object_type is required (e.g., CLAS, PROG, FUGR, FUGR/FF, INTF, TABL, DTEL, DOMA)');
        }

        const objectName = args.object_name.toUpperCase();
        const objectType = args.object_type.toUpperCase();
        const maxResults = Math.max(1, Number(args?.max_results) || 100);
        const offset = Math.max(0, Number(args?.offset) || 0);
        const baseUrl = await getBaseUrl();

        // The full usage list plus its SAP-supplied summary text — cached together as one
        // entry (not two independent keys) so they can never desync, so a follow-up call
        // with a different offset/max_results pages without re-querying SAP.
        const key = cacheKey('GetWhereUsed', { object_name: objectName, object_type: objectType });
        const cached = getCachedList<{ usages: any[]; resultDesc: string }>(key);
        let usages: any[];
        let resultDesc = '';
        const fromCache = !!cached;
        let xmlData = ''; // only populated on the fresh-fetch path; used as a raw-XML fallback if rendering throws

        if (cached) {
            usages = cached[0].usages;
            resultDesc = cached[0].resultDesc;
        } else {
            // Step 1: Resolve the object's ADT URI via search
            const objectUri = await resolveObjectUri(String(baseUrl), objectName, objectType);
            if (!objectUri) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Object '${objectName}' not found in SAP system.` }]
                };
            }

            // Step 2: Call the POST usageReferences endpoint
            const encodedUri = encodeURIComponent(objectUri);
            const url = `${baseUrl}/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodedUri}`;
            const body = '<?xml version="1.0" encoding="ASCII"?>' +
                '<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">' +
                '<usagereferences:affectedObjects/>' +
                '</usagereferences:usageReferenceRequest>';

            try {
                const response = await makeAdtRequest(url, 'POST', timeoutMs, body, undefined, {
                    'Content-Type': 'application/*',
                    'Accept': 'application/*'
                });
                xmlData = response.data ?? response;
                if (typeof xmlData !== 'string') xmlData = String(xmlData);
            } catch (error) {
                if (error instanceof AxiosError && error.response?.data) {
                    const errMsg = parseAdtErrorXml(String(error.response.data));
                    if (errMsg) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: `Where-used search failed for '${objectName}'.\nReason: ${errMsg}` }]
                        };
                    }
                }
                // a request that ran into our own timeout is not a failure of SAP — signal it so the
                // caller can continue in the background instead of reporting an error
                if (error instanceof AxiosError && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout of \d+ms exceeded/i.test(error.message))) {
                    return { isError: true, timedOut: true, content: [{ type: 'text', text: `Where-used for '${objectName}' timed out after ${timeoutMs / 1000} s.` }] } as any;
                }
                return return_error(error);
            }

            // Step 3: Parse the usageReferences response
            try {
                const convert = require('xml-js');
                const parsed = convert.xml2js(xmlData, { compact: true }) as any;

                const resultKey = Object.keys(parsed).find((k: string) => k.includes('usageReferenceResult'));
                if (!resultKey) throw new Error('Unexpected XML structure');
                const result = parsed[resultKey];

                const resultAttrs = result._attributes || {};
                resultDesc = resultAttrs.resultDescription || '';

                // Navigate to referencedObjects
                const refsContainerKey = Object.keys(result).find((k: string) => k.includes('referencedObjects'));
                let refObjects: any[] = [];
                if (refsContainerKey) {
                    const container = result[refsContainerKey];
                    const refObjKey = Object.keys(container).find((k: string) => k.includes('referencedObject'));
                    if (refObjKey) {
                        const raw = container[refObjKey];
                        refObjects = Array.isArray(raw) ? raw : [raw];
                    }
                }

                // Filter to actual results (isResult or has objectIdentifier — exclude package containers)
                usages = refObjects.filter((r: any) => {
                    const objectIdKey = Object.keys(r).find((k: string) => k === 'objectIdentifier');
                    return objectIdKey && r[objectIdKey];
                });

                setCachedList(key, [{ usages, resultDesc }]);
            } catch (_parseError) {
                return {
                    isError: false,
                    content: [{ type: 'text', text: xmlData }]
                };
            }
        }

        if (usages.length === 0) {
            return {
                isError: false,
                content: [{ type: 'text', text: `No usages found for '${objectName}' (type: ${objectType}).\n${resultDesc}` }]
            };
        }

        // Guard the render step: usages parsed fine, but an unanticipated shape in the
        // per-entry traversal should fall back to the raw XML for debugging (fresh-fetch
        // path) rather than surface only a bare error message.
        try {
            const total = usages.length;
            const shown = usages.slice(offset, offset + maxResults);

            const lines: string[] = [];
            const windowEnd = offset + shown.length;
            const cacheNote = fromCache ? ' [cached]' : '';
            lines.push(total > windowEnd || offset > 0
                ? `${resultDesc}${cacheNote} — showing ${shown.length === 0 ? 0 : offset + 1}-${windowEnd} of ${total} usage(s)${total > windowEnd ? ' (raise max_results or offset to see more)' : ''}:`
                : `${resultDesc}${cacheNote} — ${total} usage(s):`);
            lines.push('');

            // Extract info from each usage
            const entries: { name: string; type: string; pkg: string; responsible: string; uri: string }[] = [];
            for (const usage of shown) {
                const adtObjKey = Object.keys(usage).find((k: string) => k.includes('adtObject'));
                const adtObj = adtObjKey ? usage[adtObjKey] : {};
                const attrs = adtObj._attributes || {};
                const getAttr = (localName: string): string => {
                    const key = Object.keys(attrs).find((k: string) => k === localName || k.endsWith(':' + localName));
                    return key ? (attrs[key] || '') : '';
                };
                const pkgRefKey = Object.keys(adtObj).find((k: string) => k.includes('packageRef'));
                const pkgAttrs = pkgRefKey ? (adtObj[pkgRefKey]._attributes || {}) : {};
                const pkgName = Object.keys(pkgAttrs).find((k: string) => k.endsWith(':name') || k === 'name');

                entries.push({
                    name: getAttr('name'),
                    type: getAttr('type'),
                    pkg: pkgName ? pkgAttrs[pkgName] : '',
                    responsible: getAttr('responsible'),
                    uri: (usage._attributes || {}).uri || ''
                });
            }

            const nameWidth = Math.min(40, Math.max(4, ...entries.map(e => e.name.length)));
            const typeWidth = Math.min(12, Math.max(4, ...entries.map(e => e.type.length)));
            const pkgWidth = Math.min(25, Math.max(7, ...entries.map(e => e.pkg.length)));
            const respWidth = Math.min(20, Math.max(11, ...entries.map(e => e.responsible.length)));

            lines.push(`${'Name'.padEnd(nameWidth)}  ${'Type'.padEnd(typeWidth)}  ${'Package'.padEnd(pkgWidth)}  ${'Responsible'.padEnd(respWidth)}`);
            lines.push(`${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  ${'-'.repeat(pkgWidth)}  ${'-'.repeat(respWidth)}`);

            for (const e of entries) {
                lines.push(`${e.name.padEnd(nameWidth)}  ${e.type.padEnd(typeWidth)}  ${e.pkg.padEnd(pkgWidth)}  ${e.responsible.padEnd(respWidth)}`);
            }

            return {
                isError: false,
                content: [{ type: 'text', text: lines.join('\n') }]
            };
        } catch (renderError) {
            if (xmlData) return { isError: false, content: [{ type: 'text', text: xmlData }] };
            return return_error(renderError);
        }
    } catch (error) {
        return return_error(error);
    }
}

async function resolveObjectUri(baseUrl: string, objectName: string, objectType: string): Promise<string | null> {
    const searchUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(objectName)}&maxResults=10`;

    try {
        const response = await makeAdtRequest(searchUrl, 'GET', 30000);
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

        for (const ref of refs) {
            const attrs = ref._attributes || {};
            const getAttr = (localName: string): string => {
                const key = Object.keys(attrs).find((k: string) => k === localName || k.endsWith(':' + localName));
                return key ? (attrs[key] || '') : '';
            };
            const name = getAttr('name').toUpperCase();
            const type = getAttr('type').toUpperCase();
            const uri = getAttr('uri');

            if (name === objectName && type === objectType && uri) {
                return uri;
            }
            // Also match if user provided base type (e.g., "FUNC") and search returns "FUGR/FF"
            if (name === objectName && uri) {
                return uri;
            }
        }
        return null;
    } catch {
        return null;
    }
}
