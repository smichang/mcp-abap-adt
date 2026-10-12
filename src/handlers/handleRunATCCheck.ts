import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { maybeBackground } from '../lib/background';

interface Finding {
    priority: number;      // 1=Error, 2=Warning, 3=Note
    checkTitle: string;
    messageTitle: string;
    locationName: string;  // the actual include/class/program the finding is IN (may differ from the container object)
    line: string;
    col: string;
}

interface ObjectFindings {
    name: string;
    type: string;
    findings: Finding[];
}

const PRIORITY_LABEL: Record<number, string> = { 1: 'E', 2: 'W', 3: 'N' };

export async function handleRunATCCheck(args: any) {
    try {
        const rawNumbers = args?.transport_numbers;
        const list: string[] = Array.isArray(rawNumbers) ? rawNumbers : (rawNumbers ? [rawNumbers] : []);
        if (list.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'transport_numbers is required (non-empty array of transport request numbers)');
        }
        const transportNumbers = [...new Set(list.map((t: any) => String(t).toUpperCase()))];
        const checkVariant = args?.check_variant ? String(args.check_variant) : undefined;
        const scope = args?.scope === 'full' ? 'full' : 'transport';
        const slug = `atc-findings-${transportNumbers.join('_')}`;

        return await maybeBackground(args, `ATC check for ${transportNumbers.join(', ')}`, slug, async () => {
            const { text, hasErrors } = await runAtcCore(transportNumbers, checkVariant, scope);
            return { isError: hasErrors, content: [{ type: 'text', text }] };
        });
    } catch (error) {
        return return_error(error);
    }
}

/**
 * Runs the full ATC flow (validate transports → worklist → run → fetch findings) and
 * returns a formatted text report. Always resolves to a string result — SAP failures are
 * rendered into the report text (hasErrors=true) rather than thrown — so both the
 * synchronous and background callers can present or persist the outcome uniformly.
 * Only truly unexpected errors propagate.
 */
async function runAtcCore(transportNumbers: string[], checkVariantArg?: string, scope: 'transport' | 'full' = 'transport'): Promise<{ text: string; hasErrors: boolean }> {
    const baseUrl = String(await getBaseUrl());

    // Validate each transport exists first — an invalid object reference in the ATC
    // run body is silently dropped (0 findings, no error), which would otherwise look
    // like a false "clean" result for a typo'd transport number.
    const checked = await Promise.all(transportNumbers.map(async (t) => {
        const desc = await validateTransport(baseUrl, t);
        return { transport: t, desc };
    }));
    const valid = checked.filter(c => c.desc !== null) as { transport: string; desc: string }[];
    const missing = checked.filter(c => c.desc === null).map(c => c.transport);

    if (valid.length === 0) {
        return { text: `None of the transport(s) could be found: ${missing.join(', ')}`, hasErrors: true };
    }

    const checkVariant = checkVariantArg || await resolveDefaultCheckVariant(baseUrl);

    // 1. Create worklist
    let worklistId: string;
    try {
        const response = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/atc/worklists`, 'POST', 30000, undefined,
            { checkVariant }
        );
        worklistId = String(response.data ?? '').trim();
        if (!worklistId) throw new Error('SAP returned an empty worklist id');
    } catch (error) {
        return { text: `Failed to create ATC worklist.\nReason: ${describeError(error)}`, hasErrors: true };
    }

    // 2. Run the check against all valid transports in one call
    const refsXml = valid.map(v =>
        `<adtcore:objectReference adtcore:uri="/sap/bc/adt/cts/transportrequests/${encodeURIComponent(v.transport)}"/>`
    ).join('');
    const runBody =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<atc:run xmlns:atc="http://www.sap.com/adt/atc" maximumVerdicts="100">` +
        `<objectSets xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<objectSet kind="inclusive"><adtcore:objectReferences>${refsXml}</adtcore:objectReferences></objectSet>` +
        `</objectSets></atc:run>`;

    let runXml: string;
    try {
        const response = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/atc/runs`, 'POST', 120000, runBody,
            { worklistId },
            { 'Content-Type': 'application/xml' }
        );
        runXml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error) {
        return { text: `ATC run failed.\nReason: ${describeError(error)}`, hasErrors: true };
    }
    const runInfos = parseRunInfos(runXml);

    // 3. Fetch findings
    let resultsXml: string;
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/atc/worklists/${encodeURIComponent(worklistId)}`, 'GET', 60000);
        resultsXml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error) {
        return { text: `Failed to fetch ATC findings.\nReason: ${describeError(error)}`, hasErrors: true };
    }

    const objects = parseFindings(resultsXml);

    // Scope down to findings that actually land on objects registered in the given
    // transport(s) — ATC checks the whole compilation unit (e.g. an entire function group
    // for one changed FM), so an unfiltered report can bury a small delta under hundreds of
    // pre-existing findings on untouched sibling objects. Only applied when we could resolve
    // at least one registered object name; a fetch failure or genuinely empty transport falls
    // back to unfiltered rather than risk hiding real findings behind an empty allow-list.
    let reportObjects = objects;
    let suppressed = 0;
    if (scope === 'transport') {
        const deltaNames = new Set<string>();
        await Promise.all(valid.map(async (v) => {
            for (const n of await fetchTransportObjectNames(baseUrl, v.transport)) deltaNames.add(n);
        }));
        if (deltaNames.size > 0) {
            reportObjects = objects.map(o => {
                const kept = o.findings.filter(f => deltaNames.has((f.locationName || o.name).toUpperCase()));
                suppressed += o.findings.length - kept.length;
                return { ...o, findings: kept };
            });
        }
    }

    const text = formatReport(valid, missing, checkVariant, runInfos, reportObjects, suppressed, scope);
    const hasErrors = reportObjects.some(o => o.findings.some(f => f.priority === 1));
    return { text, hasErrors };
}

// Names of objects (tm:abap_object/@tm:name) actually registered in a transport — used to
// scope ATC findings down to the transport's real delta. Non-fatal on failure: filtering is
// simply skipped for that transport's contribution to the allow-list.
async function fetchTransportObjectNames(baseUrl: string, transportNumber: string): Promise<Set<string>> {
    const names = new Set<string>();
    try {
        const response = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`, 'GET', 20000,
            undefined, undefined, { 'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml' }
        );
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const re = /<tm:abap_object\b[^>]*\btm:name="([^"]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml)) !== null) names.add(decodeXmlEntities(m[1]).toUpperCase());
    } catch {
        // non-fatal
    }
    return names;
}

function describeError(error: unknown): string {
    if (error instanceof AxiosError) {
        if (error.response?.data) {
            const parsed = parseAdtErrorXml(String(error.response.data));
            if (parsed) return parsed;
        }
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

function decodeXmlEntities(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

async function validateTransport(baseUrl: string, transportNumber: string): Promise<string | null> {
    try {
        const response = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/cts/transportrequests/${encodeURIComponent(transportNumber)}`, 'GET', 20000,
            undefined, undefined, { 'Accept': 'application/vnd.sap.adt.transportorganizer.v1+xml' }
        );
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const m = xml.match(/tm:desc="([^"]*)"/);
        return m ? decodeXmlEntities(m[1]) : '';
    } catch {
        return null;
    }
}

async function resolveDefaultCheckVariant(baseUrl: string): Promise<string> {
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/atc/customizing`, 'GET', 15000);
        const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const m = xml.match(/name="systemCheckVariant"\s+value="([^"]*)"/);
        return m ? m[1] : 'DEFAULT';
    } catch {
        return 'DEFAULT';
    }
}

function parseRunInfos(xml: string): string[] {
    const infos: string[] = [];
    const re = /<atcinfo:type>([^<]*)<\/atcinfo:type>\s*<atcinfo:description>([^<]*)<\/atcinfo:description>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        if (m[1] !== 'FINDING_STATS') infos.push(`${m[1]}: ${m[2]}`);
    }
    return infos;
}

function parseFindings(xml: string): ObjectFindings[] {
    try {
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;
        const worklist = parsed['atcworklist:worklist'];
        if (!worklist) return [];
        const objectsNode = worklist['atcworklist:objects'];
        if (!objectsNode) return [];
        const rawObjects = objectsNode['atcobject:object'];
        if (!rawObjects) return [];
        const objArr = Array.isArray(rawObjects) ? rawObjects : [rawObjects];

        return objArr.map((obj: any) => {
            const attrs = obj._attributes || {};
            const name = attrs['adtcore:name'] || '';
            const type = attrs['adtcore:type'] || '';
            const findingsNode = obj['atcobject:findings'];
            const rawFindings = findingsNode ? findingsNode['atcfinding:finding'] : null;
            const findArr = rawFindings ? (Array.isArray(rawFindings) ? rawFindings : [rawFindings]) : [];
            const findings: Finding[] = findArr.map((f: any) => {
                const fa = f._attributes || {};
                const location = fa['atcfinding:location'] || '';
                const posMatch = location.match(/#start=(\d+),(\d+)/);
                // The finding's actual source (include/class/program) is the path segment
                // right before "/source/main" — it is frequently a sub-include of the
                // container object listed at the atcobject:object level, not that object itself.
                const nameMatch = location.match(/\/([A-Za-z0-9_~]+)\/source\/main/);
                return {
                    priority: Number(fa['atcfinding:priority'] || 3),
                    checkTitle: fa['atcfinding:checkTitle'] || '',
                    messageTitle: fa['atcfinding:messageTitle'] || '',
                    locationName: nameMatch ? nameMatch[1].toUpperCase() : '',
                    line: posMatch ? posMatch[1] : '0',
                    col: posMatch ? posMatch[2] : '0'
                };
            });
            return { name, type, findings };
        });
    } catch {
        return [];
    }
}

function formatReport(
    valid: { transport: string; desc: string }[],
    missing: string[],
    checkVariant: string,
    runInfos: string[],
    objects: ObjectFindings[],
    suppressed: number = 0,
    scope: 'transport' | 'full' = 'transport'
): string {
    const lines: string[] = [];
    lines.push(`ATC Check — variant: ${checkVariant}`);
    lines.push(`Transports scanned: ${valid.map(v => `${v.transport}${v.desc ? ` (${v.desc})` : ''}`).join(', ')}`);
    if (missing.length) lines.push(`Transports NOT FOUND (skipped): ${missing.join(', ')}`);
    if (runInfos.length) lines.push(...runInfos);
    if (scope === 'transport' && suppressed > 0) {
        lines.push(`Scope: transport delta only — ${suppressed} finding(s) on other objects in the same compilation unit (e.g. sibling function modules) suppressed. Pass scope="full" to see everything.`);
    }

    let errors = 0, warnings = 0, notes = 0;
    for (const obj of objects) for (const f of obj.findings) {
        if (f.priority === 1) errors++;
        else if (f.priority === 2) warnings++;
        else notes++;
    }
    lines.push(`Findings: ${errors} error(s), ${warnings} warning(s), ${notes} note(s)`);

    if (objects.length === 0 || (errors + warnings + notes === 0)) {
        lines.push('', 'No findings.');
        return lines.join('\n');
    }

    for (const obj of objects) {
        if (obj.findings.length === 0) continue;
        lines.push('', `${obj.name} (${obj.type}):`);
        const sorted = [...obj.findings].sort((a, b) => a.priority - b.priority);
        for (const f of sorted) {
            const loc = f.locationName && f.locationName !== obj.name ? `${f.locationName}:${f.line}:${f.col}` : `${f.line}:${f.col}`;
            lines.push(`  [${PRIORITY_LABEL[f.priority] || f.priority}] ${loc}  ${f.messageTitle} (${f.checkTitle})`);
        }
    }
    return lines.join('\n');
}
