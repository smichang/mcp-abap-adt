import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl } from '../lib/utils';
import { cacheKey, getCachedList, setCachedList } from '../lib/queryCache';
import { readTranslation } from './dynproTranslation';

// Talks to ZCL_HTTP_MCP_DYNPRO (package ZMCP), a standalone SICF service at
// default_host/zmcp/dynpro — NOT an ADT resource. Standard ADT has no REST
// contract for classic screen content: a screen's VIT URI
// (/sap/bc/adt/vit/wb/object_type/progps/...) only returns basic properties,
// and the element list / flow logic live compressed in DYNPSOURCE. The ABAP
// side wraps RPY_DYNPRO_READ and returns its external (RPY_*) structures as
// JSON with lower-case DDIC component names — the same shape RPY_DYNPRO_INSERT
// takes, so raw=true output can be edited and written back (ManageDynpro).
// Discovery record:

interface ScreenListEntry { dynnr: string; type: string; description: string; }

// RPY_DYHEAD-TYPE codes. N/I/M/J confirmed live; S/W from domain SCRPTYP.
const SCREEN_TYPES: Record<string, string> = {
    N: 'normal',
    I: 'subscreen',
    M: 'modal dialog box',
    S: 'selection screen',
    J: 'selection screen as subscreen',
    W: 'selection screen as modal dialog',
};

// RPY_DYHEAD flag -> SE51 Attributes tab label ("Settings" group)
const SETTING_FLAGS: [string, string][] = [
    ['hold_data', 'Hold data'],
    ['no_compr', 'Switch off runtime compression'],
    ['no_execute', 'Template - non-executable'],
    ['keep_scpos', 'Hold scroll position'],
    ['no_toolbar', 'Without application toolbar'],
    ['fixed_font', 'Fixed font (obsolete)'],
    ['fiorienlargeoff', 'Fiori: no enlargement'],
];

function typeLabel(code: string): string {
    const c = (code ?? '').trim();
    return SCREEN_TYPES[c] ? `${c} (${SCREEN_TYPES[c]})` : (c || '?');
}

export async function handleGetDynpro(args: any) {
    try {
        const program = args?.object_name ? String(args.object_name).trim().toUpperCase() : '';
        const dynnrArg = args?.dynnr !== undefined && args.dynnr !== null ? String(args.dynnr).trim() : '';
        if (!program) {
            throw new McpError(ErrorCode.InvalidParams, 'object_name (the program owning the screens) is required. For a function group use its main program SAPL<group>.');
        }
        if (dynnrArg && !/^\d{1,4}$/.test(dynnrArg)) {
            throw new McpError(ErrorCode.InvalidParams, `dynnr must be 1-4 digits, got "${dynnrArg}"`);
        }

        const baseUrl = String(await getBaseUrl());
        const url = `${baseUrl}/zmcp/dynpro`;

        if (!dynnrArg) {
            if (args?.language !== undefined && args.language !== null && String(args.language).trim() !== '') {
                throw new McpError(ErrorCode.InvalidParams, 'language needs dynnr: translations are read per screen');
            }
            return await listScreens(url, program, args);
        }
        const dynnr = dynnrArg.padStart(4, '0');
        if (args?.language !== undefined && args.language !== null && String(args.language).trim() !== '') {
            return await readTranslation(program, dynnr, String(args.language));
        }
        const response = await makeAdtRequest(url, 'GET', 30000, undefined, { program, dynnr });
        const json = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

        if (args?.raw === true) {
            return { isError: false, content: [{ type: 'text', text: json }] };
        }
        try {
            return { isError: false, content: [{ type: 'text', text: renderScreen(JSON.parse(json)) }] };
        } catch (_e) {
            return { isError: false, content: [{ type: 'text', text: json }] };
        }
    } catch (error) {
        return return_error(error);
    }
}

async function listScreens(url: string, program: string, args: any) {
    const offset = Math.max(0, Number(args?.offset ?? 0) || 0);
    const limit = Math.max(1, Number(args?.max_results ?? 100) || 100);

    const key = cacheKey('GetDynproList', { program });
    let full = getCachedList<ScreenListEntry>(key);
    const fromCache = !!full;
    if (!full) {
        const response = await makeAdtRequest(url, 'GET', 60000, undefined, { program });
        const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        full = Array.isArray(data) ? data as ScreenListEntry[] : [];
        setCachedList(key, full);
    }

    if (full.length === 0) {
        return { isError: false, content: [{ type: 'text', text: `Program ${program} has no screens.` }] };
    }
    const windowed = full.slice(offset, offset + limit);
    const head = `Screens of ${program} (${full.length} total, showing ${windowed.length} from offset ${offset})${fromCache ? ' [cached]' : ''}`;
    const rows = windowed.map(s => `${s.dynnr}  ${typeLabel(s.type).padEnd(32)}  ${s.description ?? ''}`);
    const selNote = windowed.some(s => selectionScreenNote(s.type)) ? ['', 'Selection screens (S/J/W) are generated from the program source; change them with WriteProgram + selection texts, not ManageDynpro.'] : [];
    return { isError: false, content: [{ type: 'text', text: [head, '', 'Dynnr Type                              Description', ...rows, ...selNote].join('\n') }] };
}

/** Pure: how a selection screen is changed — it is generated from the program source. */
export function selectionScreenNote(type: string): string {
    return ['S', 'J', 'W'].includes(String(type).toUpperCase())
        ? 'Generated selection screen: it comes from SELECTION-SCREEN / PARAMETERS / SELECT-OPTIONS in the program source. '
          + 'Change it in the source with WriteProgram and its labels as selection texts (WriteProgram selection_texts, '
          + 'TextPoolLang for other languages); SAP regenerates the screen on activation. ManageDynpro refuses selection screens.'
        : '';
}

function renderScreen(d: any): string {
    const h = d?.header ?? {};
    const lines: string[] = [];
    lines.push(`Screen ${h.program} ${h.screen} — ${h.descript ?? ''}`);
    const attrs = [
        `Type: ${typeLabel(h.type)}`,
        `Size: ${h.lines} x ${h.columns}`,
        `Next screen: ${h.nextscreen || '-'}`,
        `Language: ${h.language}`,
    ];
    if (h.cursor_pos) attrs.push(`Cursor: ${h.cursor_pos}`);
    if (h.screen_grp) attrs.push(`Screen group: ${h.screen_grp}`);
    lines.push(attrs.join(' | '));
    // A plan-eval run (2026-10-19) planned ManageDynpro update on a type-J screen it had read here.
    const selNote = selectionScreenNote(h.type);
    if (selNote) lines.push(selNote);
    // SE51 "Settings" checkboxes + context menu FORM (RPY_DYHEAD flags)
    const settings = SETTING_FLAGS.filter(([field]) => h[field] === 'X').map(([, label]) => label);
    if (h.ctx_menon) settings.push(`Context menu FORM ON_CTMENU_${h.ctx_menon}`);
    lines.push(`Settings: ${settings.length ? settings.join(', ') : 'none'}`);

    // Containers other than the screen itself: subscreen areas, table
    // controls, step loops, custom-control areas, tabstrips.
    const containers: any[] = (d?.containers ?? []).filter((c: any) => c.type !== 'SCREEN');
    if (containers.length) {
        lines.push('', `Containers (${containers.length}):`);
        for (const c of containers) {
            const pos = `@${c.line},${c.column} ${c.length}x${c.height}`;
            const extra = [c.element_of && c.element_of !== 'SCREEN' ? `in ${c.element_of}` : '', c.cu_cc_name ? `control ${c.cu_cc_name}` : '']
                .filter(Boolean).join(', ');
            lines.push(`  ${String(c.type).padEnd(12)} ${String(c.name).padEnd(30)} ${pos}${extra ? `  (${extra})` : ''}`);
        }
    }

    const fields: any[] = d?.fields_to_containers ?? [];
    lines.push('', `Elements (${fields.length}):`);
    if (fields.length) {
        lines.push('  Line,Col Type       Name                                     Len  Attr        Text / FCode');
        for (const f of fields) {
            const pos = `${Number(f.line)},${Number(f.column)}`.padEnd(8);
            const flags = [
                f.input_fld === 'X' ? 'in' : '',
                f.output_fld === 'X' ? 'out' : '',
                f.outputonly === 'X' ? 'ro' : '',
                f.requ_entry === 'X' ? 'req' : '',
                f.from_dict === 'X' ? 'dict' : '',
                f.invisible === 'X' ? 'inv' : '',
            ].filter(Boolean).join(',');
            // Text/frame/pushbutton labels are '_'-padded in the external format.
            const text = String(f.text ?? '').replace(/_+$/, '').replace(/_/g, ' ').trim();
            const fcode = f.push_fcode ? `[${f.push_fcode}]` : '';
            const where = f.cont_type && f.cont_type !== 'SCREEN' ? ` {${f.cont_type} ${f.cont_name}}` : '';
            lines.push(`  ${pos} ${String(f.type).padEnd(10)} ${String(f.name).padEnd(40)} ${String(Number(f.length)).padStart(4)}  ${flags.padEnd(11)} ${[text, fcode].filter(Boolean).join(' ')}${where}`);
        }
    }

    const flow: any[] = d?.flow_logic ?? [];
    // RPY_DYNPRO_READ appends one trailing empty line — drop trailing blanks.
    while (flow.length && !String(flow[flow.length - 1].line ?? '').trim()) flow.pop();
    lines.push('', `Flow logic (${flow.length} lines):`);
    for (const l of flow) lines.push(String(l.line ?? ''));

    const params: any[] = d?.params ?? [];
    if (params.length) lines.push('', `Parameters: ${params.length} (use raw=true to see them)`);
    lines.push('', 'Full definition (all element attributes, round-trippable JSON): raw=true');
    return lines.join('\n');
}
