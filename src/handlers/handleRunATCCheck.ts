import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { maybeBackground } from '../lib/background';
import { resolveAnyObject } from '../lib/resolveObject';

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

const DEFAULT_FINDING_LIMIT = 200;

// ADT object-reference URIs for the object kinds an ATC run can be pointed at. A package reference
// makes ATC check everything inside the package (sub-packages included, as in SE80/ADT).
type AtcTarget =
    | { kind: 'transport'; transports: string[] }
    | { kind: 'objects'; names: string[] }
    | { kind: 'worklist'; worklistId: string };

export async function handleRunATCCheck(args: any) {
    try {
        const rawNumbers = args?.transport_numbers;
        const list: string[] = Array.isArray(rawNumbers) ? rawNumbers : (rawNumbers ? [rawNumbers] : []);
        const rawObjects: string[] = Array.isArray(args?.objects) ? args.objects : (args?.objects ? [args.objects] : []);
        const worklistId = args?.worklist_id ? String(args.worklist_id).trim() : '';
        const modes = [list.length > 0, rawObjects.length > 0, worklistId !== ''].filter(Boolean).length;
        if (modes !== 1) {
            throw new McpError(ErrorCode.InvalidParams, 'pass exactly one of: transport_numbers (transport requests), objects (object/package names), or worklist_id (re-read an earlier run without running ATC again)');
        }
        if (rawObjects.length > 20) {
            throw new McpError(ErrorCode.InvalidParams, `objects has ${rawObjects.length} entries; the maximum is 20 per run (check a package instead of its members)`);
        }
        const checkVariant = args?.check_variant ? String(args.check_variant) : undefined;
        const scope = args?.scope === 'full' ? 'full' : 'transport';
        // opt-in compatibility for scripts/CI that gate on isError: with fail_on_error=true a run that FINDS
        // priority-1 findings is also returned as isError (the Verdict line is there either way)
        const failOnError = args?.fail_on_error === true;
        const offset = Number.isFinite(Number(args?.offset)) && Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0;
        const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : DEFAULT_FINDING_LIMIT;

        let target: AtcTarget;
        let label: string;
        if (worklistId) {
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(worklistId)) throw new McpError(ErrorCode.InvalidParams, 'worklist_id looks malformed');
            target = { kind: 'worklist', worklistId };
            label = `worklist ${worklistId}`;
        } else if (rawObjects.length > 0) {
            const names = [...new Set(rawObjects.map((o: any) => String(o).toUpperCase().trim()).filter(Boolean))];
            target = { kind: 'objects', names };
            label = names.join(', ');
        } else {
            const transports = [...new Set(list.map((t: any) => String(t).toUpperCase()))];
            target = { kind: 'transport', transports };
            label = transports.join(', ');
        }
        const slug = `atc-findings-${label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)}`;

        return await maybeBackground(args, `ATC check for ${label}`, slug, async () => {
            const { text, hasErrors, foundErrors } = await runAtcCore(target, checkVariant, scope, offset, limit);
            const asError = failOnError && foundErrors;
            // the default wording says the CALL succeeded; with fail_on_error it is returned as an error on purpose
            const shown = asError ? text.replace('The tool call itself succeeded.', 'Returned as an error because fail_on_error=true.') : text;
            return { isError: hasErrors || asError, content: [{ type: 'text', text: shown }] };
        });
    } catch (error) {
        return return_error(error);
    }
}

// Resolves each name to an ADT object reference. A name that is not found, or is ambiguous across
// types, is reported instead of being sent: an unresolvable reference in the run body is silently
// dropped by SAP (0 findings), which would read as a false "clean" result.
async function resolveAtcObjects(baseUrl: string, names: string[]): Promise<{ refs: { name: string; uri: string; type: string }[]; problems: string[] }> {
    const refs: { name: string; uri: string; type: string }[] = [];
    const problems: string[] = [];
    for (const name of names) {
        try {
            const r = await resolveAnyObject(baseUrl, name);
            if ('error' in r) problems.push(`${name}: ${r.error.split('\n')[0]}`);
            else refs.push({ name, uri: r.uri, type: r.type });
        } catch (error) {
            problems.push(`${name}: ${describeError(error)}`);
        }
    }
    return { refs, problems };
}

/**
 * Runs the ATC flow for one of three targets and returns a formatted text report:
 *   transport  — validate transports → worklist → run → fetch findings (scoped to the transport delta)
 *   objects    — resolve names (packages included) → worklist → run → fetch findings
 *   worklist   — fetch an earlier run's findings only (no new run; this is what makes paging cheap)
 * Always resolves to a string result — SAP failures are rendered into the report text
 * (hasErrors=true) rather than thrown — so both the synchronous and background callers can present
 * or persist the outcome uniformly. Only truly unexpected errors propagate.
 */
async function runAtcCore(target: AtcTarget, checkVariantArg: string | undefined, scope: 'transport' | 'full', offset: number, limit: number): Promise<{ text: string; hasErrors: boolean; foundErrors: boolean }> {
    const baseUrl = String(await getBaseUrl());

    let worklistId = '';
    let checkVariant = checkVariantArg || '';
    let runInfos: string[] = [];
    let scanned: string[] = [];
    let missing: string[] = [];
    let valid: { transport: string; desc: string }[] = [];

    if (target.kind === 'worklist') {
        worklistId = target.worklistId;
        scanned = [`worklist ${worklistId} (re-read, no new run)`];
    } else {
        let refsXml: string;
        if (target.kind === 'transport') {
            // Validate each transport exists first — an invalid object reference in the ATC
            // run body is silently dropped (0 findings, no error), which would otherwise look
            // like a false "clean" result for a typo'd transport number.
            const checked = await Promise.all(target.transports.map(async (t) => ({ transport: t, desc: await validateTransport(baseUrl, t) })));
            valid = checked.filter(c => c.desc !== null) as { transport: string; desc: string }[];
            missing = checked.filter(c => c.desc === null).map(c => c.transport);
            if (valid.length === 0) {
                return { text: `None of the transport(s) could be found: ${missing.join(', ')}`, hasErrors: true, foundErrors: false };
            }
            scanned = [`Transports scanned: ${valid.map(v => `${v.transport}${v.desc ? ` (${v.desc})` : ''}`).join(', ')}`];
            refsXml = valid.map(v => `<adtcore:objectReference adtcore:uri="/sap/bc/adt/cts/transportrequests/${encodeURIComponent(v.transport)}"/>`).join('');
        } else {
            const { refs, problems } = await resolveAtcObjects(baseUrl, target.names);
            if (refs.length === 0) {
                return { text: `None of the object(s) could be resolved:\n${problems.map(p => `  ${p}`).join('\n')}`, hasErrors: true, foundErrors: false };
            }
            missing = problems;
            scanned = [`Objects scanned: ${refs.map(r => `${r.name} (${r.type})`).join(', ')}`];
            refsXml = refs.map(r => `<adtcore:objectReference adtcore:uri="${xmlAttr(r.uri)}"/>`).join('');
        }

        if (!checkVariant) checkVariant = await resolveDefaultCheckVariant(baseUrl);

        // 1. Create worklist
        try {
            const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/atc/worklists`, 'POST', 30000, undefined, { checkVariant });
            worklistId = String(response.data ?? '').trim();
            if (!worklistId) throw new Error('SAP returned an empty worklist id');
        } catch (error) {
            return { text: `Failed to create ATC worklist.\nReason: ${describeError(error)}`, hasErrors: true, foundErrors: false };
        }

        // 2. Run the check against all valid targets in one call
        const runBody =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<atc:run xmlns:atc="http://www.sap.com/adt/atc" maximumVerdicts="100">` +
            `<objectSets xmlns:adtcore="http://www.sap.com/adt/core">` +
            `<objectSet kind="inclusive"><adtcore:objectReferences>${refsXml}</adtcore:objectReferences></objectSet>` +
            `</objectSets></atc:run>`;
        try {
            const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/atc/runs`, 'POST', 120000, runBody, { worklistId }, { 'Content-Type': 'application/xml' });
            runInfos = parseRunInfos(typeof response.data === 'string' ? response.data : String(response.data ?? ''));
        } catch (error) {
            return { text: `ATC run failed (worklist ${worklistId}).\nReason: ${describeError(error)}`, hasErrors: true, foundErrors: false };
        }
    }

    // 3. Fetch findings
    let resultsXml: string;
    try {
        const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/atc/worklists/${encodeURIComponent(worklistId)}`, 'GET', 60000);
        resultsXml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error) {
        return { text: `Failed to fetch ATC findings of worklist ${worklistId}.\nReason: ${describeError(error)}`, hasErrors: true, foundErrors: false };
    }

    // HTTP 200 is not proof there is a worklist: an unknown id must not read as a clean run.
    // Live-verified 2026-10-15: SAP answers an unknown id with a valid EMPTY worklist whose id is
    // all zeros (no timestamp), while a real one echoes its own id — so compare the echoed id.
    const rootTag = resultsXml.match(/<[A-Za-z0-9]+:worklist\b[^>]*>/)?.[0] || '';
    const echoedId = rootTag.match(/\bid="([^"]*)"/)?.[1] || '';
    if (!rootTag || echoedId.toUpperCase() !== worklistId.toUpperCase()) {
        const snippet = resultsXml.replace(/\s+/g, ' ').trim().slice(0, 200);
        return { text: `Worklist ${worklistId} was not found or is not an ATC worklist (SAP answered: ${snippet || 'empty body'}). Worklists are short-lived; run ATC again to get a new one.`, hasErrors: true, foundErrors: false };
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
    const filtering = target.kind === 'transport' && scope === 'transport';
    if (filtering) {
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

    const text = formatReport({ scanned, missing, missingLabel: target.kind === 'objects' ? 'Objects NOT RESOLVED (skipped)' : 'Transports NOT FOUND (skipped)', checkVariant, worklistId, runInfos, objects: reportObjects, suppressed, filtering, offset, limit });
    // isError means the RUN failed (SAP refused, worklist missing, nothing resolved) — every such path
    // above returns hasErrors:true. A completed run with priority-1 findings is a successful tool call
    // whose answer is "FAIL"; flagging it isError made a normal result read like a tool failure
    // (the lifecycle test's fresh session mistook it for one). The verdict line carries the gate.
    return { text, hasErrors: false, foundErrors: reportObjects.some(o => o.findings.some(f => f.priority === 1)) };
}

function xmlAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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

interface ReportInput {
    scanned: string[];
    missing: string[];
    missingLabel: string;
    checkVariant: string;
    worklistId: string;
    runInfos: string[];
    objects: ObjectFindings[];
    suppressed: number;
    filtering: boolean;
    offset: number;
    limit: number;
}

function formatReport(r: ReportInput): string {
    const lines: string[] = [];
    lines.push(`ATC Check${r.checkVariant ? ` — variant: ${r.checkVariant}` : ''} — worklist: ${r.worklistId}`);
    lines.push(...r.scanned);
    if (r.missing.length) lines.push(`${r.missingLabel}: ${r.missing.join('; ')}`);
    if (r.runInfos.length) lines.push(...r.runInfos);
    if (r.filtering && r.suppressed > 0) {
        lines.push(`Scope: transport delta only — ${r.suppressed} finding(s) on other objects in the same compilation unit (e.g. sibling function modules) suppressed. Pass scope="full" to see everything.`);
    }

    let errors = 0, warnings = 0, notes = 0;
    for (const obj of r.objects) for (const f of obj.findings) {
        if (f.priority === 1) errors++;
        else if (f.priority === 2) warnings++;
        else notes++;
    }
    const total = errors + warnings + notes;
    lines.push(`Findings: ${errors} error(s), ${warnings} warning(s), ${notes} note(s)`);
    lines.push(errors > 0
        ? `Verdict: FAIL — ${errors} priority-1 (error) finding(s). The tool call itself succeeded.`
        : 'Verdict: PASS — no priority-1 (error) findings.');

    if (total === 0) {
        lines.push('', 'No findings.');
        return lines.join('\n');
    }

    // Flatten, sort by priority ACROSS objects (errors, then warnings, then notes; stable, so each
    // priority keeps SAP's object order), and window that list — so page 1 of a big package scan
    // holds its worst findings instead of the first object's notes. Display groups the window by
    // object. The window is taken after sorting, so a boundary never drops or repeats a row.
    const flat: { obj: ObjectFindings; f: Finding }[] = [];
    for (const obj of r.objects) for (const f of obj.findings) flat.push({ obj, f });
    flat.sort((x, y) => x.f.priority - y.f.priority);
    const windowed = flat.slice(r.offset, r.offset + r.limit);
    const shown = windowed.length;
    const order: ObjectFindings[] = [];
    const rowsByObj = new Map<ObjectFindings, string[]>();
    for (const { obj, f } of windowed) {
        if (!rowsByObj.has(obj)) { rowsByObj.set(obj, []); order.push(obj); }
        const loc = f.locationName && f.locationName !== obj.name ? `${f.locationName}:${f.line}:${f.col}` : `${f.line}:${f.col}`;
        rowsByObj.get(obj)!.push(`  [${PRIORITY_LABEL[f.priority] || f.priority}] ${loc}  ${f.messageTitle} (${f.checkTitle})`);
    }
    for (const obj of order) lines.push('', `${obj.name} (${obj.type}):`, ...rowsByObj.get(obj)!);
    if (shown < total) {
        const next = r.offset + r.limit;
        lines.push('', `(${total} total, showing ${shown} from offset ${r.offset}${next < total ? ` — next page: worklist_id="${r.worklistId}" offset=${next}, no new ATC run` : ''})`);
    }
    return lines.join('\n');
}
