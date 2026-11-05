import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { repeatDate, projectRepeats } = require('../../utils/repeats');
const cases = JSON.parse(readFileSync(new URL('./fixtures/repeats.json', import.meta.url), 'utf8'));

// The same fixtures run in the app (src/__tests__/repeatsParity.test.js): both must give the same days
for (const { name, tasks, until, expected } of cases) {
    test(`projectRepeats: ${name}`, () => {
        const got = projectRepeats(tasks, until).map(({ id, due }) => ({ id, due }));
        assert.deepEqual(got, expected);
    });
}

test('repeatDate steps from the start, so the 31st comes back', () => {
    assert.equal(repeatDate('2026-10-31', 'monthly', 1), '2026-11-30');
    assert.equal(repeatDate('2026-10-31', 'monthly', 2), '2026-12-31');
    assert.equal(repeatDate('2024-02-29', 'yearly', 4), '2028-02-29');
    assert.equal(repeatDate('2026-12-30', 'daily', 3), '2027-01-02');
    assert.equal(repeatDate('2026-11-03', 'weekly', 2), '2026-11-17');
    assert.equal(repeatDate('2026-11-03', 'never', 1), null);
});
