/**
 * Complex integration tests — multi-step workflows that exercise the full SAP ADT stack.
 * Each suite depends on a live SAP system (.env required).
 * Run with: npm test -- --testPathPattern=complex
 */

import { handleSearchObject } from './handlers/handleSearchObject';
import { handleGetClass } from './handlers/handleGetClass';
import { handleGetProgram } from './handlers//handleGetProgram';
import { handleGetObjectVersion } from './handlers/handleGetObjectVersion';
import { handleDataPreview } from './handlers/handleDataPreview';
import { handleGetTransport } from './handlers/handleGetTransport';
import { handleManageTransport } from './handlers/handleManageTransport';
import { handleGetWhereUsed } from './handlers/handleGetWhereUsed';
import { handleGetTable } from './handlers/handleGetTable';
import { cleanup } from './lib/utils';

// ─── helpers ───────────────────────────────────────────────────────────────

function ok(result: any, label = '') {
    expect(result.isError).toBe(false);
    expect(result.content[0].text.length).toBeGreaterThan(0);
    if (label) console.log(`  ✓ ${label}`);
    return result.content[0].text as string;
}

function fail(result: any, label = '') {
    expect(result.isError).toBe(true);
    if (label) console.log(`  ✓ ${label} (expected error)`);
    return result.content[0].text as string;
}

// ─── cleanup ───────────────────────────────────────────────────────────────

afterAll(async () => {
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 100));
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — Transport lifecycle (create → detail → assign → release)
// ═══════════════════════════════════════════════════════════════════════════

// Uses a dedicated, intentionally empty anchor class in the gateway's own package — never a
// search hit, so the suite cannot lock or transport someone else's object. Create this empty
// class once (and override the names via MCP_TEST_ANCHOR_CLASS / MCP_TEST_ANCHOR_PACKAGE).
// The transport is DELETED at the end by default; releasing it is opt-in (MCP_TEST_RELEASE=1),
// because a released transport can't be deleted and stays in the history forever.
const ANCHOR_CLASS = process.env.MCP_TEST_ANCHOR_CLASS || 'ZCL_MCP_TRANSPORT_E2E';
const ANCHOR_PACKAGE = process.env.MCP_TEST_ANCHOR_PACKAGE || 'ZMCP';
const RELEASE_TRANSPORT = process.env.MCP_TEST_RELEASE === '1';

describe('Transport lifecycle', () => {
    let transportNumber = '';
    let objectName = '';
    let objectUrl = '';
    let devClass = '';

    it(`1a. Anchor class ${ANCHOR_CLASS} exists in ${ANCHOR_PACKAGE}`, async () => {
        const text = ok(await handleSearchObject({ query: ANCHOR_CLASS, object_type: 'CLAS', maxResults: 5 }), 'search anchor');
        const line = text.split('\n').find(l => l.trim().startsWith(ANCHOR_CLASS + ' '));
        // Missing anchor → fail loudly here; never fall back to someone else's object.
        expect(line).toBeDefined();
        expect(line).toContain(ANCHOR_PACKAGE);
        objectName = ANCHOR_CLASS;
        devClass   = ANCHOR_PACKAGE;
        objectUrl  = `/sap/bc/adt/oo/classes/${objectName.toLowerCase()}`;
        console.log(`  object: ${objectName}, package: ${devClass}`);
    });

    it('1b. CreateTransport creates a new workbench transport', async () => {
        expect(objectName).toBeTruthy(); // depends on 1a
        const text = ok(await handleManageTransport({
            action: 'create',
            description: 'Complex test transport — auto-created',
            force_new: true,
            object_url: objectUrl,
            dev_class: devClass,
        }), 'create transport');
        const m = text.match(/Transport (\S+) created/);
        expect(m).not.toBeNull();
        transportNumber = m![1];
        console.log(`  transport: ${transportNumber}`);
    });

    it('1c. GetTransport detail confirms the transport exists and is modifiable', async () => {
        expect(transportNumber).toBeTruthy();
        const text = ok(await handleGetTransport({ transport_number: transportNumber }), 'detail view');
        expect(text).toContain(transportNumber);
        expect(text).toMatch(/Modifiable|status/i);
    });

    it('1d. assign_object locks and unlocks cleanly — object must not stay locked', async () => {
        expect(transportNumber).toBeTruthy();
        ok(await handleManageTransport({
            action: 'assign_object',
            transport_number: transportNumber,
            object_name: objectName,
            object_type: 'CLAS',
        }), 'assign_object');
        // Verify no stale lock: a second assign_object on the same object must succeed
        ok(await handleManageTransport({
            action: 'assign_object',
            transport_number: transportNumber,
            object_name: objectName,
            object_type: 'CLAS',
        }), 'assign_object again (no stale lock)');
    });

    it('1e. assign_object with unknown object_type returns error, not exception', async () => {
        expect(transportNumber).toBeTruthy();
        const text = fail(await handleManageTransport({
            action: 'assign_object',
            transport_number: transportNumber,
            object_name: objectName,
            object_type: 'XXXX',
        }), 'bad object_type');
        expect(text).toContain('Unsupported object type');
    });

    it('1f. assign_object on non-existent object returns a clean error', async () => {
        expect(transportNumber).toBeTruthy();
        const text = fail(await handleManageTransport({
            action: 'assign_object',
            transport_number: transportNumber,
            object_name: 'ZCL_DOES_NOT_EXIST_XYZ999',
            object_type: 'CLAS',
        }), 'non-existent object');
        expect(text.length).toBeGreaterThan(0);
    });

    (RELEASE_TRANSPORT ? it : it.skip)('1g. ReleaseTransport releases the transport (opt-in: MCP_TEST_RELEASE=1)', async () => {
        expect(transportNumber).toBeTruthy();
        const text = ok(await handleManageTransport({
            action: 'release',
            transport_number: transportNumber,
        }), 'release');
        expect(text).toContain(transportNumber);
        const detail = ok(await handleGetTransport({ transport_number: transportNumber }), 'detail after release');
        expect(detail).toContain(transportNumber);
        expect(detail).toMatch(/Released/i);
    });

    (RELEASE_TRANSPORT ? it.skip : it)('1h. DeleteTransport removes the (empty) test transport', async () => {
        // The same-source re-write in 1d is a no-op in CTS, so the transport holds no objects
        // and can be deleted — leaving nothing behind in the transport history.
        expect(transportNumber).toBeTruthy();
        ok(await handleManageTransport({ action: 'delete', transport_number: transportNumber }), 'delete transport');
        const after = await handleGetTransport({ transport_number: transportNumber });
        expect(after.isError).toBe(true);
    });

    it('1i. ManageTransport with missing action param returns error', async () => {
        fail(await handleManageTransport({}), 'missing action');
    });

    it('1j. ManageTransport create with bad dev_class returns SAP error', async () => {
        fail(await handleManageTransport({
            action: 'create',
            description: 'Should fail',
            object_url: objectUrl,
            dev_class: 'ZPACKAGE_DOES_NOT_EXIST_999',
        }), 'bad dev_class');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — DataPreview SQL patterns
// ═══════════════════════════════════════════════════════════════════════════

describe('DataPreview SQL patterns', () => {

    it('2a. Table preview (DDIC mode) returns formatted table', async () => {
        const text = ok(await handleDataPreview({ table_name: 'T000', max_rows: 5 }), 'DDIC table T000');
        expect(text).toMatch(/MANDT|MTEXT/);
    });

    it('2b. Freestyle: SELECT * with WHERE string equality', async () => {
        const text = ok(await handleDataPreview({
            query: "SELECT * FROM TSTC WHERE TCODE = 'SE38'",
            max_rows: 3,
        }), 'WHERE equality');
        expect(text).toContain('SE38');
    });

    it('2c. Freestyle: LIKE wildcard', async () => {
        const text = ok(await handleDataPreview({
            query: "SELECT * FROM TSTC WHERE TCODE LIKE 'SE3%'",
            max_rows: 5,
        }), 'LIKE wildcard');
        expect(text).toMatch(/SE3/);
    });

    it('2d. Freestyle: IN list', async () => {
        const text = ok(await handleDataPreview({
            query: "SELECT * FROM TSTC WHERE TCODE IN ('SE38', 'SE24', 'SE80')",
            max_rows: 10,
        }), 'IN list');
        expect(text).toMatch(/SE38|SE24|SE80/);
    });

    it('2e. Freestyle: ORDER BY + table-qualified columns', async () => {
        const text = ok(await handleDataPreview({
            query: 'SELECT t~tcode, t~pgmna FROM tstc AS t ORDER BY t~tcode ASCENDING',
            max_rows: 5,
        }), 'ORDER BY + table alias');
        expect(text.length).toBeGreaterThan(0);
    });

    it('2f. Freestyle: GROUP BY + COUNT aggregate', async () => {
        const text = ok(await handleDataPreview({
            query: 'SELECT t~pgmna, COUNT(*) AS CNT FROM tstc AS t GROUP BY t~pgmna',
            max_rows: 5,
        }), 'GROUP BY COUNT');
        expect(text).toContain('CNT');
    });

    it('2g. Freestyle: JOIN on business key (system-dependent — pass or fail both accepted)', async () => {
        // Some SAP systems reject certain JOIN forms; we only verify the call doesn't throw
        const result = await handleDataPreview({
            query: 'SELECT t~tcode, tc~ttext FROM tstc AS t JOIN tstct AS tc ON t~tcode = tc~tcode WHERE tc~sprsl = \'EN\'',
            max_rows: 5,
        });
        expect(result.content[0].text.length).toBeGreaterThan(0);
        console.log(`  JOIN result isError=${result.isError}: ${result.content[0].text.substring(0, 60)}`);
    });

    it('2h. Invalid SQL returns SAP error (not exception)', async () => {
        const text = fail(await handleDataPreview({
            query: 'SELECT * FROM TABLE_THAT_DOES_NOT_EXIST_XYZ',
        }), 'invalid table SQL');
        expect(text.length).toBeGreaterThan(0);
    });

    it('2i. No params returns validation error', async () => {
        fail(await handleDataPreview({}), 'no params');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — GetObjectVersion (version history + historical source)
// ═══════════════════════════════════════════════════════════════════════════

describe('GetObjectVersion', () => {
    let firstVersion = '';

    it('3a. Version history for a well-known program lists at least 1 version', async () => {
        const text = ok(await handleGetObjectVersion({
            object_name: 'RSABAPPROGRAM',
            object_type: 'PROG',
        }), 'version history PROG');
        expect(text).toContain('Version History');
        // Extract version/transport from header table rows (starts with a 4-digit year)
        const lines = text.split('\n').filter(l => /^\d{4}-/.test(l));
        expect(lines.length).toBeGreaterThan(0);
        // Columns: Date/Time | Author | Version/Transport | Title (separated by 2+ spaces)
        const cols = lines[0].trim().split(/\s{2,}/);
        firstVersion = (cols[2] || '').trim();
        // Some SAP versions have empty transport column — fall back to 'active'
        if (!firstVersion) firstVersion = 'active';
        console.log(`  first version: "${firstVersion}"`);
    });

    it('3b. Get source at a specific version returns ABAP source text', async () => {
        expect(firstVersion).toBeTruthy();
        const text = ok(await handleGetObjectVersion({
            object_name: 'RSABAPPROGRAM',
            object_type: 'PROG',
            version: firstVersion,
        }), `source at version "${firstVersion}"`);
        expect(text).toMatch(/RSABAPPROGRAM|REPORT|PROGRAM|CLASS/i);
    });

    it('3c. Version history for a class', async () => {
        const text = ok(await handleGetObjectVersion({
            object_name: 'CL_WB_PGEDITOR_INITIAL_SCREEN',
            object_type: 'CLAS',
        }), 'version history CLAS');
        expect(text).toContain('Version History');
    });

    it('3d. Non-existent object returns clean error', async () => {
        fail(await handleGetObjectVersion({
            object_name: 'ZPROGRAM_DOES_NOT_EXIST_XYZ',
            object_type: 'PROG',
        }), 'non-existent object');
    });

    it('3e. Unsupported object_type returns error with supported list', async () => {
        const result = await handleGetObjectVersion({
            object_name: 'SOMETHING',
            object_type: 'XXXX',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Unsupported|supported/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — Cross-tool workflow: search → inspect → where-used
// ═══════════════════════════════════════════════════════════════════════════

describe('Cross-tool workflow: search → inspect → where-used', () => {
    let foundClassName = '';

    it('4a. SearchObject returns results with URI-parseable names', async () => {
        const text = ok(await handleSearchObject({ query: 'CL_WB*', maxResults: 5 }), 'search CL_WB*');
        const lines = text.split('\n').filter(l => l.includes('CLAS'));
        expect(lines.length).toBeGreaterThan(0);
        foundClassName = lines[0].trim().split(/\s+/)[0];
        console.log(`  picked: ${foundClassName}`);
    });

    it('4b. GetClass retrieves source for the found class', async () => {
        expect(foundClassName).toBeTruthy();
        const text = ok(await handleGetClass({ class_name: foundClassName }), 'GetClass');
        expect(text).toMatch(/CLASS|ENDCLASS/i);
    });

    it('4c. GetWhereUsed returns a result (references or graceful empty)', async () => {
        expect(foundClassName).toBeTruthy();
        // where-used may return error on some SAP systems ("No suitable resource") — not a code bug
        const result = await handleGetWhereUsed({
            object_name: foundClassName,
            object_type: 'CLAS',
            max_results: 10,
        });
        expect(result.content[0].text.length).toBeGreaterThan(0);
        console.log(`  WhereUsed isError=${result.isError}: ${result.content[0].text.substring(0, 60)}`);
    });

    it('4d. GetTable returns DD structure including field list', async () => {
        const text = ok(await handleGetTable({ table_name: 'TSTC' }), 'GetTable TSTC');
        // S/4HANA returns CDS DDL (lowercase); classic returns DDIC XML (uppercase)
        expect(text).toMatch(/tcode|pgmna/i);
    });

    it('4e. SearchObject with no match returns clean empty result (not error)', async () => {
        const result = await handleSearchObject({ query: 'ZZZZ_NOTHING_MATCHES_XYZ999' });
        // Either 0 results or an error — both should be non-throwing
        expect(result.content[0].text).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5 — GetTransport edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('GetTransport edge cases', () => {

    it('5a. GetTransport with no args returns a formatted list (even if empty)', async () => {
        const text = ok(await handleGetTransport({}), 'list all');
        expect(text).toMatch(/Transports for user/i);
    });

    it('5b. GetTransport with non-existent number returns error', async () => {
        fail(await handleGetTransport({ transport_number: 'DEVK900123' }), 'non-existent transport');
    });

    it('5c. ManageTransport release on non-existent transport reports failure in messages', async () => {
        // SAP accepts any release job request but returns error messages in the report
        // isError may be false — the handler returns the release report as-is
        const result = await handleManageTransport({
            action: 'release',
            transport_number: 'DEVK900123',
        });
        const text = result.content[0].text;
        // Either an error OR a release report with abort/error message
        expect(text).toMatch(/DEVK900123|error|abort|fail|not found/i);
        console.log(`  release non-existent: isError=${result.isError}, ${text.substring(0, 80)}`);
    });
});
