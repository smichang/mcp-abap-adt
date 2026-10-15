import * as fs from 'fs/promises';
import * as path from 'path';
import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { AxiosError } from 'axios';
import { resolveAnyObject } from '../lib/resolveObject';
import { refreshStatefulOperationToken } from '../lib/writeLock';
import { runSyntaxCheck, formatSyntaxMessages } from '../lib/syntaxCheck';
import { validateEdits, applyEdits, PatchEdit } from '../lib/sourcePatch';
import { saveSnapshot } from '../lib/snapshots';
import { rememberPatch, recallPatch, PENDING_PATCH_TTL_MINUTES } from '../lib/pendingPatch';
import { attemptUnlock } from './handleWriteProgram';
import { handleActivateObjects } from './handleActivateObjects';

// WriteProgram class_include=…: write one of a class's LOCAL includes — the part that is not the global
// class's main source:
//   testclasses      local test classes (unit tests)        CCAU
//   implementations  local classes                           CCIMP
//   definitions      local types                             CCDEF
//   macros           local macros                            CCMAC
// Putting a local class into the main source is rejected by SAP's source splitter (OO_SOURCE_BASED011) —
// found when a fresh session tried to write a unit test (lifecycle test 2) and had no way to.
//
//   GET  /sap/bc/adt/oo/classes/{c}/includes/{inc}                       current text (404 = the include does not exist yet)
//   POST /sap/bc/adt/oo/classes/{c}/includes?lockHandle=…[&corrNr=…]     create it (class:abapClassInclude)
//   PUT  /sap/bc/adt/oo/classes/{c}/includes/{inc}?lockHandle=…[&corrNr] the text
// under the CLASS's own lock (one lock covers the main source and every include). The caller —
// handleWriteProgram — already holds the stateful-operation gate.

export const CLASS_INCLUDES = ['definitions', 'implementations', 'macros', 'testclasses'] as const;
type ClassInclude = typeof CLASS_INCLUDES[number];

export async function writeClassInclude(args: any) {
    try {
        const className = args?.program_name ? String(args.program_name).toUpperCase() : '';
        const include = String(args?.class_include || '').toLowerCase() as ClassInclude;
        if (!className) throw new McpError(ErrorCode.InvalidParams, 'program_name (the class) is required');
        if (!CLASS_INCLUDES.includes(include)) {
            throw new McpError(ErrorCode.InvalidParams, `class_include must be one of ${CLASS_INCLUDES.join(', ')} (omit it to write the class's main source)`);
        }
        const objType = args?.object_type ? String(args.object_type).toUpperCase() : 'CLAS';
        if (objType !== 'CLAS') throw new McpError(ErrorCode.InvalidParams, 'class_include is only valid for a class (object_type=CLAS)');
        const activate = args?.activate !== false;
        const checkOnly = args?.check_only === true;
        // ON by default here (unlike the main source, where an include is checked alone and may give false
        // errors): the class is checked in full, with the new include text in place — exact context.
        // syntax_check=false opts out; a failing check CALL never blocks a write.
        const syntaxCheck = checkOnly || args?.syntax_check !== false;
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : '';

        // exactly one source: source_code | source_file | edits[]
        const sourceFile = args?.source_file ? String(args.source_file) : '';
        const inlineSource = typeof args?.source_code === 'string' ? args.source_code : '';
        // A patch id is bound to ONE include of ONE class: NAME.include (the main source of the same class
        // has its own id space under NAME, so an id cannot be applied to the wrong part).
        const patchKey = `${className}.${include}`;
        const applyPatchId = args?.apply_patch ? String(args.apply_patch).trim() : '';
        let edits: PatchEdit[] = [];
        let hasEdits = args?.edits !== undefined;
        const given = [sourceFile !== '', inlineSource.trim() !== '', hasEdits].filter(Boolean).length;
        if (applyPatchId) {
            if (given !== 0) throw new McpError(ErrorCode.InvalidParams, 'apply_patch cannot be combined with edits, source_code or source_file.');
            const recalled = recallPatch(applyPatchId, patchKey);
            if ('error' in recalled) throw new McpError(ErrorCode.InvalidParams, recalled.error);
            edits = recalled.edits;
            hasEdits = true;
        } else {
            if (given !== 1) {
                throw new McpError(ErrorCode.InvalidParams, 'with class_include pass exactly one of source_code, source_file or edits (a patch of the include as it is in SAP now) — or apply_patch=<id> from an earlier passed dry run');
            }
            if (hasEdits) {
                try { edits = validateEdits(args.edits); } catch (e: any) { throw new McpError(ErrorCode.InvalidParams, e?.message || String(e)); }
            }
        }
        let newSource = inlineSource;
        if (sourceFile) {
            const resolved = path.resolve(sourceFile);
            try { newSource = await fs.readFile(resolved, 'utf8'); }
            catch (e: any) { throw new McpError(ErrorCode.InvalidParams, `Could not read source_file '${resolved}': ${e?.message || String(e)}`); }
        }

        const baseUrl = String(await getBaseUrl());
        const resolution = await resolveAnyObject(baseUrl, className, 'CLAS');
        if ('error' in resolution) {
            return { isError: true, content: [{ type: 'text', text: `${resolution.error}\nclass_include writes into an EXISTING class — create the class first (WriteProgram without class_include).` }] };
        }
        const classUri = resolution.uri;
        const classUrl = `${baseUrl}${classUri}`;
        const includeUrl = `${classUrl}/includes/${include}`;

        // current text of the include; 404 = it does not exist yet
        let current: string | null = null;
        try {
            const r = await makeAdtRequest(includeUrl, 'GET', 30000, undefined, undefined, { 'Accept': 'text/plain' });
            current = typeof r.data === 'string' ? r.data : String(r.data ?? '');
        } catch (e) {
            if (!(e instanceof AxiosError && e.response?.status === 404)) throw e;
        }

        if (hasEdits) {
            if (current === null) {
                return { isError: true, content: [{ type: 'text', text: `edits needs an existing '${include}' include, but ${className} has none. Write it first with source_code / source_file.` }] };
            }
            const patched = applyEdits(current, edits);
            if (!patched.ok) return { isError: true, content: [{ type: 'text', text: `${patched.error}\nNothing was locked or written.` }] };
            newSource = patched.text;
        }
        if (newSource.trim().length === 0) throw new McpError(ErrorCode.InvalidParams, 'the new include source is empty');

        // ── Pre-write syntax check (stateless, no lock): the class with this include replaced by the new text ──
        let checkNote = '';
        if (syntaxCheck && current === null) {
            // SAP cannot compile an include that does not exist yet: the check of a not-yet-created testclasses
            // include came back "0 errors, 1 warning (the include exists but is not used)" even for source with an
            // undefined variable — a reassuring no-op, found by the 2026-10-15 review. Say so instead of pretending.
            const msg = `NOT CHECKED: the '${include}' include of ${className} does not exist yet, and SAP cannot compile an include before it exists, so no pre-write syntax check is possible for this first write. ` +
                `Errors in it will show at activation (the class is then left inactive — fix it with another WriteProgram class_include=${include} call; from then on the include exists and the pre-check works).`;
            if (checkOnly) return { isError: false, content: [{ type: 'text', text: `${msg}\nCheck only — nothing was locked or written.` }] };
            checkNote = msg;
        } else if (syntaxCheck) {
            try {
                const res = await runSyntaxCheck(baseUrl, classUri, newSource, undefined, `${classUri}/includes/${include}`);
                const here = `${className} (${include})`;
                const ours = res.messages.filter(m => (m.unit || '').toUpperCase() === here.toUpperCase());
                const blocking = ours.filter(m => m.type === 'E' || m.type === 'A' || m.type === 'X');
                res.checked = here;
                const report = formatSyntaxMessages({ ...res, messages: res.messages, errors: res.errors, warnings: res.warnings });
                const otherErrors = res.messages.filter(m => (m.type === 'E' || m.type === 'A' || m.type === 'X') && !ours.includes(m)).length;
                if (blocking.length > 0) {
                    return { isError: true, content: [{ type: 'text', text: `${report}\nNothing was locked or written.${otherErrors ? ` (${otherErrors} further error(s) in other parts of the class are listed above too.)` : ''}` }] };
                }
                const note = otherErrors > 0 ? `\nNote: ${otherErrors} error(s) exist in OTHER parts of the class (listed above) — they do not come from this include, so the write is not blocked.` : '';
                if (checkOnly) {
                    // a passed dry run of edits[] can be applied by id instead of sending the edits again
                    const keep = hasEdits && !applyPatchId
                        ? `\nTo apply this exact patch: WriteProgram(program_name="${className}", class_include="${include}", apply_patch="${rememberPatch(patchKey, edits)}", …same activate/transport options) — valid ${PENDING_PATCH_TTL_MINUTES} min; the edits are re-applied to the then-current include.`
                        : '';
                    return { isError: false, content: [{ type: 'text', text: `${report}${note}\nCheck only — nothing was locked or written.${keep}` }] };
                }
                checkNote = `${report}${note}`;
            } catch (e: any) {
                if (checkOnly) return return_error(e);
                checkNote = `Syntax check could not run (${e?.message || String(e)}) — continued with the write.`;
            }
        }

        // ── LOCK the class ──
        removeCookie('sap-contextid');
        let lockHandle = '';
        let existingCorr = '';
        let snapshotNote = '';
        try {
            const lock = await makeAdtRequest(classUrl, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
                'Accept': 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
                'X-sap-adt-sessiontype': 'stateful',
            });
            const ctx = ((lock.headers?.['set-cookie'] as string[] | undefined) || []).join(' ').match(/(sap-contextid=[^;]+)/);
            if (ctx) { appendCookie(ctx[1]); refreshStatefulOperationToken(ctx[1]); }
            const xml = String(lock.data || '');
            lockHandle = xml.match(/<LOCK_HANDLE>([^<]*)</)?.[1] || '';
            existingCorr = xml.match(/<CORRNR>([^<]*)</)?.[1] || '';
            if (!lockHandle) throw new Error('Lock handle not found in response');
        } catch (error) {
            removeCookie('sap-contextid');
            return sapFailure(`Failed to lock class '${className}' for the '${include}' include. If it is your own leftover session, try UnlockObject.`, error);
        }

        const transport = transportNumber || existingCorr;
        try {
            // never let SAP silently move the class into a different request
            if (transportNumber && existingCorr && existingCorr !== transportNumber) {
                return { isError: true, content: [{ type: 'text', text: `Class '${className}' is already locked in change request ${existingCorr}. Re-run with transport_number=${existingCorr} or omit it. Nothing was written.` }] };
            }
            const q: Record<string, string> = { lockHandle };
            if (transport) q.corrNr = transport;

            // the include must exist before it can be written
            if (current === null) {
                const body =
                    `<?xml version="1.0" encoding="UTF-8"?>` +
                    `<class:abapClassInclude xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" ` +
                    `class:includeType="${include}" adtcore:name="${className}" adtcore:type="CLAS/I">` +
                    `<adtcore:containerRef adtcore:name="${className}" adtcore:type="CLAS/OC" adtcore:uri="${classUri}"/>` +
                    `</class:abapClassInclude>`;
                try {
                    await makeAdtRequest(`${classUrl}/includes`, 'POST', 30000, body, q, {
                        'Content-Type': 'application/vnd.sap.adt.oo.classincludes+xml',
                        'Accept': 'application/vnd.sap.adt.oo.classincludes+xml, application/xml, */*',
                        'X-sap-adt-sessiontype': 'stateful',
                    });
                } catch (error) {
                    return sapFailure(`Failed to create the '${include}' include of class '${className}'.`, error);
                }
            } else if (current !== newSource) {
                const sid = saveSnapshot(`${className}.${include}`, current);
                if (sid) snapshotNote = `Previous '${include}' include kept as local snapshot ${sid}.`;
            }

            try {
                await makeAdtRequest(includeUrl, 'PUT', 30000, newSource, q, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'X-sap-adt-sessiontype': 'stateful',
                });
            } catch (error) {
                return sapFailure(`Failed to write the '${include}' include of class '${className}'.`, error);
            }
        } finally {
            const err = await attemptUnlock(classUrl, lockHandle);
            if (err) console.error(`WriteProgram class_include: unlock of ${className} failed: ${err}`);
        }

        const out: string[] = [`${current === null ? 'Created and wrote' : 'Wrote'} the '${include}' include of class ${className} (${newSource.split('\n').length} lines).`];
        if (checkNote) out.push(checkNote);
        if (hasEdits) out.push(`Patched with ${edits.length} edit(s).`);
        if (snapshotNote) out.push(snapshotNote);
        if (transport) out.push(`Transport: ${transport}`);

        if (!activate) {
            out.push(`Not activated (activate=false) — the saved include stays inactive until the class is activated (ActivateObjects ["${className}"]).`);
            return { isError: false, content: [{ type: 'text', text: out.join('\n') }] };
        }
        // plain activation takes no stateful gate, so it may run while WriteProgram holds it
        const act = await handleActivateObjects({ names: [className] });
        const actText = act.content?.[0]?.text ?? '';
        out.push('', actText);
        return { isError: !!act.isError, content: [{ type: 'text', text: out.join('\n') }] };
    } catch (error) {
        return return_error(error);
    }
}

function sapFailure(prefix: string, error: unknown) {
    if (error instanceof AxiosError && error.response?.data) {
        const msg = parseAdtErrorXml(String(error.response.data));
        if (msg) return { isError: true, content: [{ type: 'text', text: `${prefix}\nReason: ${msg}` }] };
    }
    return return_error(error);
}
