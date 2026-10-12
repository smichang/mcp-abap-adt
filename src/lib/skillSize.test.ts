import { spawnSync } from 'child_process';
import path from 'path';

// The agent skill is loaded on every ABAP task; scripts/check-skill-size.js keeps it small.
// Running it here means a normal `npm test` fails when the skill outgrows its budget.
// No SAP connection needed.
describe('agent skill size budget', () => {
    it('stays within the limits of scripts/check-skill-size.js', () => {
        const script = path.join(__dirname, '..', '..', 'scripts', 'check-skill-size.js');
        const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
        // On failure show which limit was exceeded.
        if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`.trim());
        expect(result.status).toBe(0);
    });
});
