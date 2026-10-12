/**
 * Exception and edge-case tests for recently added/fixed tools.
 *
 * Validates that handlers return structured errors instead of throwing,
 * and that empty/unexpected ADT responses are handled gracefully.
 *
 * Run with: npm test -- --testPathPattern=exception
 */

import { handleGetDDICObject } from './handlers/handleGetDDICObject';
import { handleGetTransport } from './handlers/handleGetTransport';
import { handleManageTransport } from './handlers/handleManageTransport';
import { handleGetObjectVersion } from './handlers/handleGetObjectVersion';
import { handleWriteProgram } from './handlers/handleWriteProgram';
import { cleanup } from './lib/utils';

// ─── helpers ───────────────────────────────────────────────────────────────

function ok(result: any, label = ''): string {
    expect(result.isError).toBe(false);
    expect(result.content[0].text.length).toBeGreaterThan(0);
    if (label) console.log(`  ✓ ${label}`);
    return result.content[0].text as string;
}

function fail(result: any, label = ''): string {
    expect(result.isError).toBe(true);
    if (label) console.log(`  ✓ ${label} (expected error)`);
    return result.content[0].text as string;
}

afterAll(async () => {
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 100));
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — GetDDICObject: happy path + all error branches
// ═══════════════════════════════════════════════════════════════════════════

describe('GetDDICObject', () => {

    // ── Happy path ───────────────────────────────────────────────────────

    it('1a. DATA_ELEMENT BUKRS returns structured output with labels', async () => {
        const text = ok(await handleGetDDICObject({ object_type: 'DATA_ELEMENT', name: 'BUKRS' }), 'DATA_ELEMENT BUKRS');
        expect(text).toMatch(/Data Element/i);
        expect(text).toContain('BUKRS');
    });

    it('1b. DOMAIN XFELD returns domain info (fixed values expected)', async () => {
        const text = ok(await handleGetDDICObject({ object_type: 'DOMAIN', name: 'XFELD' }), 'DOMAIN XFELD');
        expect(text).toMatch(/Domain/i);
    });

    it('1c. DOMAIN BUKRS returns data type info', async () => {
        const text = ok(await handleGetDDICObject({ object_type: 'DOMAIN', name: 'BUKRS' }), 'DOMAIN BUKRS');
        expect(text).toMatch(/Domain/i);
        expect(text).toMatch(/Data Type/i);
    });

    // ── 404 from ADT: must return isError=true, not throw ────────────────

    it('1d. Non-existent DATA_ELEMENT returns clean error', async () => {
        const text = fail(
            await handleGetDDICObject({ object_type: 'DATA_ELEMENT', name: 'ZZZZ_DOES_NOT_EXIST_999' }),
            'non-existent dtel'
        );
        expect(text.length).toBeGreaterThan(0);
    });

    it('1e. Non-existent DOMAIN returns clean error', async () => {
        fail(
            await handleGetDDICObject({ object_type: 'DOMAIN', name: 'ZZZZ_DOES_NOT_EXIST_999' }),
            'non-existent domain'
        );
    });

    it('1f. Non-existent CDS view returns clean error', async () => {
        fail(
            await handleGetDDICObject({ object_type: 'CDS', name: 'ZZZZ_DOES_NOT_EXIST_999' }),
            'non-existent CDS'
        );
    });

    // ── Missing / invalid params: must return isError=true ────────────────

    it('1g. Missing object_type returns validation error', async () => {
        fail(await handleGetDDICObject({ name: 'BUKRS' }), 'missing object_type');
    });

    it('1h. Missing name returns validation error', async () => {
        fail(await handleGetDDICObject({ object_type: 'DATA_ELEMENT' }), 'missing name');
    });

    it('1i. No args returns validation error', async () => {
        fail(await handleGetDDICObject({}), 'no args');
    });

    it('1j. Unknown object_type returns error mentioning valid types', async () => {
        const text = fail(
            await handleGetDDICObject({ object_type: 'UNKNOWN', name: 'BUKRS' }),
            'unknown object_type'
        );
        expect(text).toMatch(/CDS|DATA_ELEMENT|DOMAIN/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — GetTransport: user param + formatList empty-response guard
// ═══════════════════════════════════════════════════════════════════════════

describe('GetTransport edge cases', () => {

    it('2a. No args returns formatted list with "Transports for user" header', async () => {
        const text = ok(await handleGetTransport({}), 'no args → list');
        expect(text).toMatch(/Transports for user/i);
    });

    it('2b. user param: non-existent SAP user returns "No transports found" (not exception)', async () => {
        const text = ok(await handleGetTransport({ user: 'ZNOSUCHTESTUSER999' }), 'user with no transports');
        // formatList must NOT throw — must return "No transports found" or empty section
        expect(text).toMatch(/Transports for user.*ZNOSUCHTESTUSER999|No transports found/is);
    });

    it('2c. transport_number is normalised to uppercase', async () => {
        // lowercase input — should still fail with the uppercased number in the message
        const result = await handleGetTransport({ transport_number: 'dev0000000' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/DEV0000000/i);
    });

    it('2d. Non-existent transport_number returns clean error (not exception)', async () => {
        fail(await handleGetTransport({ transport_number: 'DEVK900123' }), 'non-existent transport');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — ManageTransport: all missing-param branches
// ═══════════════════════════════════════════════════════════════════════════

describe('ManageTransport missing params', () => {

    it('3a. No args returns error listing supported actions', async () => {
        const text = fail(await handleManageTransport({}), 'no args');
        expect(text).toMatch(/create|release|assign_object/i);
    });

    it('3b. Unknown action returns clean error', async () => {
        const text = fail(await handleManageTransport({ action: 'BOGUS' }), 'unknown action');
        expect(text).toMatch(/Unknown action/i);
    });

    // create ──────────────────────────────────────────────────────────────

    it('3c. create: missing description returns validation error', async () => {
        fail(await handleManageTransport({
            action: 'create',
            object_url: '/sap/bc/adt/oo/classes/ZCL_TEST',
            dev_class: 'ZBASIS',
        }), 'create without description');
    });

    it('3d. create: description > 60 chars returns validation error mentioning limit', async () => {
        const text = fail(await handleManageTransport({
            action: 'create',
            description: 'A'.repeat(61),
            object_url: '/sap/bc/adt/oo/classes/ZCL_TEST',
            dev_class: 'ZBASIS',
        }), 'description too long');
        expect(text).toMatch(/60/);
    });

    it('3e. create: missing object_url returns validation error', async () => {
        fail(await handleManageTransport({
            action: 'create',
            description: 'Test',
            dev_class: 'ZBASIS',
        }), 'create without object_url');
    });

    it('3f. create: missing dev_class returns validation error', async () => {
        fail(await handleManageTransport({
            action: 'create',
            description: 'Test',
            object_url: '/sap/bc/adt/oo/classes/ZCL_TEST',
        }), 'create without dev_class');
    });

    // release ─────────────────────────────────────────────────────────────

    it('3g. release: missing transport_number returns validation error', async () => {
        fail(await handleManageTransport({ action: 'release' }), 'release without transport_number');
    });

    // assign_object ───────────────────────────────────────────────────────

    it('3h. assign_object: missing object_name returns validation error', async () => {
        fail(await handleManageTransport({
            action: 'assign_object',
            object_type: 'CLAS',
            transport_number: 'DEVK900123',
        }), 'assign_object without object_name');
    });

    it('3i. assign_object: missing object_type returns validation error', async () => {
        fail(await handleManageTransport({
            action: 'assign_object',
            object_name: 'ZCL_TEST',
            transport_number: 'DEVK900123',
        }), 'assign_object without object_type');
    });

    it('3j. assign_object: missing transport_number returns validation error', async () => {
        fail(await handleManageTransport({
            action: 'assign_object',
            object_name: 'ZCL_TEST',
            object_type: 'CLAS',
        }), 'assign_object without transport_number');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — WriteProgram: validation + lock failure + activation error parsing
// ═══════════════════════════════════════════════════════════════════════════

describe('WriteProgram', () => {

    // Discovered at runtime so write tests can be skipped if no Z program exists
    let targetProgram = '';
    let originalSource = '';

    // ── Param validation (no SAP call) ────────────────────────────────────

    it('4a. Missing program_name returns validation error', async () => {
        fail(await handleWriteProgram({ source_code: 'REPORT ZTEST.' }), 'missing program_name');
    });

    it('4b. Empty source_code returns validation error', async () => {
        fail(await handleWriteProgram({ program_name: 'ZTEST', source_code: '' }), 'empty source');
    });

    it('4c. Whitespace-only source_code returns validation error', async () => {
        fail(await handleWriteProgram({ program_name: 'ZTEST', source_code: '   \n  \t' }), 'whitespace source');
    });

    it('4d. No args returns validation error', async () => {
        fail(await handleWriteProgram({}), 'no args');
    });

    // ── Lock failure on non-existent program ──────────────────────────────

    it('4e. Non-existent program returns clean lock error (not exception)', async () => {
        const text = fail(await handleWriteProgram({
            program_name: 'ZPROGRAM_DOES_NOT_EXIST_XYZ999',
            source_code: 'REPORT ZTEST.',
        }), 'non-existent program');
        expect(text).toMatch(/lock|not found|does not exist/i);
    });

    // ── Write + activation tests ──────────────────────────────────────────
    // Write tests run only against a fixture program this suite owns in $TMP. They must never
    // pick up someone else's program (an earlier version took the first ZTEST* hit and rewrote it).
    const FIXTURE = 'ZMCP_WRITE_E2E';
    const FIXTURE_SOURCE = `REPORT ${FIXTURE.toLowerCase()}.\nWRITE / 'hello'.\n`;

    // Jest runs test files in parallel workers; the stateful-operation gate (writeLock.ts) refuses
    // rather than queues while another file's write holds it. Retry that refusal (it never reached SAP).
    const wp = async (args: any) => {
        for (let i = 0; i < 60; i++) {
            const r = await handleWriteProgram(args);
            if (!(r.isError && /^Blocked: a stateful SAP MCP operation/.test(r.content?.[0]?.text || ''))) return r;
            await new Promise(res => setTimeout(res, 2000));
        }
        return handleWriteProgram(args);
    };

    it('4f. Create/refresh the $TMP fixture program for live write tests', async () => {
        const created = await wp({
            program_name: FIXTURE,
            source_code: FIXTURE_SOURCE,
            description: 'MCP exception test fixture',
            package_name: '$TMP',
            activate: true,
        });
        expect(created.isError).toBe(false);
        targetProgram = FIXTURE;
        originalSource = FIXTURE_SOURCE;
        console.log(`  target: ${targetProgram}`);
    });

    it('4g. Write unchanged source with activate=false succeeds', async () => {
        if (!targetProgram || !originalSource) return;
        const text = ok(await wp({
            program_name: targetProgram,
            source_code: originalSource,
            activate: false,
        }), 'write no-activate');
        expect(text).toContain(targetProgram.toUpperCase());
        expect(text).not.toMatch(/FAILED/i);
    });

    it('4h. Write with syntax error and activate=true returns structured activation errors', async () => {
        if (!targetProgram) return;
        // "TYPED" is not valid ABAP — should be "DATA"
        const result = await wp({
            program_name: targetProgram,
            source_code: `REPORT ${targetProgram.toLowerCase()}.\nTYPED lv_x TYPE string.\nWRITE lv_x.`,
            activate: true,
        });
        expect(result.isError).toBe(true);
        const text = result.content[0].text as string;
        expect(text).toMatch(/Activation FAILED/i);
        // Error messages should include line numbers or object description
        expect(text).toMatch(/\[E\]/);
        console.log(`  activation errors:\n${text.substring(0, 300)}`);
    });

    it('4i. Restore original source after write tests', async () => {
        if (!targetProgram || !originalSource) return;
        ok(await wp({
            program_name: targetProgram,
            source_code: originalSource,
            activate: true,
        }), 'restore');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5 — GetObjectVersion: missing params + unsupported type
// ═══════════════════════════════════════════════════════════════════════════

describe('GetObjectVersion missing params', () => {

    it('5a. Missing object_name returns validation error', async () => {
        fail(await handleGetObjectVersion({ object_type: 'PROG' }), 'missing object_name');
    });

    it('5b. Missing object_type returns validation error listing supported types', async () => {
        const text = fail(await handleGetObjectVersion({ object_name: 'RSABAPPROGRAM' }), 'missing object_type');
        expect(text).toMatch(/PROG|CLAS/i);
    });

    it('5c. No args returns validation error', async () => {
        fail(await handleGetObjectVersion({}), 'no args');
    });

    it('5d. Unsupported object_type returns clean error with supported list', async () => {
        const text = fail(await handleGetObjectVersion({
            object_name: 'SOMETHING',
            object_type: 'XXXX',
        }), 'unsupported type');
        expect(text).toMatch(/Unsupported/i);
    });
});
