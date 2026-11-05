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

// node-postgres hands a `date` column over as a Date at local midnight, not as text
test('projectRepeats: a Date due (as pg returns it) gives the same days as the text', () => {
    for (const repeat of ['weekly', 'monthly']) {
        const task = { id: 't', done: false, repeat };
        const fromDate = projectRepeats([{ ...task, due: new Date(2026, 0, 31) }], '2026-06-30');
        const fromText = projectRepeats([{ ...task, due: '2026-01-31' }], '2026-06-30');
        assert.ok(fromText.length > 0);
        assert.deepEqual(fromDate.map(({ id, due }) => ({ id, due })), fromText.map(({ id, due }) => ({ id, due })));
    }
});

test('projectRepeats: an unusable until throws', () => {
    assert.throws(() => projectRepeats([], 'soon'), /until/);
});
