import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl } from '../lib/utils';
import { handleGetProgram } from './handleGetProgram';
import { handleGetClass } from './handleGetClass';
import { handleGetInterface } from './handleGetInterface';
import { handleGetInclude } from './handleGetInclude';
import { handleGetTable } from './handleGetTable';
import { handleGetStructure } from './handleGetStructure';
import { handleGetFunction } from './handleGetFunction';
import { handleGetEnhancements } from './handleGetEnhancements';
import { handleGetDDICObject } from './handleGetDDICObject';
import { handleDataPreview } from './handleDataPreview';
import { suggestObjectNames, formatSuggestions } from '../lib/suggestNames';

type Kind = 'PROG' | 'CLAS' | 'INTF' | 'INCL' | 'TABL' | 'STRU' | 'VIEW' | 'FUGR' | 'FUNC' | 'DTEL' | 'DOMA' | 'CDS';

const KIND_DISPATCH: Record<Kind, (args: any, name: string) => Promise<any>> = {
    PROG: (a, name) => fetchProgramWithSymbols(name, normalizeTextElements(a?.text_elements)),
    CLAS: (a, name) => (a?.class_include && String(a.class_include).toLowerCase() !== 'main')
        ? fetchClassInclude(name, String(a.class_include).toLowerCase())
        : handleGetClass({ class_name: name }),
    INTF: (_a, name) => handleGetInterface({ interface_name: name }),
    INCL: (_a, name) => handleGetInclude({ include_name: name }),
    TABL: (_a, name) => handleGetTable({ table_name: name }),
    STRU: (_a, name) => handleGetStructure({ structure_name: name }),
    VIEW: (_a, name) => fetchClassicView(name),
    FUGR: (_a, name) => handleGetFunction({ function_group: name }),
    FUNC: (a, name) => handleGetFunction({ function_name: name, function_group: a?.function_group }),
    DTEL: (_a, name) => handleGetDDICObject({ object_type: 'DATA_ELEMENT', name }),
    DOMA: (_a, name) => handleGetDDICObject({ object_type: 'DOMAIN', name }),
    CDS:  (_a, name) => handleGetDDICObject({ object_type: 'CDS', name })
};

const ADT_TYPE_TO_KIND: Record<string, Kind> = {
    'PROG/P':  'PROG',
    'PROG/I':  'INCL',
    'FUGR/I':  'INCL',
    'CLAS/OC': 'CLAS',
    'INTF/OI': 'INTF',
    'TABL/DT': 'TABL',
    'TABL/DS': 'STRU',
    'VIEW/DV': 'VIEW',
    'VIEW/DM': 'VIEW',
    'VIEW/DH': 'VIEW',
    'VIEW/DK': 'VIEW',
    'FUGR/F':  'FUGR',
    'FUGR/FF': 'FUNC',
    'DTEL/DE': 'DTEL',
    'DOMA/DD': 'DOMA',
    'DDLS/DF': 'CDS',
    'DDLS/DV': 'CDS'
};

// text_elements: true (default) = source followed by its text symbols / selection texts / headings;
// false = source only (clean text to patch, diff or write back); 'only' = just the text elements
// (the blocks WriteProgram takes as text_symbols / selection_texts / list_headings).
type TextElementsMode = 'with' | 'none' | 'only';
function normalizeTextElements(v: any): TextElementsMode {
    if (v === false || String(v).toLowerCase() === 'false') return 'none';
    if (String(v).toLowerCase() === 'only') return 'only';
    return 'with';
}

// A class's LOCAL include (the part that is not the global class's main source) — the read-side twin of
// WriteProgram class_include. Source only, as stored: clean text to patch, diff or write back.
const LOCAL_CLASS_INCLUDES = ['definitions', 'implementations', 'macros', 'testclasses'];
async function fetchClassInclude(className: string, include: string): Promise<any> {
    if (!LOCAL_CLASS_INCLUDES.includes(include)) {
        throw new McpError(ErrorCode.InvalidParams, `class_include must be one of ${LOCAL_CLASS_INCLUDES.join(', ')} (omit it, or pass main, for the class's main source)`);
    }
    const baseUrl = String(await getBaseUrl());
    const url = `${baseUrl}/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}/includes/${include}`;
    try {
        const r = await makeAdtRequest(url, 'GET', 30000, undefined, undefined, { 'Accept': 'text/plain' });
        return { isError: false, content: [{ type: 'text', text: typeof r.data === 'string' ? r.data : String(r.data ?? '') }] };
    } catch (error: any) {
        if (error?.response?.status === 404) {
            return { isError: true, content: [{ type: 'text', text: `Class ${className} has no '${include}' include. Create it with WriteProgram class_include=${include}.` }] };
        }
        throw error;
    }
}

async function fetchProgramWithSymbols(name: string, mode: TextElementsMode = 'with'): Promise<any> {
    if (mode === 'none') return handleGetProgram({ program_name: name });
    const lower = name.toLowerCase();
    const baseUrl = String(await getBaseUrl());
    // SAP ADT's text-elements endpoints return master-language content only. They ignore
    // sap-language / Accept-Language / URL-prefix overrides. To inspect translations,
    // change the SAP login language or read REPOTEXT directly.
    const textElBase = `${baseUrl}/sap/bc/adt/textelements/programs/${encodeURIComponent(lower)}/source`;
    const fetchCategory = async (category: 'symbols' | 'selections' | 'headings', mime: string): Promise<string> => {
        try {
            const r = await makeAdtRequest(`${textElBase}/${category}`, 'GET', 15000, undefined, undefined, {
                'Accept': mime
            });
            return typeof r.data === 'string' ? r.data : String(r.data ?? '');
        } catch {
            return '';
        }
    };

    const [mainRes, symbolsTxt, selectionsTxt, headingsTxt] = await Promise.all([
        mode === 'only' ? Promise.resolve(undefined) : handleGetProgram({ program_name: name }),
        fetchCategory('symbols',    'application/vnd.sap.adt.textelements.symbols.v1'),
        fetchCategory('selections', 'application/vnd.sap.adt.textelements.selections.v1'),
        fetchCategory('headings',   'application/vnd.sap.adt.textelements.headings.v1')
    ]);

    const isMeaningfulHeadings = (t: string): boolean => {
        // Headings always returns a stub with empty values; only show if any line has content after '='
        return t.split('\n').some(l => /=\s*\S/.test(l));
    };

    if (mode === 'only') {
        // Bare blocks, in the exact format WriteProgram's text_symbols / selection_texts / list_headings
        // arguments take — no banner comments to strip.
        const blocks: string[] = [];
        if (symbolsTxt.trim())    blocks.push(`--- text_symbols ---\n${symbolsTxt.trim()}`);
        if (selectionsTxt.trim()) blocks.push(`--- selection_texts ---\n${selectionsTxt.trim()}`);
        if (isMeaningfulHeadings(headingsTxt)) blocks.push(`--- list_headings ---\n${headingsTxt.trim()}`);
        return { isError: false, content: [{ type: 'text', text: blocks.length ? blocks.join('\n\n') : `Program '${name}' has no text elements.` }] };
    }

    const parts: string[] = [String((mainRes?.content?.[0] as any)?.text || '')];
    if (symbolsTxt.trim())     parts.push(`\n* ─── Text Symbols (TEXT-XXX, master language) ───\n${symbolsTxt.trim()}`);
    if (selectionsTxt.trim())  parts.push(`\n* ─── Selection Texts (master language) ───\n${selectionsTxt.trim()}`);
    if (isMeaningfulHeadings(headingsTxt)) parts.push(`\n* ─── List Headings (master language) ───\n${headingsTxt.trim()}`);

    return {
        isError: mainRes?.isError || false,
        content: [{ type: 'text', text: parts.join('\n') }]
    };
}

async function fetchClassicView(name: string): Promise<any> {
    // Classic SE11 views have no ADT source — they're defined as rows in DD25L / DD26S / DD27S.
    // Reconstruct a readable definition from those tables in parallel.
    const upper = name.toUpperCase();
    const [hdrRes, tblRes, fldRes] = await Promise.all([
        handleDataPreview({ query: `SELECT VIEWNAME, VIEWCLASS, ROOTTAB, VIEWGRANT, MASTERLANG FROM DD25L WHERE VIEWNAME = '${upper}' AND AS4LOCAL = 'A'`, max_rows: 1 }),
        handleDataPreview({ query: `SELECT TABNAME, TABPOS FROM DD26S WHERE VIEWNAME = '${upper}' AND AS4LOCAL = 'A' ORDER BY TABPOS`, max_rows: 50 }),
        handleDataPreview({ query: `SELECT OBJPOS, VIEWFIELD, TABNAME, FIELDNAME, KEYFLAG, ROLLNAME FROM DD27S WHERE VIEWNAME = '${upper}' AND AS4LOCAL = 'A' ORDER BY OBJPOS`, max_rows: 500 })
    ]);

    const stripDataPreviewChrome = (text: string): string => {
        return text
            .split('\n')
            .filter(l => !/^Table:\s/.test(l) && !/^\[Freestyle SQL/.test(l))
            .join('\n')
            .replace(/^\s*\n/, '')
            .replace(/\n\s*\n\s*$/, '\n');
    };

    const hdrText = stripDataPreviewChrome(String((hdrRes?.content?.[0] as any)?.text || ''));
    const tblText = stripDataPreviewChrome(String((tblRes?.content?.[0] as any)?.text || ''));
    const fldText = stripDataPreviewChrome(String((fldRes?.content?.[0] as any)?.text || ''));

    if (!hdrText || /^\s*$/.test(hdrText)) {
        return {
            isError: true,
            content: [{ type: 'text', text: `View '${name}' not found in DD25L (classic view header table).` }]
        };
    }

    const lines: string[] = [];
    lines.push(`-- SE11 view ${name} (rebuilt from DD25L/DD26S/DD27S)`);
    lines.push('');
    lines.push('header:');
    lines.push(hdrText.trim());
    lines.push('');
    lines.push('base tables:');
    lines.push(tblText.trim());
    lines.push('');
    lines.push('fields:');
    lines.push(fldText.trim());

    return { isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
}

export async function handleGetObject(args: any) {
    try {
        if (!args?.object_name) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name is required');
        }
        const name = String(args.object_name).toUpperCase();
        const hint = args?.kind ? String(args.kind).toUpperCase() as Kind : undefined;

        let kind: Kind | undefined = hint && KIND_DISPATCH[hint] ? hint : undefined;
        let foundType: string | null = null;
        if (!kind) {
            foundType = await resolveAdtType(name);
            if (foundType) kind = ADT_TYPE_TO_KIND[foundType];
        }
        if (!kind && !foundType) {
            // Search returned no match — object may still exist but be invisible to quickSearch
            // (e.g. SAP-standard DDIC like BAPI_TE_AUFKX). Probe 4 DDIC endpoints in parallel.
            kind = await probeDirectKind(name);
            if (!kind) {
                // Resolution has already failed — spend up to 3 more searches looking for a
                // near-miss (usually a wrong word-split in a standard name). Silent when
                // nothing scores well, so the plain message is never padded with noise.
                const hint = formatSuggestions(await suggestObjectNames(name));
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Object '${name}' not found in SAP system.${hint}` }]
                };
            }
        }
        if (!kind) {
            // An enhancement implementation is source too: serve it instead of refusing. Plan-eval
            // runs read "kind is not supported … use a more specific tool" as "ENHO source cannot
            // be read" and diagnosed around the enhancement (2026-10-19).
            if (String(foundType).toUpperCase().startsWith('ENHO')) {
                return await handleGetEnhancements({ object_name: name, with_source: true });
            }
            return {
                isError: true,
                content: [{ type: 'text', text: unsupportedKindMessage(name, String(foundType)) }]
            };
        }
        if (args?.class_include && kind !== 'CLAS' && String(args.class_include).toLowerCase() !== 'main') {
            throw new McpError(ErrorCode.InvalidParams, `class_include is only valid for a class ('${name}' is ${kind}).`);
        }
        return await KIND_DISPATCH[kind](args, name);
    } catch (error) {
        return return_error(error);
    }
}

// Where to read an object type GetCode OBJECT does not serve (named, so the caller does not conclude
// the object is unreadable).
const READ_ELSEWHERE: Record<string, string> = {
    DEVC: 'a package: GetMeta resource=PACKAGE package_name=<name>',
    MSAG: 'a message class: GetMeta resource=MESSAGE_CLASS message_class=<name>',
    TRAN: 'a transaction: GetMeta resource=TRANSACTION transaction_name=<name>',
    ENHS: 'an enhancement spot: GetCode resource=ENHANCEMENTS object_name=<name>',
    SUSO: 'an authorization object: DataPreview on TOBJ (fields) / TACTZ (activities); ManageObject resource=AUTH_OBJECT maintains it',
    WAPA: 'a BSP/UI5 web application: not readable through this gateway (its OData service is a separate object)',
    SICF: 'an ICF service node: not readable through this gateway',
};

/** Pure: the refusal text for a found but unsupported type, naming the tool that does read it. */
export function unsupportedKindMessage(name: string, foundType: string): string {
    const where = READ_ELSEWHERE[foundType.split('/')[0].toUpperCase()];
    return where
        ? `'${name}' is ${where.replace(/<name>/g, name)}. (GetCode OBJECT reads source-bearing objects only; type ${foundType}.)`
        : `Found '${name}' (type ${foundType}) but GetCode OBJECT does not read this type. Pass kind=PROG|CLAS|INTF|INCL|TABL|STRU|VIEW|FUGR|FUNC|DTEL|DOMA|CDS to bypass auto-detect if it is one of those.`;
}

// Returns the ADT type string (e.g. "DTEL/DE") for `objectName`, or null if search has no exact match.
async function resolveAdtType(objectName: string): Promise<string | null> {
    return (await searchOnce(objectName)) || (await searchOnce(objectName + '*'));
}

async function searchOnce(query: string): Promise<string | null> {
    try {
        const baseUrl = String(await getBaseUrl());
        const searchUrl = `${baseUrl}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}&maxResults=20`;
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

        const exactTarget = query.replace(/\*$/, '').toUpperCase();
        let firstMatch: string | null = null;
        for (const ref of refs) {
            const attrs = ref._attributes || {};
            const getAttr = (ln: string): string => {
                const k = Object.keys(attrs).find((x: string) => x === ln || x.endsWith(':' + ln));
                return k ? String(attrs[k] || '') : '';
            };
            const name = getAttr('name').toUpperCase();
            const type = getAttr('type').toUpperCase();
            if (name === exactTarget) {
                // Prefer DTEL over DOMA on collision (data elements are the more common ask)
                if (type === 'DTEL/DE') return type;
                if (!firstMatch) firstMatch = type;
            }
        }
        return firstMatch;
    } catch {
        return null;
    }
}

async function probeDirectKind(objectName: string): Promise<Kind | undefined> {
    const baseUrl = String(await getBaseUrl());
    const probes: { kind: Kind; url: string }[] = [
        { kind: 'STRU', url: `${baseUrl}/sap/bc/adt/ddic/structures/${encodeURIComponent(objectName)}` },
        { kind: 'TABL', url: `${baseUrl}/sap/bc/adt/ddic/tables/${encodeURIComponent(objectName)}` },
        { kind: 'DTEL', url: `${baseUrl}/sap/bc/adt/ddic/dataelements/${encodeURIComponent(objectName)}` },
        { kind: 'DOMA', url: `${baseUrl}/sap/bc/adt/ddic/domains/${encodeURIComponent(objectName)}` }
    ];
    const results = await Promise.all(probes.map(async p => {
        try {
            await makeAdtRequest(p.url, 'GET', 5000);
            return p.kind;
        } catch {
            return null;
        }
    }));
    return results.find(k => k !== null) || undefined;
}
