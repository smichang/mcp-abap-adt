import { makeAdtRequest } from './utils';

// ADT's own "which change request does this object belong in?" call — what Eclipse makes before
// a save. POST /sap/bc/adt/cts/transportchecks takes NO lock: it reports the object's CTS
// registration (TLOCK) and the candidate requests. Unlike a LOCK/UNLOCK probe it cannot disturb
// a colleague's live editor session, and the answer does not depend on which user asks.
//
// Live-verified 2026-10-16 (S4D): an object held in another user's task answers
// EXISTING_REQ_ONLY=X, LOCKS=[request + task + owner], REQUESTS=[that one request]; a free or
// not-yet-existing object answers EXISTING_REQ_ONLY empty, no LOCKS, REQUESTS = the asking
// user's own open requests. An empty DEVCLASS is fine for an existing object (SAP fills it in).

export interface CtsHeader { number: string; owner: string; text: string; status: string; target: string }
export interface CtsLockHolder { request: CtsHeader; tasks: CtsHeader[] }
export interface TransportCheck {
    objectName: string;
    pgmid: string;
    objectType: string;
    devclass: string;
    recording: boolean;           // false → local/non-transportable (e.g. $TMP): no request needed
    existingRequestOnly: boolean; // true → SAP only allows the request(s) listed (the holder's)
    holders: CtsLockHolder[];
    candidates: CtsHeader[];
    messages: string[];
}
export type TransportVerdict = 'LOCAL' | 'FREE' | 'HELD_BY_SELF' | 'HELD_BY_OTHER';

const ASX_HEADERS = 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData';

function tag(block: string, name: string): string {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1].trim() : '';
}

function unescapeXml(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function header(block: string): CtsHeader {
    return {
        number: tag(block, 'TRKORR'),
        owner: tag(block, 'AS4USER'),
        text: unescapeXml(tag(block, 'AS4TEXT')),
        status: tag(block, 'TRSTATUS'),
        target: tag(block, 'TARSYSTEM'),
    };
}

function blocks(xml: string, name: string): string[] {
    return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);
}

/** Pure parser — separated from the HTTP call so it can be unit-tested offline. */
export function parseTransportCheck(xml: string): TransportCheck {
    const requestsXml = tag(xml, 'REQUESTS');
    const locksXml = tag(xml, 'LOCKS');
    const holders: CtsLockHolder[] = blocks(locksXml, 'LOCK_HOLDER').map(h => ({
        request: header(tag(h, 'REQ_HEADER')),
        tasks: blocks(tag(h, 'TASK_HEADERS'), 'CTS_TASK_HEADER').map(header),
    }));
    return {
        objectName: tag(xml, 'OBJECTNAME'),
        pgmid: tag(xml, 'PGMID'),
        objectType: tag(xml, 'OBJECT'),
        devclass: tag(xml, 'DEVCLASS'),
        recording: tag(xml, 'RECORDING') === 'X',
        existingRequestOnly: tag(xml, 'EXISTING_REQ_ONLY') === 'X',
        holders,
        candidates: blocks(requestsXml, 'CTS_REQUEST').map(r => header(tag(r, 'REQ_HEADER'))),
        messages: blocks(tag(xml, 'MESSAGES'), 'CTS_MESSAGE').map(m => unescapeXml(tag(m, 'TEXT'))).filter(Boolean),
    };
}

export function verdictOf(check: TransportCheck, currentUser: string): TransportVerdict {
    if (!check.recording && !check.holders.length) return 'LOCAL';   // a held object answers RECORDING='' too
    if (!check.holders.length) return 'FREE';
    const me = currentUser.toUpperCase();
    return check.holders.every(h => h.request.owner.toUpperCase() === me || h.tasks.some(t => t.owner.toUpperCase() === me))
        ? 'HELD_BY_SELF' : 'HELD_BY_OTHER';
}

/** True when `transportNumber` is the holder's request or one of its tasks. */
export function matchesHolder(check: TransportCheck, transportNumber: string): boolean {
    const t = transportNumber.toUpperCase();
    return check.holders.some(h => h.request.number.toUpperCase() === t || h.tasks.some(x => x.number.toUpperCase() === t));
}

export async function fetchTransportCheck(baseUrl: string, objectUri: string, devclass = ''): Promise<TransportCheck> {
    const body =
        `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
        `<PGMID></PGMID><OBJECT></OBJECT><OBJECTNAME></OBJECTNAME><DEVCLASS>${devclass}</DEVCLASS><SUPER_PACKAGE></SUPER_PACKAGE>` +
        `<OPERATION>I</OPERATION><URI>${objectUri}</URI></DATA></asx:values></asx:abap>`;
    const res = await makeAdtRequest(
        `${baseUrl}/sap/bc/adt/cts/transportchecks`, 'POST', 15000, body, undefined,
        { 'Content-Type': ASX_HEADERS, 'Accept': ASX_HEADERS }
    );
    const check = parseTransportCheck(typeof res.data === 'string' ? res.data : String(res.data || ''));
    if (check.recording && !check.holders.length && check.pgmid === 'LIMU' && check.objectType === 'FUNC') {
        await addFunctionModuleLocks(baseUrl, objectUri, check);
    }
    const grp = objectUri.match(/^\/sap\/bc\/adt\/functions\/groups\/([^/?]+)\/?$/);
    if (grp && !check.holders.length) await addFunctionGroupLocks(baseUrl, decodeURIComponent(grp[1]).toUpperCase(), check);
    return check;
}

// ---------------------------------------------------------------------------------------------
// Function-group locks. transportchecks reports none for a function group either (found 2026-10-27, ZBASIS):
// the group is "held" by every request that carries one of its function modules, and SAP then refuses to delete
// a member from any OTHER request ("R3TR FUGR ZBASIS is already locked in request …"). A new function module
// therefore belongs in the request that already holds its group's other modules; the holders are read from TLOCK.

async function addFunctionGroupLocks(baseUrl: string, group: string, check: TransportCheck): Promise<void> {
    if (!SAFE_NAME.test(group)) return;
    try {
        const rows = groupLockRows(group, await freestyleRows(baseUrl,
            `SELECT TRKORR, AUTHOR, LOKEY FROM TLOCK WHERE OBJECT = 'FUGR' AND LOKEY LIKE '${group} %'`));
        const holders = await holdersOfLockRows(baseUrl, rows);
        if (!holders.length) return;
        check.holders = holders;
        check.recording = true;
        check.messages.push(`Holder(s) read from TLOCK (function group ${group}): ADT transportchecks does not report function-group locks.`);
    } catch (e: any) {
        check.messages.push(`Function-group lock lookup in TLOCK failed (${e?.message || e}) — FREE is unverified for this group.`);
    }
}

async function holdersOfLockRows(baseUrl: string, locks: Record<string, string>[]): Promise<CtsLockHolder[]> {
    const tasks = [...new Set(locks.map(l => l.TRKORR).filter(t => SAFE_NAME.test(t)))];
    if (!tasks.length) return [];
    const sel = `SELECT E070~TRKORR, E070~STRKORR, E070~AS4USER, E070~TRSTATUS, E070~TARSYSTEM, E07T~AS4TEXT ` +
        `FROM E070 LEFT OUTER JOIN E07T ON E07T~TRKORR = E070~TRKORR WHERE E070~TRKORR IN `;
    const taskRows = await freestyleRows(baseUrl, `${sel}(${tasks.map(t => `'${t}'`).join(',')})`);
    const parents = [...new Set(taskRows.map(r => r.STRKORR).filter(p => p && SAFE_NAME.test(p)))];
    const parentRows = parents.length ? await freestyleRows(baseUrl, `${sel}(${parents.map(p => `'${p}'`).join(',')})`) : [];
    return locksToHolders(locks, [...taskRows, ...parentRows]);
}

// ---------------------------------------------------------------------------------------------
// Function-module locks. transportchecks answers <LOCKS/> for every function module, even one
// held in a colleague's open task: CTS keeps an FM's lock in TLOCK under its FUNCTION GROUP's
// key (OBJECT 'FUGR', LOKEY '<group padded to 26>FUNC<fm>'), which the ADT check does not read.
// Found 2026-10-19: a function module held by a colleague, reported
// FREE, as did all 60 FM locks on S4D. The holder is read here from TLOCK + E070/E07T through the
// read-only datapreview endpoint and merged into the check, so every caller (GetMeta TRANSPORT,
// the WriteProgram/DeleteObject/ActivateObjects guards) sees it.

/** Pure parser for a datapreview/freestyle answer: one record per row, keyed by column name. */
export function parsePreviewRows(xml: string): Record<string, string>[] {
    const columns = blocks(xml, 'dataPreview:columns').map(col => ({
        name: (col.match(/dataPreview:name="([^"]*)"/) || [])[1] || '',
        values: [...col.matchAll(/<dataPreview:data(?:\/>|>([\s\S]*?)<\/dataPreview:data>)/g)].map(m => unescapeXml(m[1] ?? '')),
    }));
    const rowCount = Math.max(0, ...columns.map(c => c.values.length));
    return Array.from({ length: rowCount }, (_, i) =>
        Object.fromEntries(columns.map(c => [c.name, (c.values[i] ?? '').trim()])));
}

/** Pure: task numbers of the given TLOCK rows + E070/E07T rows for the tasks and their requests → lock holders. */
export function locksToHolders(lockRows: Record<string, string>[], requestRows: Record<string, string>[]): CtsLockHolder[] {
    const taskNumbers = [...new Set(lockRows.map(r => r.TRKORR).filter(Boolean))];
    const byNumber = new Map<string, CtsHeader & { parent: string }>();
    for (const r of requestRows) {   // E07T is joined per language: keep the first non-empty text
        const known = byNumber.get(r.TRKORR);
        if (known) { if (!known.text && r.AS4TEXT) known.text = r.AS4TEXT; continue; }
        byNumber.set(r.TRKORR, { number: r.TRKORR, owner: r.AS4USER || '', text: r.AS4TEXT || '',
            status: r.TRSTATUS || '', target: r.TARSYSTEM || '', parent: r.STRKORR || '' });
    }
    const holders = new Map<string, CtsLockHolder>();
    for (const number of taskNumbers) {
        const entry = byNumber.get(number);
        const fallback = { number, owner: '', text: '', status: '', target: '' };
        const { parent, ...task } = entry ?? { ...fallback, parent: '' };
        const requestNumber = parent || number;   // a lock can also sit directly on a request
        const { parent: _p, ...request } = byNumber.get(requestNumber) ?? { ...fallback, number: requestNumber, parent: '' };
        const holder = holders.get(requestNumber) ?? { request, tasks: [] };
        if (parent) holder.tasks.push(task);
        holders.set(requestNumber, holder);
    }
    return [...holders.values()];
}

/** Pure: TLOCK rows for the FM + E070/E07T rows for the tasks and their requests → lock holders. */
export function fmLockHolders(group: string, fm: string, lockRows: Record<string, string>[],
                              requestRows: Record<string, string>[]): CtsLockHolder[] {
    const wanted = `${group} FUNC${fm}`;
    return locksToHolders(lockRows.filter(r => (r.LOKEY || '').replace(/\s+/g, ' ').trim() === wanted), requestRows);
}

/** Pure: TLOCK rows of one function group (any FM or include of it) — the LOKEY starts with the group padded to 26. */
export function groupLockRows(group: string, lockRows: Record<string, string>[]): Record<string, string>[] {
    return lockRows.filter(r => (r.LOKEY || '').substring(0, 26).trim().toUpperCase() === group.toUpperCase());
}

const SAFE_NAME = /^[A-Z0-9_/]+$/;

export async function freestyleRows(baseUrl: string, sql: string): Promise<Record<string, string>[]> {
    const res = await makeAdtRequest(`${baseUrl}/sap/bc/adt/datapreview/freestyle?rowNumber=100`, 'POST', 15000,
        sql, undefined, { 'Accept': 'application/*', 'Content-Type': 'text/plain' });
    return parsePreviewRows(typeof res.data === 'string' ? res.data : String(res.data || ''));
}

async function addFunctionModuleLocks(baseUrl: string, objectUri: string, check: TransportCheck): Promise<void> {
    const group = decodeURIComponent((objectUri.match(/\/functions\/groups\/([^/]+)\//) || [])[1] || '').toUpperCase();
    const fm = check.objectName.toUpperCase();
    if (!SAFE_NAME.test(group) || !SAFE_NAME.test(fm)) return;
    try {
        const locks = await freestyleRows(baseUrl,
            `SELECT TRKORR, AUTHOR, LOKEY FROM TLOCK WHERE OBJECT = 'FUGR' AND LOKEY LIKE '${group} %FUNC${fm}%'`);
        const tasks = [...new Set(locks.map(l => l.TRKORR).filter(t => SAFE_NAME.test(t)))];
        if (!tasks.length) return;
        const sel = `SELECT E070~TRKORR, E070~STRKORR, E070~AS4USER, E070~TRSTATUS, E070~TARSYSTEM, E07T~AS4TEXT ` +
            `FROM E070 LEFT OUTER JOIN E07T ON E07T~TRKORR = E070~TRKORR WHERE E070~TRKORR IN `;
        const taskRows = await freestyleRows(baseUrl, `${sel}(${tasks.map(t => `'${t}'`).join(',')})`);
        const parents = [...new Set(taskRows.map(r => r.STRKORR).filter(p => p && SAFE_NAME.test(p)))];
        const parentRows = parents.length ? await freestyleRows(baseUrl, `${sel}(${parents.map(p => `'${p}'`).join(',')})`) : [];
        const holders = fmLockHolders(group, fm, locks, [...taskRows, ...parentRows]);
        if (!holders.length) return;
        check.holders = holders;
        check.existingRequestOnly = true;
        check.candidates = holders.map(h => h.request);
        check.messages.push(`Holder read from TLOCK (function-group key ${group}/FUNC${fm}): ADT transportchecks does not report function-module locks.`);
    } catch (e: any) {
        check.messages.push(`Function-module lock lookup in TLOCK failed (${e?.message || e}) — FREE is unverified for this function module.`);
    }
}

/**
 * Guard helper for handlers that hold an ADT lock. `lockCorrNr` is the CORRNR of the lock result;
 * it may be the holder's request OR task, so a plain string compare against the caller's
 * transport_number can refuse a legitimate request/task pair. Returns true only when
 * `transportNumber` is genuinely a DIFFERENT change than the one holding the object.
 * Any failure of the check leaves the conservative answer (conflict).
 */
export async function isDifferentChange(baseUrl: string, objectUri: string, lockCorrNr: string, transportNumber: string): Promise<boolean> {
    if (!lockCorrNr || !transportNumber || lockCorrNr.toUpperCase() === transportNumber.toUpperCase()) return false;
    try {
        return !matchesHolder(await fetchTransportCheck(baseUrl, objectUri), transportNumber);
    } catch (_e) {
        return true;
    }
}
