import { makeAdtRequest } from './utils';

// Resolves an object name to its ADT URI via quickSearch, regardless of object type — shared by
// UnlockObject and DeleteObject, because a stray lock (or a deletion) can concern any lockable
// repository object, not just the ones WriteProgram knows how to create.
//
// Names are not unique across types: RSPARAM is both a program (PROG/P) and a structure
// (TABL/DS). The first exact name match used to win, so UnlockObject('RSPARAM') checked the
// structure and reported "clear" while the program stayed locked (2026-10-07) — and DeleteObject
// shared the same logic. Now an ambiguous name is refused with the candidates listed, and the
// caller picks one with `objectType` (a group such as PROG/CLAS/TABL, or an exact subtype such
// as PROG/P or TABL/DS).

export type ResolveResult = { uri: string; type: string } | { error: string };

// Short names the tool descriptions use (and people type) that are not ADT type prefixes: the
// resolver compares against the quickSearch type (PROG/I, FUGR/FF, ...), so INCL silently matched
// nothing and an include could only be found without a type. Expanded to the exact ADT subtype(s).
// INCL covers both include kinds: a function group's include (LZIFF09F01) is FUGR/I, not PROG/I —
// `GetMeta TRANSPORT type_hint=INCL` reported it "not found" (OpenCode plan eval, 2026-10-19).
const TYPE_ALIASES: Record<string, string | string[]> = {
    INCL: ['PROG/I', 'FUGR/I'],
    FUNC: 'FUGR/FF',
    DTEL: 'DTEL/DE',
    DOMA: 'DOMA/DD',
    DDLS: 'DDLS/DF',
    CDS: 'DDLS/DF',
    STRU: 'TABL/DS',
    STRUCTURE: 'TABL/DS',
};

export async function resolveAnyObject(baseUrl: string, name: string, objectType?: string): Promise<ResolveResult> {
    const url = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(name)}&maxResults=50`;
    const response = await makeAdtRequest(url, 'GET', 15000);
    const xmlData = typeof response.data === 'string' ? response.data : String(response.data ?? '');

    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const rootKey = Object.keys(parsed).find((k: string) => !k.startsWith('_'));
    const root = rootKey ? parsed[rootKey] : {};
    const refKey = Object.keys(root || {}).find((k: string) => k.endsWith(':objectReference') || k === 'objectReference');
    const rawRefs = refKey ? root[refKey] : [];
    const refs = Array.isArray(rawRefs) ? rawRefs : [rawRefs];

    const getAttr = (attrs: any, localName: string): string => {
        const key = Object.keys(attrs).find((k: string) => k === localName || k.endsWith(':' + localName));
        return key ? String(attrs[key] || '') : '';
    };

    const rawHint = objectType ? objectType.toUpperCase().trim() : '';
    const alias = TYPE_ALIASES[rawHint] ?? rawHint;
    const hints = Array.isArray(alias) ? alias : alias ? [alias] : [];
    const hint = hints.join(' or ');
    const matches: { uri: string; type: string }[] = [];
    for (const ref of refs) {
        const attrs = ref?._attributes || {};
        const uri = getAttr(attrs, 'uri');
        const type = getAttr(attrs, 'type').toUpperCase();
        if (getAttr(attrs, 'name').toUpperCase() !== name || !uri) continue;
        if (hints.length && !hints.some(h => type === h || type.startsWith(h + '/'))) continue;
        if (!matches.some(m => m.uri === uri)) matches.push({ uri, type });
    }

    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
        return { error: `Object '${name}' not found (search returned no exact match${hint ? ` of type ${hint}` : ''}).` };
    }
    return {
        error: `'${name}' matches ${matches.length} objects${hint ? ` of type ${hint}` : ''} — pass object_type to choose one (nothing was done):\n` +
            matches.map(m => `  - ${m.type.padEnd(8)} ${m.uri}`).join('\n')
    };
}
