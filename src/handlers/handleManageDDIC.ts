import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, getBaseUrl, parseAdtErrorXml, appendCookie, removeCookie } from '../lib/utils';
import { escapeXml, attemptUnlock, describeLockHolder, createTransportForObject } from './handleWriteProgram';
import { AxiosError } from 'axios';
import { promises as fs } from 'fs';
import * as path from 'path';
import { acquireStatefulOperationLock, refreshStatefulOperationToken, releaseStatefulOperationLock } from '../lib/writeLock';

type ToolResult = any;

const VALID_OBJECT_TYPES = ['STRUCTURE', 'TABLE_TYPE', 'DATA_ELEMENT', 'CDS_VIEW', 'DOMAIN'];

// WriteProgram's exact proven lock Accept header — confirmed live against structure, table-type,
// data-element, and CDS-view-entity lock endpoints.
const LOCK_ACCEPT = 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result';

function err(text: string): ToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function handleManageDDIC(args: any): Promise<ToolResult> {
    const objectType = args?.object_type ? String(args.object_type).toUpperCase() : 'unknown';
    const name = args?.name ? String(args.name).toUpperCase() : 'unknown';
    const gate = acquireStatefulOperationLock(`ManageDDIC(${objectType}:${name})`);
    if (!gate.ok) return err(gate.message);
    try {
        return await manageDDICCore(args);
    } finally {
        releaseStatefulOperationLock();
    }
}

async function manageDDICCore(args: any): Promise<ToolResult> {
    try {
        const objectType = args?.object_type ? String(args.object_type).toUpperCase() : '';
        const action = args?.action ? String(args.action).toLowerCase() : '';
        const name = args?.name ? String(args.name).toUpperCase() : '';
        const description = args?.description ? String(args.description) : '';
        const packageName = args?.package_name ? String(args.package_name).toUpperCase() : '';
        const transportNumber = args?.transport_number ? String(args.transport_number).toUpperCase() : '';
        const transportDescription = args?.transport_description ? String(args.transport_description) : '';

        if (!VALID_OBJECT_TYPES.includes(objectType)) {
            throw new McpError(ErrorCode.InvalidParams, `object_type must be one of ${VALID_OBJECT_TYPES.join(', ')} (got '${args?.object_type}')`);
        }
        if (action !== 'create' && action !== 'update') {
            throw new McpError(ErrorCode.InvalidParams, `action must be create or update (got '${args?.action}')`);
        }
        if (!name) {
            throw new McpError(ErrorCode.InvalidParams, 'name is required');
        }
        if (!/^[ZY]/.test(name)) {
            throw new McpError(ErrorCode.InvalidParams, `name '${name}' must be in the customer namespace (start with Z or Y)`);
        }
        // SAP silently truncates a DDIC object name past 30 characters on create rather than
        // erroring — same class of trap fixed in WriteProgram's MAX_NAME_LENGTH — applies equally here since
        // all five DDIC object types share the 30-char repository-object-name limit.
        if (action === 'create' && name.length > 30) {
            throw new McpError(ErrorCode.InvalidParams, `name '${name}' is ${name.length} characters — exceeds SAP's 30-character limit for ${objectType} names and would be silently truncated on create. Shorten it before retrying.`);
        }
        if (transportNumber && transportDescription) {
            throw new McpError(ErrorCode.InvalidParams, 'transport_number and transport_description are mutually exclusive');
        }
        if (transportDescription) {
            if (transportDescription.length > 60) {
                throw new McpError(ErrorCode.InvalidParams, `transport_description exceeds SAP limit of 60 characters (got ${transportDescription.length})`);
            }
            if (!packageName) {
                throw new McpError(ErrorCode.InvalidParams, "package_name is required together with transport_description (used as the new transport's DEVCLASS)");
            }
        }
        if (action === 'create' && (!description || !packageName)) {
            throw new McpError(ErrorCode.InvalidParams, 'description and package_name are required for action=create');
        }

        if (objectType === 'STRUCTURE' || objectType === 'CDS_VIEW') {
            const sourceFile = args?.source_file ? String(args.source_file) : '';
            const sourceCodeArg = args?.source_code ?? '';
            let sourceCode: string;
            if (sourceFile) {
                const resolved = path.resolve(sourceFile);
                try {
                    sourceCode = await fs.readFile(resolved, 'utf8');
                } catch (e: any) {
                    throw new McpError(ErrorCode.InvalidParams, `Could not read source_file '${resolved}': ${e?.message || String(e)}`);
                }
                if (sourceCode.trim().length === 0) {
                    throw new McpError(ErrorCode.InvalidParams, `source_file '${resolved}' is empty`);
                }
            } else {
                if (typeof sourceCodeArg !== 'string' || sourceCodeArg.trim().length === 0) {
                    throw new McpError(ErrorCode.InvalidParams, `Either source_code (inline) or source_file (path) is required for object_type=${objectType}`);
                }
                sourceCode = sourceCodeArg;
            }
            const cfg = objectType === 'STRUCTURE' ? STRUCTURE_CONFIG : CDS_VIEW_CONFIG;
            return await manageDdlSourceObject(cfg, { action, name, description, packageName, transportNumber, transportDescription, sourceCode });
        }

        if (objectType === 'DATA_ELEMENT') {
            const domainName = args?.domain_name ? String(args.domain_name).toUpperCase() : '';
            if (!domainName) {
                throw new McpError(ErrorCode.InvalidParams, 'domain_name is required for object_type=DATA_ELEMENT');
            }
            const shortLabel = args?.short_label ? String(args.short_label) : '';
            const mediumLabel = args?.medium_label ? String(args.medium_label) : '';
            const longLabel = args?.long_label ? String(args.long_label) : '';
            const headingLabel = args?.heading_label ? String(args.heading_label) : '';
            return await manageDataElement({
                action, name, description, packageName, transportNumber, transportDescription,
                domainName, shortLabel, mediumLabel, longLabel, headingLabel
            });
        }

        if (objectType === 'DOMAIN') {
            const dataType = args?.data_type ? String(args.data_type).toUpperCase() : '';
            if (!dataType) {
                throw new McpError(ErrorCode.InvalidParams, 'data_type is required for object_type=DOMAIN');
            }
            const lengthArg = args?.length;
            if (lengthArg === undefined || lengthArg === null || String(lengthArg).trim() === '') {
                throw new McpError(ErrorCode.InvalidParams, 'length is required for object_type=DOMAIN');
            }
            const length = Number(lengthArg);
            if (!Number.isInteger(length) || length < 1) {
                throw new McpError(ErrorCode.InvalidParams, `length must be a positive integer (got '${lengthArg}')`);
            }
            const decimalsArg = args?.decimals;
            const decimals = (decimalsArg === undefined || decimalsArg === null || String(decimalsArg).trim() === '') ? 0 : Number(decimalsArg);
            if (!Number.isInteger(decimals) || decimals < 0) {
                throw new McpError(ErrorCode.InvalidParams, `decimals must be a non-negative integer (got '${decimalsArg}')`);
            }
            if (action === 'update' && args?.description) {
                throw new McpError(ErrorCode.InvalidParams,
                    "Changing 'description' on an existing DOMAIN is not supported: SAP silently ignores a description change sent on the update PUT " +
                    '(). Omit description for action=update.');
            }
            return await manageDomain({ action, name, description, packageName, transportNumber, transportDescription, dataType, length, decimals });
        }

        // TABLE_TYPE
        const rowTypeName = args?.row_type_name ? String(args.row_type_name).toUpperCase() : '';
        if (action === 'create' && !rowTypeName) {
            throw new McpError(ErrorCode.InvalidParams, 'row_type_name is required for object_type=TABLE_TYPE');
        }
        if (action === 'update') {
            if (!rowTypeName) {
                throw new McpError(ErrorCode.InvalidParams, 'row_type_name is required for object_type=TABLE_TYPE action=update (the only field this tool can change on an existing table type)');
            }
            if (args?.description) {
                throw new McpError(ErrorCode.InvalidParams,
                    "Changing 'description' on an existing TABLE_TYPE is not supported: SAP silently ignores a description change sent on the update PUT " +
                    '(). Omit description for action=update.');
            }
        }
        return await manageTableType({ action, name, description, packageName, transportNumber, transportDescription, rowTypeName });
    } catch (error) {
        return return_error(error);
    }
}

// ── STRUCTURE / CDS_VIEW ─────────────────────────────────────────────────
// Both are DDL-source objects sharing one identical mechanism: create metadata (minimal) →
// lock → PUT /source/main (text/plain, full DDL) → unlock → activate. Only the collection
// path, MIME, root element, and adtcore:type differ ( and
// -phase-5.md) — genuinely the same shape, unlike STRUCTURE vs TABLE_TYPE, so one function
// parameterized by a small config generalizes cleanly instead of duplicating the whole flow.

interface DdlSourceTypeConfig {
    collectionPath: string;
    mime: string;
    rootTag: string;
    rootNsPrefix: string;
    rootNsUri: string;
    adtType: string;
    typeLabel: string;
}

const STRUCTURE_CONFIG: DdlSourceTypeConfig = {
    collectionPath: 'structures',
    mime: 'application/vnd.sap.adt.structures.v2+xml',
    rootTag: 'blue:blueSource',
    rootNsPrefix: 'blue',
    rootNsUri: 'http://www.sap.com/wbobj/blue',
    adtType: 'TABL/DS',
    typeLabel: 'structure'
};

const CDS_VIEW_CONFIG: DdlSourceTypeConfig = {
    collectionPath: 'ddl/sources',
    mime: 'application/vnd.sap.adt.ddlSource+xml',
    rootTag: 'ddl:ddlSource',
    rootNsPrefix: 'ddl',
    rootNsUri: 'http://www.sap.com/adt/ddic/ddlsources',
    adtType: 'DDLS/DF',
    typeLabel: 'CDS view'
};

interface DdlSourceArgs {
    action: 'create' | 'update';
    name: string;
    description: string;
    packageName: string;
    transportNumber: string;
    transportDescription: string;
    sourceCode: string;
}

async function manageDdlSourceObject(cfg: DdlSourceTypeConfig, a: DdlSourceArgs): Promise<ToolResult> {
    const baseUrl = await getBaseUrl();
    const lname = a.name.toLowerCase();
    const objectUrl = `${baseUrl}/sap/bc/adt/ddic/${cfg.collectionPath}/${lname}`;

    const existingMeta = await ddlSourceMetadata(objectUrl, cfg.rootTag);
    const exists = !!existingMeta;
    if (a.action === 'create' && exists) {
        return err(`${capitalize(cfg.typeLabel)} '${a.name}' already exists. Use action=update to modify it.`);
    }
    if (a.action === 'update' && !exists) {
        return err(`${capitalize(cfg.typeLabel)} '${a.name}' not found. Use action=create to create it.`);
    }

    // Outside $TMP, a transport is mandatory — check the real target package (user-supplied
    // for create, read back from SAP for update, never guessed) rather than relying on SAP's
    // own downstream CTS error, which could surface after the object is already registered.
    const targetPackage = a.action === 'create' ? a.packageName : (existingMeta!.packageName || '');
    if (targetPackage.toUpperCase() !== '$TMP' && !a.transportNumber && !a.transportDescription) {
        return err(`${capitalize(cfg.typeLabel)} '${a.name}' targets package '${targetPackage || '(unknown)'}', not $TMP — transport_number or transport_description is required.`);
    }

    let effectiveTransport = a.transportNumber;
    let autoTaskNumber = '';
    if (!effectiveTransport && a.transportDescription) {
        const tRes = await createTransportForObject(String(baseUrl), `/sap/bc/adt/ddic/${cfg.collectionPath}/${lname}`, a.transportDescription, a.packageName);
        if (tRes.error) return err(tRes.error);
        effectiveTransport = tRes.transportNumber!;
        autoTaskNumber = tRes.taskNumber || '';
    }

    let created = false;
    if (a.action === 'create') {
        const body =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<${cfg.rootTag} xmlns:${cfg.rootNsPrefix}="${cfg.rootNsUri}" xmlns:adtcore="http://www.sap.com/adt/core"` +
            ` adtcore:name="${a.name}" adtcore:type="${cfg.adtType}" adtcore:description="${escapeXml(a.description)}">` +
            `<adtcore:packageRef adtcore:name="${a.packageName}"/>` +
            `</${cfg.rootTag}>`;
        const createParams: Record<string, string> = {};
        if (effectiveTransport) createParams['corrNr'] = effectiveTransport;
        try {
            await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/${cfg.collectionPath}`, 'POST', 30000, body, createParams, {
                'Content-Type': `${cfg.mime}; charset=UTF-8`,
                'Accept': cfg.mime
            });
            created = true;
        } catch (error) {
            return sapFail(error, `Failed to create ${cfg.typeLabel} '${a.name}'`);
        }
    }

    // ── Lock ──────────────────────────────────────────────────────────
    let lockHandle: string;
    let existingCorrNr = '';
    let existingCorrText = '';
    try {
        // Purge any leftover stateful session first (CLAUDE.md "Why removeCookie runs before every LOCK").
        removeCookie('sap-contextid');
        const lockResponse = await makeAdtRequest(objectUrl, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
            'Accept': LOCK_ACCEPT,
            'X-sap-adt-sessiontype': 'stateful'
        });
        const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
        const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctxMatch) {
            appendCookie(ctxMatch[1]);
            refreshStatefulOperationToken(ctxMatch[1]);
        }

        const lockData = parseLockResult(lockResponse.data);
        lockHandle = lockData.lockHandle;
        existingCorrNr = lockData.corrNr;
        existingCorrText = lockData.corrText;
        if (!lockHandle) throw new Error('Lock handle not found in response');
    } catch (error) {
        return lockFailResult(error, cfg.typeLabel, a.name);
    }

    // ── Reassignment guard ───────────────────────────────────────────
    const guardResult = await reassignmentGuard(objectUrl, lockHandle, existingCorrNr, existingCorrText, effectiveTransport, cfg.typeLabel, a.name);
    if (guardResult) return guardResult;

    // ── PUT source ────────────────────────────────────────────────────
    try {
        const putParams: Record<string, string> = { lockHandle };
        if (effectiveTransport) putParams['corrNr'] = effectiveTransport;
        await makeAdtRequest(`${objectUrl}/source/main`, 'PUT', 30000, a.sourceCode, putParams, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Accept': 'text/plain',
            'X-sap-adt-sessiontype': 'stateful'
        });
    } catch (error) {
        const unlockError = await attemptUnlock(objectUrl, lockHandle);
        return putFailResult(error, unlockError, cfg.typeLabel, a.name, lockHandle);
    }

    // ── Unlock ────────────────────────────────────────────────────────
    const unlockError = await attemptUnlock(objectUrl, lockHandle);

    // ── Activate ──────────────────────────────────────────────────────
    let activationResult = '';
    let readBack = '';
    let activationHasError = false;
    if (unlockError) {
        activationResult = `\n\nActivation SKIPPED — unlock FAILED after writing source.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object likely remains locked. Run UnlockObject('${a.name}') to clear it.`;
        activationHasError = true;
    } else {
        const actResult = await activateObject(String(baseUrl), `/sap/bc/adt/ddic/${cfg.collectionPath}/${lname}`, a.name, cfg.typeLabel);
        activationResult = actResult.text;
        activationHasError = actResult.isError;
        if (!actResult.isError) {
            try {
                const readResponse = await makeAdtRequest(`${objectUrl}/source/main`, 'GET', 15000);
                const savedSource = typeof readResponse.data === 'string' ? readResponse.data : String(readResponse.data || '');
                readBack = `\nRead-back: ${savedSource.length} characters.`;
            } catch (_) {
                readBack = '\nRead-back: failed to re-read source/main (non-fatal).';
            }
        }
    }

    const lines: string[] = [];
    if (created) lines.push(`Created ${cfg.typeLabel} '${a.name}' in package '${a.packageName}'.`);
    lines.push(`Source written to ${cfg.typeLabel} '${a.name}'.`);
    if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${!a.transportNumber && a.transportDescription ? ' (auto-created)' : ''}`);
    if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
    lines.push(`Source length: ${a.sourceCode.length} characters`);
    if (activationResult) lines.push(activationResult);
    if (readBack) lines.push(readBack);

    return { isError: activationHasError, content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── TABLE_TYPE ───────────────────────────────────────────────────────────
// Metadata-XML object, no /source/main. Create is a single POST (no lock/PUT). Update
// needs lock → PUT the full metadata document to the object's own URL → unlock → activate.
// accessType is always 'standard' — non-standard
// access and explicit key components are unverified and out of scope for this tool.

interface TableTypeArgs {
    action: 'create' | 'update';
    name: string;
    description: string;
    packageName: string;
    transportNumber: string;
    transportDescription: string;
    rowTypeName: string;
}

function tableTypeBody(name: string, description: string, packageName: string, rowTypeName: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>` +
        `<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:name="${name}" adtcore:type="TTYP/DA" adtcore:description="${escapeXml(description)}">` +
        `<adtcore:packageRef adtcore:name="${packageName}"/>` +
        `<ttyp:rowType>` +
        `<ttyp:typeKind>dictionaryType</ttyp:typeKind>` +
        `<ttyp:typeName>${rowTypeName}</ttyp:typeName>` +
        `<ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType>` +
        `<ttyp:rangeType/>` +
        `</ttyp:rowType>` +
        `<ttyp:accessType>standard</ttyp:accessType>` +
        `</ttyp:tableType>`;
}

async function manageTableType(a: TableTypeArgs): Promise<ToolResult> {
    const baseUrl = await getBaseUrl();
    const lname = a.name.toLowerCase();
    const objectUrl = `${baseUrl}/sap/bc/adt/ddic/tabletypes/${lname}`;

    const current = await tableTypeMetadata(objectUrl);
    if (a.action === 'create' && current) {
        return err(`Table type '${a.name}' already exists. Use action=update to modify it.`);
    }
    if (a.action === 'update' && !current) {
        return err(`Table type '${a.name}' not found. Use action=create to create it.`);
    }

    // Outside $TMP, a transport is mandatory — check the real target package (user-supplied
    // for create, read back from SAP for update, never guessed) rather than relying on SAP's
    // own downstream CTS error, which could surface after the object is already registered.
    const targetPackage = a.action === 'create' ? a.packageName : (current!.packageName || '');
    if (targetPackage.toUpperCase() !== '$TMP' && !a.transportNumber && !a.transportDescription) {
        return err(`Table type '${a.name}' targets package '${targetPackage || '(unknown)'}', not $TMP — transport_number or transport_description is required.`);
    }

    let effectiveTransport = a.transportNumber;
    let autoTaskNumber = '';
    if (!effectiveTransport && a.transportDescription) {
        const tRes = await createTransportForObject(String(baseUrl), `/sap/bc/adt/ddic/tabletypes/${lname}`, a.transportDescription, a.packageName);
        if (tRes.error) return err(tRes.error);
        effectiveTransport = tRes.transportNumber!;
        autoTaskNumber = tRes.taskNumber || '';
    }

    if (a.action === 'create') {
        const body = tableTypeBody(a.name, a.description, a.packageName, a.rowTypeName);
        const createParams: Record<string, string> = {};
        if (effectiveTransport) createParams['corrNr'] = effectiveTransport;
        try {
            await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/tabletypes`, 'POST', 30000, body, createParams, {
                'Content-Type': 'application/vnd.sap.adt.tabletype.v1+xml; charset=UTF-8',
                'Accept': 'application/vnd.sap.adt.tabletype.v1+xml'
            });
        } catch (error) {
            return sapFail(error, `Failed to create table type '${a.name}'`);
        }

        // No lock/PUT for create — the create POST is already the full definition.
        const actResult = await activateObject(String(baseUrl), '/sap/bc/adt/ddic/tabletypes/' + lname, a.name, 'table type');
        const lines: string[] = [
            `Created table type '${a.name}' in package '${a.packageName}' (row type: ${a.rowTypeName}, access: standard).`
        ];
        if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${a.transportDescription ? ' (auto-created)' : ''}`);
        if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
        lines.push(actResult.text);
        return { isError: actResult.isError, content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── update: lock → PUT full metadata (unchanged fields echoed) → unlock → activate ──
    let lockHandle: string;
    let existingCorrNr = '';
    let existingCorrText = '';
    try {
        // Purge any leftover stateful session first (CLAUDE.md "Why removeCookie runs before every LOCK").
        removeCookie('sap-contextid');
        const lockResponse = await makeAdtRequest(objectUrl, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
            'Accept': LOCK_ACCEPT,
            'X-sap-adt-sessiontype': 'stateful'
        });
        const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
        const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctxMatch) {
            appendCookie(ctxMatch[1]);
            refreshStatefulOperationToken(ctxMatch[1]);
        }

        const lockData = parseLockResult(lockResponse.data);
        lockHandle = lockData.lockHandle;
        existingCorrNr = lockData.corrNr;
        existingCorrText = lockData.corrText;
        if (!lockHandle) throw new Error('Lock handle not found in response');
    } catch (error) {
        return lockFailResult(error, 'table type', a.name);
    }

    const guardResult = await reassignmentGuard(objectUrl, lockHandle, existingCorrNr, existingCorrText, effectiveTransport, 'table type', a.name);
    if (guardResult) return guardResult;

    // current is guaranteed non-null here (checked above for action=update). Description is
    // not retrievable through any read path for TABLE_TYPE on this system — GET, quickSearch,
    // and objectproperties/values all show it empty, and the DD40T text table has zero rows
    // for a table type created moments earlier with a real description (verified live). SAP's
    // update PUT nonetheless requires a non-empty adtcore:description ("The description is
    // missing" on an empty one), so fall back to the object's own name purely to satisfy that
    // schema check — this does not change or expose the real description either way.
    const body = tableTypeBody(a.name, current!.description || a.name, current!.packageName, a.rowTypeName);
    try {
        const putParams: Record<string, string> = { lockHandle };
        if (effectiveTransport) putParams['corrNr'] = effectiveTransport;
        await makeAdtRequest(objectUrl, 'PUT', 30000, body, putParams, {
            'Content-Type': 'application/vnd.sap.adt.tabletype.v1+xml; charset=UTF-8',
            'Accept': 'application/vnd.sap.adt.tabletype.v1+xml',
            'X-sap-adt-sessiontype': 'stateful'
        });
    } catch (error) {
        const unlockError = await attemptUnlock(objectUrl, lockHandle);
        return putFailResult(error, unlockError, 'table type', a.name, lockHandle);
    }

    const unlockError = await attemptUnlock(objectUrl, lockHandle);

    let activationResult = '';
    let readBack = '';
    let activationHasError = false;
    if (unlockError) {
        activationResult = `\n\nActivation SKIPPED — unlock FAILED after writing.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object likely remains locked. Run UnlockObject('${a.name}') to clear it.`;
        activationHasError = true;
    } else {
        const actResult = await activateObject(String(baseUrl), '/sap/bc/adt/ddic/tabletypes/' + lname, a.name, 'table type');
        activationResult = actResult.text;
        activationHasError = actResult.isError;
        if (!actResult.isError) {
            const after = await tableTypeMetadata(objectUrl);
            readBack = after
                ? `\nRead-back: row type is now '${after.rowTypeName}', version '${after.version}'.`
                : '\nRead-back: failed to re-read table type metadata (non-fatal).';
        }
    }

    const lines: string[] = [`Row type of table type '${a.name}' updated to '${a.rowTypeName}'.`];
    if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${!a.transportNumber && a.transportDescription ? ' (auto-created)' : ''}`);
    if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
    if (activationResult) lines.push(activationResult);
    if (readBack) lines.push(readBack);

    return { isError: activationHasError, content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── DOMAIN ───────────────────────────────────────────────────────────────
// Metadata-XML object, no /source/main — simplest create of any type probed (worked on the
// first live attempt, no undocumented-required-element surprises). Same lock/unlock plumbing
// as TABLE_TYPE/DATA_ELEMENT. Shares TABLE_TYPE's description trap, not DATA_ELEMENT's: a
// domain's description is unretrievable via any read path, confirmed live BEFORE any update
// touched it — so, like TABLE_TYPE,
// action=update rejects a supplied description and falls back to the object's own name as a
// schema-satisfying placeholder. V1 scope: data_type/length/decimals only — no fixed values,
// value table reference, or output-format flags (unverified, see phase-6 Scope Recommendation).

interface DomainArgs {
    action: 'create' | 'update';
    name: string;
    description: string;
    packageName: string;
    transportNumber: string;
    transportDescription: string;
    dataType: string;
    length: number;
    decimals: number;
}

function domainBody(name: string, description: string, packageName: string, dataType: string, length: number, decimals: number): string {
    const lenStr = String(length).padStart(6, '0');
    const decStr = String(decimals).padStart(6, '0');
    return `<?xml version="1.0" encoding="UTF-8"?>` +
        `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:name="${name}" adtcore:type="DOMA/DD" adtcore:description="${escapeXml(description)}">` +
        `<adtcore:packageRef adtcore:name="${packageName}"/>` +
        `<doma:content>` +
        `<doma:typeInformation><doma:datatype>${dataType}</doma:datatype><doma:length>${lenStr}</doma:length><doma:decimals>${decStr}</doma:decimals></doma:typeInformation>` +
        `</doma:content>` +
        `</doma:domain>`;
}

function formatTypeSpec(dataType: string, length: number, decimals: number): string {
    return decimals ? `${dataType} ${length}.${decimals}` : `${dataType} ${length}`;
}

async function manageDomain(a: DomainArgs): Promise<ToolResult> {
    const baseUrl = await getBaseUrl();
    const lname = a.name.toLowerCase();
    const objectUrl = `${baseUrl}/sap/bc/adt/ddic/domains/${lname}`;

    const current = await domainObjectMetadata(objectUrl);
    if (a.action === 'create' && current) {
        return err(`Domain '${a.name}' already exists. Use action=update to modify it.`);
    }
    if (a.action === 'update' && !current) {
        return err(`Domain '${a.name}' not found. Use action=create to create it.`);
    }

    const targetPackage = a.action === 'create' ? a.packageName : (current!.packageName || '');
    if (targetPackage.toUpperCase() !== '$TMP' && !a.transportNumber && !a.transportDescription) {
        return err(`Domain '${a.name}' targets package '${targetPackage || '(unknown)'}', not $TMP — transport_number or transport_description is required.`);
    }

    let effectiveTransport = a.transportNumber;
    let autoTaskNumber = '';
    if (!effectiveTransport && a.transportDescription) {
        const tRes = await createTransportForObject(String(baseUrl), `/sap/bc/adt/ddic/domains/${lname}`, a.transportDescription, a.packageName);
        if (tRes.error) return err(tRes.error);
        effectiveTransport = tRes.transportNumber!;
        autoTaskNumber = tRes.taskNumber || '';
    }

    const effectivePackage = a.action === 'create' ? a.packageName : current!.packageName;
    const effectiveDescription = a.action === 'create' ? a.description : a.name;
    const body = domainBody(a.name, effectiveDescription, effectivePackage, a.dataType, a.length, a.decimals);

    if (a.action === 'create') {
        const createParams: Record<string, string> = {};
        if (effectiveTransport) createParams['corrNr'] = effectiveTransport;
        try {
            await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/domains`, 'POST', 30000, body, createParams, {
                'Content-Type': 'application/vnd.sap.adt.domains.v2+xml; charset=UTF-8',
                'Accept': 'application/vnd.sap.adt.domains.v2+xml'
            });
        } catch (error) {
            return sapFail(error, `Failed to create domain '${a.name}'`);
        }

        // No lock/PUT for create — the create POST is already the full definition.
        const actResult = await activateObject(String(baseUrl), '/sap/bc/adt/ddic/domains/' + lname, a.name, 'domain');
        const lines: string[] = [
            `Created domain '${a.name}' in package '${a.packageName}' (${formatTypeSpec(a.dataType, a.length, a.decimals)}).`
        ];
        if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${a.transportDescription ? ' (auto-created)' : ''}`);
        if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
        lines.push(actResult.text);
        return { isError: actResult.isError, content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── update: lock → PUT full metadata → unlock → activate ──
    let lockHandle: string;
    let existingCorrNr = '';
    let existingCorrText = '';
    try {
        // Purge any leftover stateful session first (CLAUDE.md "Why removeCookie runs before every LOCK").
        removeCookie('sap-contextid');
        const lockResponse = await makeAdtRequest(objectUrl, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
            'Accept': LOCK_ACCEPT,
            'X-sap-adt-sessiontype': 'stateful'
        });
        const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
        const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctxMatch) {
            appendCookie(ctxMatch[1]);
            refreshStatefulOperationToken(ctxMatch[1]);
        }

        const lockData = parseLockResult(lockResponse.data);
        lockHandle = lockData.lockHandle;
        existingCorrNr = lockData.corrNr;
        existingCorrText = lockData.corrText;
        if (!lockHandle) throw new Error('Lock handle not found in response');
    } catch (error) {
        return lockFailResult(error, 'domain', a.name);
    }

    const guardResult = await reassignmentGuard(objectUrl, lockHandle, existingCorrNr, existingCorrText, effectiveTransport, 'domain', a.name);
    if (guardResult) return guardResult;

    try {
        const putParams: Record<string, string> = { lockHandle };
        if (effectiveTransport) putParams['corrNr'] = effectiveTransport;
        await makeAdtRequest(objectUrl, 'PUT', 30000, body, putParams, {
            'Content-Type': 'application/vnd.sap.adt.domains.v2+xml; charset=UTF-8',
            'Accept': 'application/vnd.sap.adt.domains.v2+xml',
            'X-sap-adt-sessiontype': 'stateful'
        });
    } catch (error) {
        const unlockError = await attemptUnlock(objectUrl, lockHandle);
        return putFailResult(error, unlockError, 'domain', a.name, lockHandle);
    }

    const unlockError = await attemptUnlock(objectUrl, lockHandle);

    let activationResult = '';
    let readBack = '';
    let activationHasError = false;
    if (unlockError) {
        activationResult = `\n\nActivation SKIPPED — unlock FAILED after writing.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object likely remains locked. Run UnlockObject('${a.name}') to clear it.`;
        activationHasError = true;
    } else {
        const actResult = await activateObject(String(baseUrl), '/sap/bc/adt/ddic/domains/' + lname, a.name, 'domain');
        activationResult = actResult.text;
        activationHasError = actResult.isError;
        if (!actResult.isError) {
            const after = await domainObjectMetadata(objectUrl);
            readBack = after
                ? `\nRead-back: ${formatTypeSpec(after.dataType, Number(after.length), Number(after.decimals))}, version '${after.version}'.`
                : '\nRead-back: failed to re-read domain metadata (non-fatal).';
        }
    }

    const lines: string[] = [`Domain '${a.name}' updated to ${formatTypeSpec(a.dataType, a.length, a.decimals)}.`];
    if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${!a.transportNumber && a.transportDescription ? ' (auto-created)' : ''}`);
    if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
    if (activationResult) lines.push(activationResult);
    if (readBack) lines.push(readBack);

    return { isError: activationHasError, content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── DATA_ELEMENT ─────────────────────────────────────────────────────────
// Metadata-XML object with its own distinct shape: root is blue:wbobj (name/type/description/
// packageRef live on the outer wrapper), wrapping a nested dtel:dataElement with domain
// reference + all four field-label variants. Only
// typeKind=domain row types are supported — the domain's own dataType/length/decimals are
// looked up live and embedded, never guessed. Unlike TABLE_TYPE, description changes on
// update work normally (verified live) — no placeholder workaround needed here.

interface DataElementArgs {
    action: 'create' | 'update';
    name: string;
    description: string;
    packageName: string;
    transportNumber: string;
    transportDescription: string;
    domainName: string;
    shortLabel: string;
    mediumLabel: string;
    longLabel: string;
    headingLabel: string;
}

interface DomainMeta {
    dataType: string;
    length: string;
    decimals: string;
}

async function domainMetadata(baseUrl: string, domainName: string): Promise<DomainMeta | null> {
    const url = `${baseUrl}/sap/bc/adt/ddic/domains/${domainName.toLowerCase()}`;
    let xmlData: string;
    try {
        const response = await makeAdtRequest(url, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) return null;
        throw error;
    }
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const typeInfo = parsed?.['doma:domain']?.['doma:content']?.['doma:typeInformation'];
    if (!typeInfo) return null;
    return {
        dataType: typeInfo['doma:datatype']?._text || '',
        length: typeInfo['doma:length']?._text || '000000',
        decimals: typeInfo['doma:decimals']?._text || '000000'
    };
}

function dataElementBody(
    name: string, description: string, packageName: string,
    domainName: string, domain: DomainMeta,
    shortLabel: string, mediumLabel: string, longLabel: string, headingLabel: string
): string {
    const short = shortLabel.substring(0, 10);
    const medium = mediumLabel.substring(0, 20);
    const long = longLabel.substring(0, 40);
    const heading = headingLabel.substring(0, 55);
    const len2 = (s: string) => String(s.length).padStart(2, '0');

    return `<?xml version="1.0" encoding="UTF-8"?>` +
        `<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core"` +
        ` adtcore:name="${name}" adtcore:type="DTEL/DE" adtcore:description="${escapeXml(description)}">` +
        `<adtcore:packageRef adtcore:name="${packageName}"/>` +
        `<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">` +
        `<dtel:typeKind>domain</dtel:typeKind>` +
        `<dtel:typeName>${domainName}</dtel:typeName>` +
        `<dtel:dataType>${domain.dataType}</dtel:dataType>` +
        `<dtel:dataTypeLength>${domain.length}</dtel:dataTypeLength>` +
        `<dtel:dataTypeDecimals>${domain.decimals}</dtel:dataTypeDecimals>` +
        `<dtel:shortFieldLabel>${escapeXml(short)}</dtel:shortFieldLabel>` +
        `<dtel:shortFieldLength>${len2(short)}</dtel:shortFieldLength>` +
        `<dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>` +
        `<dtel:mediumFieldLabel>${escapeXml(medium)}</dtel:mediumFieldLabel>` +
        `<dtel:mediumFieldLength>${len2(medium)}</dtel:mediumFieldLength>` +
        `<dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>` +
        `<dtel:longFieldLabel>${escapeXml(long)}</dtel:longFieldLabel>` +
        `<dtel:longFieldLength>${len2(long)}</dtel:longFieldLength>` +
        `<dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>` +
        `<dtel:headingFieldLabel>${escapeXml(heading)}</dtel:headingFieldLabel>` +
        `<dtel:headingFieldLength>${len2(heading)}</dtel:headingFieldLength>` +
        `<dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>` +
        `<dtel:searchHelp/><dtel:searchHelpParameter/><dtel:setGetParameter/><dtel:defaultComponentName/>` +
        `<dtel:deactivateInputHistory>false</dtel:deactivateInputHistory>` +
        `<dtel:changeDocument>false</dtel:changeDocument>` +
        `<dtel:leftToRightDirection>false</dtel:leftToRightDirection>` +
        `<dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering>` +
        `</dtel:dataElement>` +
        `</blue:wbobj>`;
}

async function manageDataElement(a: DataElementArgs): Promise<ToolResult> {
    const baseUrl = await getBaseUrl();
    const lname = a.name.toLowerCase();
    const objectUrl = `${baseUrl}/sap/bc/adt/ddic/dataelements/${lname}`;

    const current = await dataElementMetadata(objectUrl);
    if (a.action === 'create' && current) {
        return err(`Data element '${a.name}' already exists. Use action=update to modify it.`);
    }
    if (a.action === 'update' && !current) {
        return err(`Data element '${a.name}' not found. Use action=create to create it.`);
    }

    const targetPackage = a.action === 'create' ? a.packageName : (current!.packageName || '');
    if (targetPackage.toUpperCase() !== '$TMP' && !a.transportNumber && !a.transportDescription) {
        return err(`Data element '${a.name}' targets package '${targetPackage || '(unknown)'}', not $TMP — transport_number or transport_description is required.`);
    }

    const domain = await domainMetadata(String(baseUrl), a.domainName);
    if (!domain) {
        return err(`Domain '${a.domainName}' not found. domain_name must be an existing, active domain.`);
    }

    const effectivePackage = a.action === 'create' ? a.packageName : current!.packageName;
    const effectiveDescription = a.description || (a.action === 'update' ? current!.description : '') || a.name;
    const effectiveShort = a.shortLabel || (a.action === 'update' ? current!.shortLabel : '') || effectiveDescription;
    const effectiveMedium = a.mediumLabel || (a.action === 'update' ? current!.mediumLabel : '') || effectiveDescription;
    const effectiveLong = a.longLabel || (a.action === 'update' ? current!.longLabel : '') || effectiveDescription;
    const effectiveHeading = a.headingLabel || (a.action === 'update' ? current!.headingLabel : '') || effectiveDescription;

    let effectiveTransport = a.transportNumber;
    let autoTaskNumber = '';
    if (!effectiveTransport && a.transportDescription) {
        const tRes = await createTransportForObject(String(baseUrl), `/sap/bc/adt/ddic/dataelements/${lname}`, a.transportDescription, a.packageName);
        if (tRes.error) return err(tRes.error);
        effectiveTransport = tRes.transportNumber!;
        autoTaskNumber = tRes.taskNumber || '';
    }

    const body = dataElementBody(a.name, effectiveDescription, effectivePackage, a.domainName, domain, effectiveShort, effectiveMedium, effectiveLong, effectiveHeading);

    if (a.action === 'create') {
        const createParams: Record<string, string> = {};
        if (effectiveTransport) createParams['corrNr'] = effectiveTransport;
        try {
            await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/dataelements`, 'POST', 30000, body, createParams, {
                'Content-Type': 'application/vnd.sap.adt.dataelements.v2+xml; charset=UTF-8',
                'Accept': 'application/vnd.sap.adt.dataelements.v2+xml'
            });
        } catch (error) {
            return sapFail(error, `Failed to create data element '${a.name}'`);
        }

        // No lock/PUT for create — the create POST is already the full definition.
        const actResult = await activateObject(String(baseUrl), '/sap/bc/adt/ddic/dataelements/' + lname, a.name, 'data element');
        const lines: string[] = [
            `Created data element '${a.name}' in package '${a.packageName}' (domain: ${a.domainName}).`
        ];
        if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${a.transportDescription ? ' (auto-created)' : ''}`);
        if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
        lines.push(actResult.text);
        return { isError: actResult.isError, content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── update: lock → PUT full metadata → unlock → activate ──
    let lockHandle: string;
    let existingCorrNr = '';
    let existingCorrText = '';
    try {
        // Purge any leftover stateful session first (CLAUDE.md "Why removeCookie runs before every LOCK").
        removeCookie('sap-contextid');
        const lockResponse = await makeAdtRequest(objectUrl, 'POST', 15000, '', { _action: 'LOCK', accessMode: 'MODIFY' }, {
            'Accept': LOCK_ACCEPT,
            'X-sap-adt-sessiontype': 'stateful'
        });
        const setCookies: string[] = lockResponse.headers?.['set-cookie'] || [];
        const ctxMatch = setCookies.join(' ').match(/(sap-contextid=[^;]+)/);
        if (ctxMatch) {
            appendCookie(ctxMatch[1]);
            refreshStatefulOperationToken(ctxMatch[1]);
        }

        const lockData = parseLockResult(lockResponse.data);
        lockHandle = lockData.lockHandle;
        existingCorrNr = lockData.corrNr;
        existingCorrText = lockData.corrText;
        if (!lockHandle) throw new Error('Lock handle not found in response');
    } catch (error) {
        return lockFailResult(error, 'data element', a.name);
    }

    const guardResult = await reassignmentGuard(objectUrl, lockHandle, existingCorrNr, existingCorrText, effectiveTransport, 'data element', a.name);
    if (guardResult) return guardResult;

    try {
        const putParams: Record<string, string> = { lockHandle };
        if (effectiveTransport) putParams['corrNr'] = effectiveTransport;
        await makeAdtRequest(objectUrl, 'PUT', 30000, body, putParams, {
            'Content-Type': 'application/vnd.sap.adt.dataelements.v2+xml; charset=UTF-8',
            'Accept': 'application/vnd.sap.adt.dataelements.v2+xml',
            'X-sap-adt-sessiontype': 'stateful'
        });
    } catch (error) {
        const unlockError = await attemptUnlock(objectUrl, lockHandle);
        return putFailResult(error, unlockError, 'data element', a.name, lockHandle);
    }

    const unlockError = await attemptUnlock(objectUrl, lockHandle);

    let activationResult = '';
    let readBack = '';
    let activationHasError = false;
    if (unlockError) {
        activationResult = `\n\nActivation SKIPPED — unlock FAILED after writing.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object likely remains locked. Run UnlockObject('${a.name}') to clear it.`;
        activationHasError = true;
    } else {
        const actResult = await activateObject(String(baseUrl), '/sap/bc/adt/ddic/dataelements/' + lname, a.name, 'data element');
        activationResult = actResult.text;
        activationHasError = actResult.isError;
        if (!actResult.isError) {
            const after = await dataElementMetadata(objectUrl);
            readBack = after
                ? `\nRead-back: domain '${after.domainName}', description '${after.description}'.`
                : '\nRead-back: failed to re-read data element metadata (non-fatal).';
        }
    }

    const lines: string[] = [`Data element '${a.name}' updated (domain: ${a.domainName}).`];
    if (effectiveTransport) lines.push(`Transport: ${effectiveTransport}${!a.transportNumber && a.transportDescription ? ' (auto-created)' : ''}`);
    if (autoTaskNumber) lines.push(`Task: ${autoTaskNumber}`);
    if (activationResult) lines.push(activationResult);
    if (readBack) lines.push(readBack);

    return { isError: activationHasError, content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── Shared helpers ─────────────────────────────────────────────────────

interface DdlSourceMeta {
    packageName: string;
}

async function ddlSourceMetadata(objectUrl: string, rootTag: string): Promise<DdlSourceMeta | null> {
    let xmlData: string;
    try {
        const response = await makeAdtRequest(objectUrl, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) return null;
        throw error;
    }
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const root = parsed?.[rootTag];
    if (!root) return null;
    return {
        packageName: root['adtcore:packageRef']?._attributes?.['adtcore:name'] || ''
    };
}

interface TableTypeMeta {
    description: string;
    packageName: string;
    rowTypeName: string;
    version: string;
}

async function tableTypeMetadata(objectUrl: string): Promise<TableTypeMeta | null> {
    let xmlData: string;
    try {
        const response = await makeAdtRequest(objectUrl, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) return null;
        throw error;
    }
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const root = parsed?.['ttyp:tableType'];
    if (!root) return null;
    const attrs = root._attributes || {};
    return {
        description: attrs['adtcore:description'] || '',
        packageName: root['adtcore:packageRef']?._attributes?.['adtcore:name'] || '',
        rowTypeName: root['ttyp:rowType']?.['ttyp:typeName']?._text || '',
        version: attrs['adtcore:version'] || ''
    };
}

interface DomainObjectMeta {
    packageName: string;
    dataType: string;
    length: string;
    decimals: string;
    version: string;
}

async function domainObjectMetadata(objectUrl: string): Promise<DomainObjectMeta | null> {
    let xmlData: string;
    try {
        const response = await makeAdtRequest(objectUrl, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) return null;
        throw error;
    }
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const root = parsed?.['doma:domain'];
    if (!root) return null;
    const attrs = root._attributes || {};
    const typeInfo = root['doma:content']?.['doma:typeInformation'] || {};
    return {
        packageName: root['adtcore:packageRef']?._attributes?.['adtcore:name'] || '',
        dataType: typeInfo['doma:datatype']?._text || '',
        length: typeInfo['doma:length']?._text || '000000',
        decimals: typeInfo['doma:decimals']?._text || '000000',
        version: attrs['adtcore:version'] || ''
    };
}

interface DataElementMeta {
    description: string;
    packageName: string;
    domainName: string;
    shortLabel: string;
    mediumLabel: string;
    longLabel: string;
    headingLabel: string;
}

async function dataElementMetadata(objectUrl: string): Promise<DataElementMeta | null> {
    let xmlData: string;
    try {
        const response = await makeAdtRequest(objectUrl, 'GET', 15000, undefined, undefined, { 'Accept': 'application/xml, */*' });
        xmlData = typeof response.data === 'string' ? response.data : String(response.data || '');
    } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) return null;
        throw error;
    }
    const convert = require('xml-js');
    const parsed = convert.xml2js(xmlData, { compact: true }) as any;
    const root = parsed?.['blue:wbobj'];
    if (!root) return null;
    const attrs = root._attributes || {};
    const dtel = root['dtel:dataElement'] || {};
    return {
        description: attrs['adtcore:description'] || '',
        packageName: root['adtcore:packageRef']?._attributes?.['adtcore:name'] || '',
        domainName: dtel['dtel:typeName']?._text || '',
        shortLabel: dtel['dtel:shortFieldLabel']?._text || '',
        mediumLabel: dtel['dtel:mediumFieldLabel']?._text || '',
        longLabel: dtel['dtel:longFieldLabel']?._text || '',
        headingLabel: dtel['dtel:headingFieldLabel']?._text || ''
    };
}

function parseLockResult(data: any): { lockHandle: string; corrNr: string; corrText: string } {
    const lockXml = typeof data === 'string' ? data : String(data || '');
    const convert = require('xml-js');
    const parsed = convert.xml2js(lockXml, { compact: true }) as any;
    const lockData = parsed?.['asx:abap']?.['asx:values']?.['DATA'] || {};
    return {
        lockHandle: lockData?.['LOCK_HANDLE']?._text || '',
        corrNr: lockData?.['CORRNR']?._text || '',
        corrText: lockData?.['CORRTEXT']?._text || ''
    };
}

async function reassignmentGuard(
    objectUrl: string, lockHandle: string, existingCorrNr: string, existingCorrText: string,
    effectiveTransport: string, typeLabel: string, name: string
): Promise<ToolResult | null> {
    if (!(effectiveTransport && existingCorrNr && existingCorrNr !== effectiveTransport)) return null;
    const unlockError = await attemptUnlock(objectUrl, lockHandle);
    const label = capitalize(typeLabel);
    const txt = existingCorrText ? ` ("${existingCorrText}")` : '';
    const lines = [
        `${label} '${name}' is already locked in change request ${existingCorrNr}${txt}.`,
        `Refusing to reassign it to ${effectiveTransport} — an object must stay in a single change request.`,
        `Re-run with transport_number=${existingCorrNr}, or omit transport_number to keep using the existing one.`
    ];
    if (unlockError) lines.push(`Additionally, failed to release the lock taken for this check.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object may now remain locked — retry with UnlockObject('${name}') before the next attempt.`);
    return err(lines.join('\n'));
}

function lockFailResult(error: unknown, typeLabel: string, name: string): ToolResult {
    if (error instanceof AxiosError && error.response?.data) {
        const errMsg = parseAdtErrorXml(String(error.response.data));
        if (errMsg) {
            const lines = [`Failed to lock ${typeLabel} '${name}'.`, `Reason: ${errMsg}`];
            const lockedByLine = describeLockHolder(errMsg);
            if (lockedByLine) lines.push(lockedByLine);
            return err(lines.join('\n'));
        }
    }
    return return_error(error);
}

function putFailResult(error: unknown, unlockError: string | null, typeLabel: string, name: string, lockHandle: string): ToolResult {
    const unlockNote = unlockError
        ? `\nAdditionally, failed to release the lock.\nReason: ${unlockError}\nLock handle: ${lockHandle}. The object may now remain locked — retry with UnlockObject('${name}') before the next attempt.`
        : '';
    if (error instanceof AxiosError && error.response?.data) {
        const errMsg = parseAdtErrorXml(String(error.response.data));
        if (errMsg) return err(`Failed to write ${typeLabel} '${name}'.\nReason: ${errMsg}${unlockNote}`);
    }
    const baseResult = return_error(error);
    if (unlockNote && baseResult?.content?.[0]?.type === 'text') {
        baseResult.content[0].text += unlockNote;
    }
    return baseResult;
}

function sapFail(error: unknown, prefix: string): ToolResult {
    if (error instanceof AxiosError && error.response?.data) {
        const errMsg = parseAdtErrorXml(String(error.response.data));
        if (errMsg) return err(`${prefix}.\nReason: ${errMsg}`);
    }
    const baseResult = return_error(error);
    if (baseResult?.content?.[0]?.type === 'text') {
        baseResult.content[0].text = `${prefix}: ${baseResult.content[0].text}`;
    }
    return baseResult;
}

async function activateObject(baseUrl: string, uriPath: string, name: string, typeLabel: string): Promise<{ isError: boolean; text: string }> {
    try {
        const activationBody =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
            `<adtcore:objectReference adtcore:uri="${uriPath}" adtcore:name="${name}"/>` +
            `</adtcore:objectReferences>`;

        const actResponse = await makeAdtRequest(
            `${baseUrl}/sap/bc/adt/activation`, 'POST', 30000,
            activationBody, { method: 'activate', preauditRequested: true },
            { 'Content-Type': 'application/xml', 'Accept': 'application/xml' }
        );

        const actData = typeof actResponse.data === 'string' ? actResponse.data : String(actResponse.data || '');
        const hasBody = actData.trim().length > 0;
        const activationFailed = hasBody && (
            actData.includes('activationExecuted="false"') ||
            actData.includes('type="E"') ||
            actData.includes('status="fail"') ||
            actData.includes('severity="error"')
        );

        if (!activationFailed) {
            return { isError: false, text: `${capitalize(typeLabel)} activated successfully.` };
        }

        try {
            const convert = require('xml-js');
            const parsed = convert.xml2js(actData, { compact: false }) as any;
            const messages: string[] = [];
            const extractMessages = (node: any) => {
                if (!node) return;
                if (node.name === 'msg' && node.attributes) {
                    const msgType = node.attributes['type'] || '';
                    const line = node.attributes['line'] || '';
                    const objDescr = node.attributes['objDescr'] || '';
                    const texts: string[] = [];
                    const shortTextNode = node.elements?.find((e: any) => e.name === 'shortText');
                    if (shortTextNode?.elements) {
                        for (const txtNode of shortTextNode.elements) {
                            if (txtNode.name === 'txt' && txtNode.elements?.[0]?.text) texts.push(txtNode.elements[0].text);
                        }
                    }
                    if (texts.length > 0) {
                        let msg = `  [${msgType}]`;
                        if (objDescr) msg += ` ${objDescr}`;
                        if (line && line !== '0') msg += ` Line ${line}`;
                        msg += `: ${texts.join(' — ')}`;
                        messages.push(msg);
                    }
                }
                if (node.elements) for (const child of node.elements) extractMessages(child);
            };
            extractMessages(parsed);
            return {
                isError: true,
                text: messages.length > 0
                    ? `Activation FAILED with errors:\n${messages.join('\n')}`
                    : `Activation FAILED. Raw response:\n${actData.substring(0, 2000)}`
            };
        } catch (_) {
            return { isError: true, text: `Activation FAILED. Raw response:\n${actData.substring(0, 2000)}` };
        }
    } catch (error) {
        if (error instanceof AxiosError && error.response?.data) {
            const errMsg = parseAdtErrorXml(String(error.response.data));
            return { isError: true, text: `Activation failed: ${errMsg || String(error.response.data).substring(0, 500)}` };
        }
        return { isError: true, text: `Activation failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
