import { handleManageObject } from './handleManageObject';
import { manageObjectTool, MANAGE_OBJECT_RESOURCES } from './manageObjectSchema';

describe('ManageObject dispatcher (offline)', () => {
    it('rejects an unknown resource', async () => {
        const r: any = await handleManageObject({ resource: 'NOPE', action: 'create' });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/Invalid resource "NOPE"/);
    });

    it('forwards to the resource handler (validation error comes from the handler)', async () => {
        const r: any = await handleManageObject({ resource: 'TRANSACTION', action: 'create', transaction_name: 'ZX' });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/program_name is required/);
    });

    it('schema lists every resource and the union of actions', () => {
        const p: any = manageObjectTool.inputSchema.properties;
        expect(p.resource.enum).toEqual(MANAGE_OBJECT_RESOURCES);
        expect(p.action.enum).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
        expect(p.transaction_name).toBeDefined();
        expect(p.message_class).toBeDefined();
    });
});
