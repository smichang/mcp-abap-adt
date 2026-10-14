import { describeHttpErrorBody } from './httpError';

// Pure unit tests — no SAP connection needed.

// Shape of the ICM page SAP returned on 2026-10-14 (the real one carries a ~6 KB base64 logo).
const ICM_PAGE = (title: string) =>
    `<html><head><title>Service cannot be reached</title><style>body { background: #fff; }</style></head><body>` +
    `<div class="content"><div class="valigned"><p class="centerText"><span class="errorTextHeader"> ${title} </span></p></div></div>` +
    `<div class="footer"><img width='150' title='' alt='SAP logo'src='data:image/png;base64,${'A'.repeat(6000)}'></div></body></html>`;

describe('describeHttpErrorBody', () => {
    it('reduces an ICM "Session not found" page to a short message that explains the stranded lock/session', () => {
        const out = describeHttpErrorBody(ICM_PAGE('400 Session not found'));
        expect(out.length).toBeLessThan(900);                    // not 6 KB of base64
        expect(out).not.toContain('base64');
        expect(out).toContain('400 Session not found');
        expect(out).toMatch(/SM12 lock and an SM04 HTTP session are STRANDED/);
        expect(out).toMatch(/UnlockObject\(force=true\)/);
        expect(out).toMatch(/Do not retry writes/);
    });
    it('reduces any other ICM page to its header only', () => {
        const out = describeHttpErrorBody(ICM_PAGE('503 Service Unavailable'));
        expect(out).toBe('503 Service Unavailable (HTTP error page from SAP)');
    });
    it('falls back to <title> when there is no errorTextHeader', () => {
        expect(describeHttpErrorBody('<html><head><title>Bad gateway</title></head><body>x</body></html>')).toBe('Bad gateway (HTTP error page from SAP)');
    });
    it('falls back to stripped text when there is neither', () => {
        const out = describeHttpErrorBody('<!DOCTYPE html><html><body><p>Something   odd</p></body></html>');
        expect(out).toContain('Something odd');
        expect(out).not.toContain('<');
    });
    it('passes ADT XML error bodies through untouched', () => {
        const xml = '<?xml version="1.0"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><message>boom</message></exc:exception>';
        expect(describeHttpErrorBody(xml)).toBe(xml);
    });
    it('passes plain text and non-strings through', () => {
        expect(describeHttpErrorBody('plain failure')).toBe('plain failure');
        expect(describeHttpErrorBody(undefined)).toBe('');
        expect(describeHttpErrorBody(404)).toBe('404');
    });
});
