import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, getBaseUrl } from '../lib/utils';

// Language-dependent texts of a classic screen (what SE63 does for a Dynpro),
// through ZCL_HTTP_MCP_DYNPRO_TRANSL (package ZMCP), the standalone SICF service
// default_host/zmcp/dynpro_transl. Not part of ADT. The ABAP side uses the
// LXE translation environment SE63 itself uses (object type SCRT): it writes
// the target-language rows of D021T and a translation-log entry, and never
// touches the screen's master-language definition — which is exactly what
// ManageDynpro update would do with translated text.
// Plan: plan/20261016-dynpro-translation-endpoint.md.

export interface TranslationText { element: string; text: string; }

interface ListedElement { element: string; source_text: string; target_text: string; max_length: number; }
interface Listing {
    program: string; dynnr: string;
    source_language: string; target_language: string; target_iso: string;
    elements: ListedElement[];
}

const MAX_TEXTS = 200;

function endpoint(baseUrl: string): string {
    return `${baseUrl}/zmcp/dynpro_transl`;
}

function checkLanguage(language: string): string {
    const l = language.trim();
    if (!l) {
        throw new McpError(ErrorCode.InvalidParams, 'language is required: the target language as SAP key (M), ISO code (ZF) or LXE code (zhTW)');
    }
    if (l.length > 4) {
        throw new McpError(ErrorCode.InvalidParams, `language "${l}" is not valid — use the SAP key (M), ISO code (ZF) or LXE code (zhTW)`);
    }
    return l;
}

// translations: { "ELEMENT": "text", ... } or [{ element, text }, ...], also as a JSON string.
export function normalizeTexts(raw: any): TranslationText[] {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (e: any) {
            throw new McpError(ErrorCode.InvalidParams, `translations is not valid JSON: ${e?.message || String(e)}`);
        }
    }
    let list: TranslationText[];
    if (Array.isArray(value)) {
        list = value.map((v: any) => ({ element: String(v?.element ?? '').trim(), text: String(v?.text ?? '') }));
    } else if (value && typeof value === 'object') {
        list = Object.entries(value).map(([element, text]) => ({ element: element.trim(), text: String(text ?? '') }));
    } else {
        throw new McpError(ErrorCode.InvalidParams,
            'translations is required: {"ELEMENT_NAME":"translated text", ...} or [{"element":"ELEMENT_NAME","text":"..."}]. List the elements with GetCode resource=DYNPRO, dynnr and language.');
    }
    if (list.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'translations is empty — give at least one element');
    }
    if (list.length > MAX_TEXTS) {
        throw new McpError(ErrorCode.InvalidParams, `translations has ${list.length} entries, max ${MAX_TEXTS} per call`);
    }
    const seen = new Set<string>();
    for (const t of list) {
        if (!t.element) throw new McpError(ErrorCode.InvalidParams, 'every translation needs an element name');
        if (!t.text.trim()) {
            throw new McpError(ErrorCode.InvalidParams, `translation for ${t.element} is empty — deleting a translation is not supported`);
        }
        const key = t.element.toUpperCase();
        if (seen.has(key)) throw new McpError(ErrorCode.InvalidParams, `element ${t.element} is given twice`);
        seen.add(key);
    }
    return list;
}

export async function readTranslation(program: string, dynnr: string, language: string) {
    const lang = checkLanguage(language);
    const baseUrl = String(await getBaseUrl());
    const response = await makeAdtRequest(endpoint(baseUrl), 'GET', 30000, undefined, { program, dynnr, language: lang });
    const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    try {
        return { isError: false, content: [{ type: 'text', text: renderListing(JSON.parse(data) as Listing) }] };
    } catch (_e) {
        return { isError: false, content: [{ type: 'text', text: data }] };
    }
}

export async function writeTranslation(program: string, dynnr: string, language: string, translations: any) {
    const lang = checkLanguage(language);
    const texts = normalizeTexts(translations);
    const baseUrl = String(await getBaseUrl());
    const response = await makeAdtRequest(endpoint(baseUrl), 'POST', 60000, JSON.stringify({ texts }), { program, dynnr, language: lang }, {
        'Content-Type': 'application/json; charset=utf-8'
    });
    return { isError: false, content: [{ type: 'text', text: String(response.data ?? '') }] };
}

export function renderListing(l: Listing): string {
    const els = Array.isArray(l.elements) ? l.elements : [];
    const missing = els.filter(e => !(e.target_text ?? '').trim()).length;
    const lines = [
        `Screen ${l.program} ${l.dynnr} — texts ${l.source_language} → ${l.target_language} (${l.target_iso}) | ${els.length} element(s), ${missing} without a ${l.target_language} text`,
        '',
        'Element'.padEnd(26) + 'Max  ' + 'Source'.padEnd(30) + 'Target',
    ];
    for (const e of els) {
        lines.push(
            String(e.element).padEnd(26) +
            String(e.max_length).padEnd(5) +
            String(e.source_text).padEnd(30) +
            ((e.target_text ?? '').trim() || '(missing)')
        );
    }
    return lines.join('\n');
}
