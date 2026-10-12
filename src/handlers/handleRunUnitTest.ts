import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml } from '../lib/utils';
import { AxiosError } from 'axios';
import { maybeBackground } from '../lib/background';

const RISK_LEVELS = ['harmless', 'dangerous', 'critical'] as const;
const DURATIONS = ['short', 'medium', 'long'] as const;
type RiskLevel = typeof RISK_LEVELS[number];
type Duration = typeof DURATIONS[number];

interface Alert {
    kind: string;       // exception | failedAssertion | warning
    severity: string;   // critical | fatal | tolerable | tolerant
    title: string;
    details: string[];
    line: string;
}

interface TestMethod {
    name: string;
    executionTime: string;
    unit: string;
    alerts: Alert[];
}

interface TestClass {
    name: string;
    riskLevel: string;
    durationCategory: string;
    methods: TestMethod[];
}

export async function handleRunUnitTest(args: any) {
    try {
        if (!args?.object_name) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }
        const objectName = String(args.object_name).toUpperCase();
        const riskLevels = normalizeChoices(args?.risk_levels, RISK_LEVELS, ['harmless']);
        const durations = normalizeChoices(args?.durations, DURATIONS, ['short']);
        const slug = `unittest-${objectName}`;

        return await maybeBackground(args, `ABAP Unit run for ${objectName}`, slug, async () => {
            const { text, hasErrors } = await runUnitTestCore(objectName, riskLevels, durations);
            return { isError: hasErrors, content: [{ type: 'text', text }] };
        });
    } catch (error) {
        return return_error(error);
    }
}

async function runUnitTestCore(
    objectName: string,
    riskLevels: RiskLevel[],
    durations: Duration[]
): Promise<{ text: string; hasErrors: boolean }> {
    const baseUrl = String(await getBaseUrl());

    // A bad/nonexistent object reference in the run body is silently dropped by SAP
    // (empty <aunit:runResult/>, HTTP 200, no error) — verified live. Resolve and
    // validate first so "object not found" isn't misreported as "no tests found".
    const resolved = await resolveUri(baseUrl, objectName);
    if (!resolved) {
        return { text: `Object not found: ${objectName}`, hasErrors: true };
    }

    const flags = {
        harmless: riskLevels.includes('harmless'),
        dangerous: riskLevels.includes('dangerous'),
        critical: riskLevels.includes('critical'),
        short: durations.includes('short'),
        medium: durations.includes('medium'),
        long: durations.includes('long')
    };

    const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">` +
        `<external><coverage active="false"/></external>` +
        `<options>` +
        `<uriType value="semantic"/>` +
        `<testDeterminationStrategy sameProgram="true" assignedTests="false"/>` +
        `<testRiskLevels harmless="${flags.harmless}" dangerous="${flags.dangerous}" critical="${flags.critical}"/>` +
        `<testDurations short="${flags.short}" medium="${flags.medium}" long="${flags.long}"/>` +
        `<withNavigationUri enabled="true"/>` +
        `</options>` +
        `<adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<objectSet kind="inclusive"><adtcore:objectReferences>` +
        `<adtcore:objectReference adtcore:uri="${escapeXml(resolved.uri)}"/>` +
        `</adtcore:objectReferences></objectSet>` +
        `</adtcore:objectSets>` +
        `</aunit:runConfiguration>`;

    let xml: string;
    try {
        const response = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/abapunit/testruns`, 'POST', 60000, body, undefined,
            { 'Content-Type': 'application/*', 'Accept': 'application/*' }
        );
        xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error) {
        return { text: `ABAP Unit run failed for ${objectName} (${resolved.type}).\nReason: ${describeError(error)}`, hasErrors: true };
    }

    const classes = parseRunResult(xml);
    const text = formatReport(objectName, resolved.type, riskLevels, durations, classes);
    const hasErrors = classes.some(c => c.methods.some(m =>
        m.alerts.some(a => a.kind === 'failedAssertion' || a.kind === 'exception')
    ));
    return { text, hasErrors };
}

function normalizeChoices<T extends string>(raw: any, valid: readonly T[], fallback: T[]): T[] {
    if (!Array.isArray(raw) || raw.length === 0) return fallback;
    const picked = raw.map((v: any) => String(v).toLowerCase()).filter((v: string) => (valid as readonly string[]).includes(v)) as T[];
    return picked.length > 0 ? [...new Set(picked)] : fallback;
}

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

async function resolveUri(baseUrl: string, name: string): Promise<{ uri: string; type: string } | null> {
    try {
        const searchUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(name)}&maxResults=20`;
        const response = await makeAdtRequest(searchUrl, 'GET', 15000);
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

// Response shape verified live against /sap/bc/adt/abapunit/testruns:
//   <aunit:runResult/>                                        → no tests / object not in run
//   <aunit:runResult><program><testClasses><testClass>...      → normal result
// A testMethod with no <alerts> passed; alerts carry kind/severity/title/details/stack.
function parseRunResult(xml: string): TestClass[] {
    try {
        const convert = require('xml-js');
        const parsed = convert.xml2js(xml, { compact: true }) as any;
        const runResult = parsed['aunit:runResult'];
        const program = runResult?.program;
        if (!program) return [];
        const testClassesNode = program.testClasses;
        if (!testClassesNode) return [];
        const rawClasses = testClassesNode.testClass;
        if (!rawClasses) return [];
        const classArr = Array.isArray(rawClasses) ? rawClasses : [rawClasses];

        return classArr.map((c: any) => {
            const cAttrs = c._attributes || {};
            const rawMethods = c.testMethods?.testMethod;
            const methodArr = rawMethods ? (Array.isArray(rawMethods) ? rawMethods : [rawMethods]) : [];
            const methods: TestMethod[] = methodArr.map((m: any) => {
                const mAttrs = m._attributes || {};
                const rawAlerts = m.alerts?.alert;
                const alertArr = rawAlerts ? (Array.isArray(rawAlerts) ? rawAlerts : [rawAlerts]) : [];
                const alerts: Alert[] = alertArr.map((a: any) => parseAlert(a));
                return {
                    name: mAttrs['adtcore:name'] || '',
                    executionTime: mAttrs['executionTime'] || '0',
                    unit: mAttrs['unit'] || '',
                    alerts
                };
            });
            return {
                name: cAttrs['adtcore:name'] || '',
                riskLevel: cAttrs['riskLevel'] || '',
                durationCategory: cAttrs['durationCategory'] || '',
                methods
            };
        });
    } catch {
        return [];
    }
}

function parseAlert(a: any): Alert {
    const attrs = a._attributes || {};
    const title = a.title?._text || '';
    const details = flattenDetails(a.details);
    const rawStack = a.stack?.stackEntry;
    const stackArr = rawStack ? (Array.isArray(rawStack) ? rawStack : [rawStack]) : [];
    const firstStack = stackArr[0]?._attributes || {};
    const uriFrag = firstStack['adtcore:uri'] || '';
    const lineMatch = uriFrag.match(/#start=(\d+)/);
    return {
        kind: attrs['kind'] || '',
        severity: attrs['severity'] || '',
        title,
        details,
        line: lineMatch ? lineMatch[1] : ''
    };
}

// <details><detail text="..."><details><detail text="..."/></details></detail></details>
// nests arbitrarily; flatten depth-first into readable lines.
function flattenDetails(node: any): string[] {
    if (!node?.detail) return [];
    const items = Array.isArray(node.detail) ? node.detail : [node.detail];
    const out: string[] = [];
    for (const d of items) {
        const text = d._attributes?.text || '';
        if (text) out.push(text);
        out.push(...flattenDetails(d.details).map((s: string) => `  ${s}`));
    }
    return out;
}

function formatReport(
    objectName: string,
    objectType: string,
    riskLevels: RiskLevel[],
    durations: Duration[],
    classes: TestClass[]
): string {
    const lines: string[] = [];
    lines.push(`ABAP Unit — ${objectName} (${objectType})`);
    lines.push(`Risk levels: ${riskLevels.join(', ')} | Durations: ${durations.join(', ')}`);

    const allMethods = classes.flatMap(c => c.methods);
    if (allMethods.length === 0) {
        lines.push('', `No test methods found (either the object has no ABAP Unit tests, or none match the selected risk levels / durations).`);
        return lines.join('\n');
    }

    let passed = 0, failed = 0, warned = 0;
    for (const m of allMethods) {
        const hasFail = m.alerts.some(a => a.kind === 'failedAssertion' || a.kind === 'exception');
        const hasWarn = m.alerts.some(a => a.kind === 'warning');
        if (hasFail) failed++;
        else if (hasWarn) warned++;
        else passed++;
    }
    lines.push(`Methods: ${allMethods.length} total — ${passed} passed, ${failed} failed, ${warned} warning(s)`);

    for (const c of classes) {
        if (c.methods.length === 0) continue;
        lines.push('', `${c.name} (risk: ${c.riskLevel}, duration: ${c.durationCategory}):`);
        for (const m of c.methods) {
            const hasFail = m.alerts.some(a => a.kind === 'failedAssertion' || a.kind === 'exception');
            const hasWarn = m.alerts.some(a => a.kind === 'warning');
            const status = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
            lines.push(`  [${status}] ${m.name}  (${m.executionTime}${m.unit})`);
            for (const a of m.alerts) {
                lines.push(`      ${a.title}`);
                for (const d of a.details) lines.push(`        ${d}`);
                if (a.line) lines.push(`        at line ${a.line}`);
            }
        }
    }
    return lines.join('\n');
}
