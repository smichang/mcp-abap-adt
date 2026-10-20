/**
 * Offline test (no SAP) of the function-module attribute line GetCode OBJECT appends for a FUNC.
 * Bodies are trimmed copies of live S4D answers (2026-10-19). `../lib/utils` is mocked because the
 * real one imports the server entry, which needs SAP credentials.
 */
jest.mock('../lib/utils', () => ({}));

import { fmAttributesLine } from './handleGetFunction';

const fm = (type: string, extra = '') =>
    `<?xml version="1.0" encoding="utf-8"?><fmodule:abapFunctionModule fmodule:releaseState="notReleased" fmodule:processingType="${type}"${extra} ` +
    `abapsource:sourceUri="source/main" adtcore:name="Z_FI02_ACCTDOC_SIGNFILE" adtcore:type="FUGR/FF" adtcore:changedAt="2026-10-15T06:58:51Z" ` +
    `adtcore:version="active" adtcore:changedBy="OTHERUSER" xmlns:fmodule="x"><adtcore:containerRef adtcore:uri="/sap/bc/adt/functions/groups/zfif02" ` +
    `adtcore:type="FUGR/F" adtcore:name="ZFIF02" adtcore:packageName="ZFI01"/></fmodule:abapFunctionModule>`;

describe('fmAttributesLine', () => {
    test('remote-enabled FM shows RFC, scope, group, package and last change', () => {
        expect(fmAttributesLine(fm('rfc', ' fmodule:rfcScope="notClassified"'))).toBe(
            '[Function module Z_FI02_ACCTDOC_SIGNFILE — group ZFIF02, package ZFI01] processing type: RFC (remote-enabled) · ' +
            'RFC scope notClassified · version active · last changed 2026-10-15 06:58:51 UTC by OTHERUSER · release state notReleased');
    });
    test('normal FM says NOT remote-enabled', () => {
        expect(fmAttributesLine(fm('normal'))).toContain('processing type: normal (NOT remote-enabled)');
    });
    test('anything that is not an FM document gives no line', () => {
        expect(fmAttributesLine('<html>error</html>')).toBe('');
    });
});
