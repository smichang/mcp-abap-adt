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
}

export interface SyntaxCheckResult {
    messages: SyntaxMessage[];
    errors: number;
    warnings: number;
}

export async function runSyntaxCheck(baseUrl: string, objectUri: string, sourceCode: string): Promise<SyntaxCheckResult> {
    const sourceUri = `${objectUri}/source/main`;
    const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<chkrun:checkObject adtcore:uri="${escapeXml(objectUri)}" chkrun:version="inactive">` +
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

export function parseCheckMessages(xml: string): SyntaxCheckResult {
    const convert = require('xml-js');
    const parsed = convert.xml2js(xml, { compact: true }) as any;
    const messages: SyntaxMessage[] = [];

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
                        text: attr('shortText')
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
    if (r.messages.length === 0) return 'Syntax check: no messages.';
    const shown = [...r.messages].sort((a, b) => (a.type === 'E' ? 0 : 1) - (b.type === 'E' ? 0 : 1)).slice(0, maxLines);
    const lines = shown.map(m => `  ${m.type || '?'} ${m.line !== null ? `line ${m.line}${m.column !== null ? `:${m.column}` : ''}` : 'n/a'} — ${m.text}`);
    const more = r.messages.length > shown.length ? `\n  … ${r.messages.length - shown.length} more` : '';
    return `Syntax check: ${r.errors} error(s), ${r.warnings} warning(s)\n${lines.join('\n')}${more}`;
}
