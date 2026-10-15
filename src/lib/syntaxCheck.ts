import { makeAdtRequest } from './utils';

// ADT syntax check of NEW source against an existing object, without locking or writing.
//
//   POST /sap/bc/adt/checkruns?reporters=abapCheckRun
//   Content-Type: application/vnd.sap.adt.checkobjects+xml
//
// The new source travels inline (base64) as the object's /source/main artifact with
// chkrun:version="inactive", so SAP checks the text we send, not what is stored. Stateless —
// no lock, no session — which is what lets WriteProgram refuse a bad edit before spending a
// lock → PUT → unlock → activate cycle on it.

const escapeXml = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface SyntaxMessage {
    type: string;      // E / W / I
    line: number | null;
    column: number | null;
    text: string;
    // The source unit the line belongs to, from the message's own uri (…/includes/zfoo/source/main#start=8,10).
    // Under a master program a message can sit in the master or another include, not the one checked —
    // "line 8:10" for a 3-line include was unreadable (lifecycle test 2).
    unit?: string;
}

// '/sap/bc/adt/programs/includes/zfoo/source/main#start=8,10' -> 'ZFOO';
// '/sap/bc/adt/oo/classes/zcl_x/includes/testclasses#start=3,1' -> 'ZCL_X (testclasses)'
export function unitFromUri(uri: string): string | undefined {
    const path = uri.split('#')[0].replace(/\/source\/main\/?$/, '');
    const cls = path.match(/\/oo\/classes\/([^/]+)(?:\/includes\/([^/]+))?$/i);
    if (cls) return decodeURIComponent(cls[1]).toUpperCase() + (cls[2] && cls[2].toLowerCase() !== 'main' ? ` (${cls[2].toLowerCase()})` : '');
    const m = path.match(/\/(?:programs\/(?:programs|includes)|functions\/groups\/[^/]+\/(?:includes|fmodules)|oo\/interfaces)\/([^/]+)$/i);
    return m ? decodeURIComponent(m[1]).toUpperCase() : undefined;
}

export interface SyntaxCheckResult {
    messages: SyntaxMessage[];
    errors: number;
    warnings: number;
    // Set for an include: the master program the check ran under, or '' when none is known and the
    // include was checked on its own (then a missing declaration shows up as a false error, and a
    // type error against the master's context can be missed — see checkSourceInContext).
    context?: string;
    // upper-case name of the object whose source was sent (derived from its uri)
    checked?: string;
}

// artifactUri: which part of the object the inline text replaces. Default `${objectUri}/source/main`; for
// a class's local include pass `${classUri}/includes/testclasses` (…/definitions, /implementations,
// /macros) — the class is checked WITH the new include text in place of the stored one.
export async function runSyntaxCheck(baseUrl: string, objectUri: string, sourceCode: string, mainUri?: string, artifactUri?: string): Promise<SyntaxCheckResult> {
    const sourceUri = artifactUri ?? `${objectUri}/source/main`;
    // ADT checks an include in its master program's context when the object URI carries
    // ?context=<master uri> (what Eclipse sends); without it the include is compiled alone.
    const checkUri = mainUri ? `${objectUri}?context=${encodeURIComponent(mainUri)}` : objectUri;
    const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<chkrun:checkObject adtcore:uri="${escapeXml(checkUri)}" chkrun:version="inactive">` +
        `<chkrun:artifacts><chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${escapeXml(sourceUri)}">` +
        `<chkrun:content>${Buffer.from(sourceCode, 'utf8').toString('base64')}</chkrun:content>` +
        `</chkrun:artifact></chkrun:artifacts></chkrun:checkObject></chkrun:checkObjectList>`;

    const response = await makeAdtRequest(
        `${baseUrl}/sap/bc/adt/checkruns`, 'POST', 30000, body,
        { reporters: 'abapCheckRun' },
        {
            'Content-Type': 'application/vnd.sap.adt.checkobjects+xml',
            'Accept': 'application/vnd.sap.adt.checkmessages+xml'
        }
    );
    const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    return parseCheckMessages(xml);
}

// An include's master program, from the include's own metadata (include:contextRef). The ADT
// stores one per include; it is filled as soon as any program's source has `INCLUDE <name>.`.
export async function resolveMasterProgram(baseUrl: string, includeUri: string): Promise<string | null> {
    if (!/\/programs\/includes\//i.test(includeUri)) return null;
    try {
        const r = await makeAdtRequest(`${baseUrl}${includeUri}`, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        const xml = typeof r.data === 'string' ? r.data : String(r.data ?? '');
        return xml.match(/<[\w:]*contextRef\b[^>]*?\buri="([^"]+)"/i)?.[1] ?? null;
    } catch {
        return null;
    }
}

// The one entry point callers should use: a plain object is checked as before; an include is checked
// under its master program when it has one. Checking an include alone is NOT equivalent — a type
// error against a master-declared FORM/type passed the standalone check and was only caught when the
// main program was checked afterwards (lifecycle test 2026-10-15).
export async function checkSourceInContext(baseUrl: string, objectUri: string, sourceCode: string): Promise<SyntaxCheckResult> {
    const isInclude = /\/programs\/includes\//i.test(objectUri);
    const master = isInclude ? await resolveMasterProgram(baseUrl, objectUri) : null;
    const result = await runSyntaxCheck(baseUrl, objectUri, sourceCode, master || undefined);
    if (isInclude) result.context = master || '';
    result.checked = unitFromUri(objectUri);
    return result;
}

export function parseCheckMessages(xml: string): SyntaxCheckResult {
    const convert = require('xml-js');
    const parsed = convert.xml2js(xml, { compact: true }) as any;
    const messages: SyntaxMessage[] = [];

    // (unit names are only shown when they differ from the checked object — see formatSyntaxMessages)
    // Namespaced keys vary by prefix — walk the tree and collect every *checkMessage node.
    const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
            if (key === '_attributes' || key === '_text') continue;
            const child = node[key];
            if (key === 'checkMessage' || key.endsWith(':checkMessage')) {
                for (const m of Array.isArray(child) ? child : [child]) {
                    const attrs = m?._attributes || {};
                    const attr = (n: string) => {
                        const k = Object.keys(attrs).find(a => a === n || a.endsWith(':' + n));
                        return k ? String(attrs[k]) : '';
                    };
                    const pos = attr('uri').match(/#start=(\d+)(?:,(\d+))?/);
                    messages.push({
                        type: attr('type').toUpperCase(),
                        line: pos ? Number(pos[1]) : null,
                        column: pos && pos[2] ? Number(pos[2]) : null,
                        text: attr('shortText'),
                        unit: unitFromUri(attr('uri'))
                    });
                }
            } else {
                for (const c of Array.isArray(child) ? child : [child]) walk(c);
            }
        }
    };
    walk(parsed);

    return {
        messages,
        errors: messages.filter(m => m.type === 'E' || m.type === 'A' || m.type === 'X').length,
        warnings: messages.filter(m => m.type === 'W').length
    };
}

export function formatSyntaxMessages(r: SyntaxCheckResult, maxLines = 20): string {
    const ctx = r.context === undefined ? '' : r.context
        ? ` [include checked in the context of master program ${r.context.split('/').pop()?.toUpperCase()}]`
        : ' [include checked ALONE — no master program known, so this can miss errors against the master\'s declarations (and flag false ones); check the main program too]';
    if (r.messages.length === 0) return `Syntax check: no messages.${ctx}`;
    const shown = [...r.messages].sort((a, b) => (a.type === 'E' ? 0 : 1) - (b.type === 'E' ? 0 : 1)).slice(0, maxLines);
    const checked = (r.checked || '').toUpperCase();
    const lines = shown.map(m => {
        // name the unit when the message is not in the object that was checked (an include checked under
        // its master reports positions in whichever unit the finding sits in)
        const where = m.unit && m.unit !== checked ? `${m.unit} ` : '';
        return `  ${m.type || '?'} ${where}${m.line !== null ? `line ${m.line}${m.column !== null ? `:${m.column}` : ''}` : 'n/a'} — ${m.text}`;
    });
    const more = r.messages.length > shown.length ? `\n  … ${r.messages.length - shown.length} more` : '';
    return `Syntax check: ${r.errors} error(s), ${r.warnings} warning(s)${ctx}\n${lines.join('\n')}${more}`;
}


// ── Locating activation messages ─────────────────────────────────────────────────────────
// SAP's activation answer carries a `line` attribute that is not the real line ("Line 1", "Line 2"
// for findings that sit at 1693 and 2846 — lifecycle test 2026-10-15). The syntax check reports
// the same findings with their true line:col, so match each activation message to a check message
// by text and say where it really is. Best effort: an unmatched message is left as SAP gave it.

export interface ActivationMsg {
    type: string;   // E / W / I
    object: string; // objDescr as SAP gave it (used to pick the check target)
    text: string;
}

const normText = (s: string) => s.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();

function sameMessage(a: string, b: string): boolean {
    const x = normText(a), y = normText(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const n = Math.min(40, x.length, y.length);
    return n >= 20 && x.slice(0, n) === y.slice(0, n);
}

/** One entry per activation message: ' → syntax check: line L:C' when located, '' otherwise. */
export async function locateActivationMessages(
    baseUrl: string,
    targets: { name: string; uri: string }[],
    msgs: ActivationMsg[]
): Promise<string[]> {
    const out: string[] = msgs.map(() => '');
    if (msgs.length === 0 || targets.length === 0) return out;
    // Only check the objects some message points at (or the single target when SAP names none).
    const wanted = new Set<number>();
    msgs.forEach(m => {
        const idx = targets.findIndex(t => m.object && m.object.toUpperCase().includes(t.name.toUpperCase()));
        if (idx >= 0) wanted.add(idx);
    });
    if (wanted.size === 0) targets.forEach((_t, i) => wanted.add(i));
    const found: { targetIdx: number; msgs: SyntaxMessage[] }[] = [];
    for (const i of wanted) {
        try {
            const r = await makeAdtRequest(`${baseUrl}${targets[i].uri}/source/main`, 'GET', 30000, undefined, undefined, { 'Accept': 'text/plain' });
            const src = typeof r.data === 'string' ? r.data : String(r.data ?? '');
            const res = await checkSourceInContext(baseUrl, targets[i].uri, src);
            found.push({ targetIdx: i, msgs: res.messages });
        } catch { /* best effort */ }
    }
    msgs.forEach((m, k) => {
        const named = targets.findIndex(t => m.object && m.object.toUpperCase().includes(t.name.toUpperCase()));
        const pool = found.filter(f => named < 0 || f.targetIdx === named).flatMap(f => f.msgs);
        const hit = pool.find(c => (!m.type || !c.type || c.type === m.type.toUpperCase()) && sameMessage(m.text, c.text))
                 ?? pool.find(c => sameMessage(m.text, c.text));
        if (hit && hit.line !== null) out[k] = ` → real position per syntax check: line ${hit.line}${hit.column !== null ? ':' + hit.column : ''}`;
    });
    return out;
}
