import { after } from 'node:test';
import { mcp_abap_adt_server } from './index';
import { handleGetProgram } from './handlers/handleGetProgram';
import { handleGetClass } from './handlers/handleGetClass';
import { handleGetFunction } from './handlers/handleGetFunction';
import { handleGetTable } from './handlers/handleGetTable';
import { handleGetStructure } from './handlers/handleGetStructure';
import { handleGetPackage } from './handlers/handleGetPackage';
import { handleGetInclude } from './handlers/handleGetInclude';
import { handleGetTypeInfo } from './handlers/handleGetTypeInfo';
import { handleGetInterface } from './handlers/handleGetInterface';
import { handleGetTransaction } from './handlers/handleGetTransaction';
import { handleSearchObject } from './handlers/handleSearchObject';
import { handleGetDynpro } from './handlers/handleGetDynpro';
import { handleManageDynpro } from './handlers/handleManageDynpro';
import { handleWriteProgram } from './handlers/handleWriteProgram';
import { handleManageMessageClass } from './handlers/handleManageMessageClass';
import { handleDataPreview } from './handlers/handleDataPreview';
import { handleGetCode } from './handlers/handleGetCode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanup } from './lib/utils';

describe('mcp_abap_adt_server - Integration Tests', () => {
  let server: mcp_abap_adt_server;

  beforeAll(() => {
    // Initialize the server instance once before all tests
    server = new mcp_abap_adt_server();
  });

  afterAll(async () => {
    // Clean up server instance and utils
    cleanup();
    // Add a small delay to ensure all async operations complete
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('handleGetProgram', () => {
    it('should successfully retrieve program details', async () => {
      const result = await handleGetProgram({ program_name: 'RSABAPPROGRAM' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetClass', () => {
    it('should successfully retrieve class details', async () => {
      const result = await handleGetClass({ class_name: 'CL_WB_PGEDITOR_INITIAL_SCREEN' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetFunction', () => {
    it('should retrieve function group source when function_name is omitted', async () => {
      const result = await handleGetFunction({ function_group: 'WBABAP' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });

    it('should retrieve function module source when function_name is provided', async () => {
      const result = await handleGetFunction({ function_name: 'WB_PGEDITOR_INITIAL_SCREEN', function_group: 'WBABAP' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetTable', () => {
    it('should successfully retrieve table details', async () => {
      const result = await handleGetTable({ table_name: 'DD02L' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetStructure', () => {
    it('should successfully retrieve structure details', async () => {
      const result = await handleGetStructure({ structure_name: 'SYST' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetPackage', () => {
    it('should successfully retrieve package details', async () => {
      const result = await handleGetPackage({ package_name: 'SABP_TYPES' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetInclude', () => {
    it('should successfully retrieve include details', async () => {
      const result = await handleGetInclude({ include_name: 'LWBABAPF00' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetTypeInfo', () => {
    it('should successfully retrieve type info', async () => {
      const result = await handleGetTypeInfo({ type_name: 'SYST_SUBRC' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetInterface', () => {
    it('should successfully retrieve interface details', async () => {
      const result = await handleGetInterface({ interface_name: 'IF_T100_MESSAGE' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleSearchObject', () => {
    it('should successfully search for an object', async () => {
      const result = await handleSearchObject({ query: 'SYST' });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetTransaction', () => {
    it('should successfully retrieve transaction details', async () => {
      const result = await handleGetTransaction({ transaction_name: 'SE93' });
      console.log(result)
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });
  });
  // Needs the ZMCP SICF endpoint default_host/zmcp/dynpro (ZCL_HTTP_MCP_DYNPRO).
  // SAPMSYST (SAP's logon module pool, 13 screens) is the read-only fixture: 0020 normal with
  // containers, 0043 subscreen, 0070 modal with CHAIN/ENDCHAIN flow logic, 0100 normal.
  describe('handleGetDynpro', () => {
    it('should list the screens of a program', async () => {
      const result = await handleGetDynpro({ object_name: 'SAPMSYST' });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('0043  I (subscreen)');
      expect(result.content[0].text).toContain('0070  M (modal dialog box)');
    });

    it('should render one screen with elements and flow logic', async () => {
      const result = await handleGetDynpro({ object_name: 'SAPMSYST', dynnr: '70' });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Screen SAPMSYST 0070');
      expect(result.content[0].text).toContain('XU180-FAMNAME');
      expect(result.content[0].text).toContain('CHAIN.');
    });

    it('should return round-trippable JSON with raw=true', async () => {
      const result = await handleGetDynpro({ object_name: 'SAPMSYST', dynnr: '0100', raw: true });
      expect(result.isError).toBe(false);
      const json = JSON.parse(result.content[0].text);
      expect(json.header.screen).toBe('0100');
      expect(Array.isArray(json.flow_logic)).toBe(true);
    });

    it('should report a missing screen as an error', async () => {
      const result = await handleGetDynpro({ object_name: 'SAPMSYST', dynnr: '9998' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });
  // Writes only to the $TMP program ZMCP_DYNP_W_E2E (MODULEs STATUS_0100 /
  // USER_COMMAND_0100, globals OK_CODE and FCODE - the OK-code element of SAPMSYST 0070 is FCODE) via default_host/zmcp/dynpro; the
  // test deletes the screen again. Element shapes come from SAPMSYST 0070.
  describe('handleManageDynpro', () => {
    const program = 'ZMCP_DYNP_W_E2E';
    const dynnr = '0190';
    const flow = 'PROCESS BEFORE OUTPUT.\n  MODULE status_0100.\nPROCESS AFTER INPUT.\n  MODULE user_command_0100.';

    // The target program is a fixture the tests own: create it once in $TMP (WriteProgram overwrites,
    // so this is idempotent). Retries because the stateful-operation gate refuses instead of queueing
    // while another test file holds it.
    beforeAll(async () => {
      for (let i = 0; i < 60; i++) {
        const r = await handleWriteProgram({
          program_name: program, object_type: 'PROG', package_name: '$TMP',
          description: 'MCP dynpro write test fixture',
          source_code: 'PROGRAM zmcp_dynp_w_e2e.\nDATA ok_code TYPE sy-ucomm.\nDATA fcode TYPE sy-ucomm.\nMODULE status_0100 OUTPUT.\nENDMODULE.\nMODULE user_command_0100 INPUT.\nENDMODULE.\n',
          activate: true,
        });
        if (!r.isError) return;
        if (!/^Blocked: a stateful SAP MCP operation/.test(r.content?.[0]?.text || '')) throw new Error(r.content?.[0]?.text);
        await new Promise(res => setTimeout(res, 1000));
      }
      throw new Error('could not create fixture program ' + program);
    }, 90000);

    it('should create, round-trip, flag a missing MODULE, and delete a screen', async () => {
      await handleManageDynpro({ action: 'delete', program_name: program, dynnr });  // leftover from an aborted run

      const src = await handleGetDynpro({ object_name: 'SAPMSYST', dynnr: '0070', raw: true });
      const definition = JSON.parse(src.content[0].text);
      definition.containers = definition.containers.filter((c: any) => c.type === 'SCREEN');

      const created = await handleManageDynpro({ action: 'create', program_name: program, dynnr, definition, flow_logic: flow });
      expect(created.isError).toBe(false);
      expect(created.content[0].text).toContain('created and generated (active)');

      const a = await handleGetDynpro({ object_name: program, dynnr, raw: true });
      const updated = await handleManageDynpro({ action: 'update', program_name: program, dynnr, definition: a.content[0].text });
      expect(updated.isError).toBe(false);
      const b = await handleGetDynpro({ object_name: program, dynnr, raw: true });
      expect(b.content[0].text).toBe(a.content[0].text);

      const broken = await handleManageDynpro({
        action: 'update', program_name: program, dynnr,
        flow_logic: 'PROCESS BEFORE OUTPUT.\n  MODULE no_such_module_it.\nPROCESS AFTER INPUT.',
      });
      expect(broken.isError).toBe(true);
      expect(broken.content[0].text).toContain('#102');

      const deleted = await handleManageDynpro({ action: 'delete', program_name: program, dynnr });
      expect(deleted.isError).toBe(false);
    });

    it('should change SE51 attributes via screen_attributes and show them', async () => {
      const d = '0191';
      await handleManageDynpro({ action: 'delete', program_name: program, dynnr: d });
      const src = await handleGetDynpro({ object_name: 'SAPMSYST', dynnr: '0070', raw: true });
      const definition = JSON.parse(src.content[0].text);
      definition.containers = definition.containers.filter((c: any) => c.type === 'SCREEN');
      const created = await handleManageDynpro({
        action: 'create', program_name: program, dynnr: d, definition, flow_logic: flow,
        screen_attributes: { type: 'modal', hold_data: true, without_application_toolbar: true, screen_group: 'zmcp' },
      });
      expect(created.isError).toBe(false);
      let view = (await handleGetDynpro({ object_name: program, dynnr: d })).content[0].text;
      expect(view).toContain('Type: M (modal dialog box)');
      expect(view).toContain('Settings: Hold data, Without application toolbar');

      const updated = await handleManageDynpro({
        action: 'update', program_name: program, dynnr: d,
        screen_attributes: { type: 'normal', hold_data: false, without_application_toolbar: false },
      });
      expect(updated.isError).toBe(false);
      view = (await handleGetDynpro({ object_name: program, dynnr: d })).content[0].text;
      expect(view).toContain('Type: N (normal)');
      expect(view).toContain('Settings: none');

      const template = await handleManageDynpro({ action: 'update', program_name: program, dynnr: d, screen_attributes: { template: true } });
      expect(template.isError).toBe(true);

      await handleManageDynpro({ action: 'delete', program_name: program, dynnr: d });
    });

    // Regression tests for dynpro validation fixes
    it('should refuse invalid screen types and input fields with requ_entry N before writing', async () => {
      const src = await handleGetDynpro({ object_name: 'SAPMSYST', dynnr: '0070', raw: true });
      const definition = JSON.parse(src.content[0].text);
      definition.containers = definition.containers.filter((c: any) => c.type === 'SCREEN');

      const badType = await handleManageDynpro({ action: 'create', program_name: program, dynnr: '0192', flow_logic: flow,
        definition: { ...definition, header: { ...definition.header, type: '1' } } });
      expect(badType.isError).toBe(true);
      expect(badType.content[0].text).toContain('header.type "1" is not valid');

      const field = { ...definition.fields_to_containers[0], type: 'TEMPLATE', name: 'GV_X', line: 2, column: 2, input_fld: 'X', requ_entry: 'N' };
      const badInput = await handleManageDynpro({ action: 'create', program_name: program, dynnr: '0192', flow_logic: flow,
        definition: { ...definition, fields_to_containers: [...definition.fields_to_containers, field] } });
      expect(badInput.isError).toBe(true);
      expect(badInput.content[0].text).toContain('GV_X');

      const listed = await handleGetDynpro({ object_name: program });
      expect(listed.content[0].text).not.toContain('0192');
    });

    it('should write raw JSON only to output_file', async () => {
      const file = path.join(os.tmpdir(), `dynpro-raw-${process.pid}.json`);
      const result = await handleGetCode({ resource: 'DYNPRO', object_name: 'SAPMSYST', dynnr: '0070', raw: true, output_file: file });
      expect(result.isError).toBe(false);
      expect(result.content[0].text.length).toBeLessThan(400);
      expect(result.content[0].text).toContain(file);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).header.screen).toBe('0070');
      fs.unlinkSync(file);
    });

    it('should refuse a screen of an SAP program', async () => {
      const result = await handleManageDynpro({ action: 'update', program_name: 'SAPLSPO1', dynnr: '0100', flow_logic: flow });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('customer programs');
    });
  });

  // $TMP only. Uses one fixed name: a delete releases its lock, so re-runs can re-create it.
  describe('handleManageMessageClass', () => {
    const mc = 'ZMCP_MSAG_E2E';
    // Jest runs test files in parallel workers; the stateful-operation gate (writeLock.ts) refuses
    // rather than queues when another file's WriteProgram/ManageTransport test holds it. Retry that
    // refusal (it never reached SAP) instead of failing on scheduling.
    const mmc = async (args: any) => {
      for (let i = 0; i < 60; i++) {
        const r = await handleManageMessageClass(args);
        if (!(r.isError && /^Blocked: a stateful SAP MCP operation/.test(r.content?.[0]?.text || ''))) return r;
        await new Promise(res => setTimeout(res, 2000));
      }
      return handleManageMessageClass(args);
    };

    it('should create, upsert, rename, delete messages and delete a message class', async () => {
      await mmc({ action: 'delete', message_class: mc });  // leftover from an aborted run

      const created = await mmc({
        action: 'create', message_class: mc, description: 'MCP e2e', package_name: '$TMP',
        messages: [{ number: 1, text: 'Order &1 not found' }, { number: '002', text: 'A & <b> "c"', self_explanatory: false }],
      });
      expect(created.isError).toBe(false);
      expect(created.content[0].text).toContain('Read-back OK (EN): 2 message(s)');

      const updated = await mmc({
        action: 'update', message_class: mc, description: 'MCP e2e renamed',
        messages: [{ number: '2', text: 'Changed &1' }, { number: '010', text: 'Ten' }],
      });
      expect(updated.isError).toBe(false);
      expect(updated.content[0].text).toContain('added 010; changed 002; description updated');
      expect(updated.content[0].text).toContain('Read-back OK (EN): 3 message(s)');

      const pruned = await mmc({ action: 'update', message_class: mc, delete_messages: ['1'] });
      expect(pruned.isError).toBe(false);
      expect(pruned.content[0].text).toContain('deleted 001');
      expect(pruned.content[0].text).toContain('Read-back OK (EN): 2 message(s)');

      const replaced = await mmc({ action: 'update', message_class: mc, replace_all: true, messages: [{ number: '005', text: 'Only five' }] });
      expect(replaced.isError).toBe(false);
      expect(replaced.content[0].text).toContain('added 005; deleted 002, 010');
      expect(replaced.content[0].text).toContain('Read-back OK (EN): 1 message(s)');

      const missing = await mmc({ action: 'update', message_class: mc, delete_messages: ['999'] });
      expect(missing.isError).toBe(true);

      // Translation goes to its own language only; nothing may ever land in the blank language
      // (regression: 3.4.0 omitted adtcore:language and wrote SPRSL = ' ' rows).
      const translated = await mmc({ action: 'update', message_class: mc, language: 'DE', messages: [{ number: '005', text: 'Nur fünf' }] });
      expect(translated.isError).toBe(false);
      expect(translated.content[0].text).toContain('Language: DE (translation; master EN)');
      const rows = (await handleDataPreview({ query: `SELECT sprsl, msgnr, text FROM t100 WHERE arbgb = '${mc}'`, max_rows: 20 })).content[0].text as string;
      expect(rows).toMatch(/\bE\s+005\s+Only five/);
      expect(rows).toMatch(/\bD\s+005\s+Nur fünf/);
      expect(rows).toContain('2 row(s) displayed');

      const deleted = await mmc({ action: 'delete', message_class: mc });
      expect(deleted.isError).toBe(false);
      const recreated = await mmc({ action: 'create', message_class: mc, description: 'again', package_name: '$TMP' });
      expect(recreated.isError).toBe(false);
      expect((await mmc({ action: 'delete', message_class: mc })).isError).toBe(false);
    });

    it('should refuse a non-$TMP package without a transport', async () => {
      const result = await mmc({ action: 'create', message_class: 'ZMCP_MSAG_E2E_T', description: 'x', package_name: 'ZMCP' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('transport_number or transport_description is required');
    });
  });
});
