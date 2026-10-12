import {
    acquireStatefulOperationLock,
    releaseStatefulOperationLock,
} from './writeLock';

afterEach(() => {
    releaseStatefulOperationLock();
});

describe('stateful operation lock', () => {
    it('rejects a concurrent operation from the same MCP process', () => {
        expect(acquireStatefulOperationLock('first operation')).toEqual({ ok: true });

        const blocked = acquireStatefulOperationLock('second operation');
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) {
            expect(blocked.message).toContain('stateful SAP MCP operation');
            expect(blocked.message).toContain('first operation');
        }
    });
});
