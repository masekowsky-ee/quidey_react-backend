import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pageCount, estimateParts, reviewMinutes, askAi, makeAiClient } = require('../../utils/studyEstimate');

const noHist = { sameSubjectKind: [], sameKind: [], minutesPerPage: [] };
const est = (over = {}) => estimateParts({
    parts: [{ name: 'Kapitel 1', kind: 'part' }], subjectId: 1, kind: 'exam', history: noHist, ai: null, ...over,
});

test('pageCount understands every range form', () => {
    assert.equal(pageCount('Skript S. 120–160'), 40);
    assert.equal(pageCount('Skript S.120-160'), 40);
    assert.equal(pageCount('Buch p. 12-30'), 18);
    assert.equal(pageCount('Buch pp. 12–30'), 18);
    assert.equal(pageCount('Seiten 5 bis 40'), 35);
    assert.equal(pageCount('pages 5 to 40'), 35);
});

test('pageCount is null without a usable range', () => {
    assert.equal(pageCount('Kapitel 3'), null);
    assert.equal(pageCount(''), null);
    assert.equal(pageCount(null), null);
    assert.equal(pageCount('S. 40-40'), null);
    assert.equal(pageCount('S. 40-10'), null);
});

test('history beats pages beats AI beats default', () => {
    const history = { sameSubjectKind: [60, 90, 300], sameKind: [], minutesPerPage: [2, 2, 2] };
    const parts = [{ name: 'S. 10-20', kind: 'part' }];
    assert.deepEqual(est({ parts, history, ai: [200] }), [{ minutes: 90, source: 'history' }]);
    assert.deepEqual(est({ parts, history: { ...history, sameSubjectKind: [] }, ai: [200] }), [{ minutes: 20, source: 'pages' }]);
    assert.deepEqual(est({ parts, ai: [200] }), [{ minutes: 200, source: 'ai' }]);
    assert.deepEqual(est({ parts, ai: [null] }), [{ minutes: 120, source: 'default' }]);
    assert.deepEqual(est({ parts }), [{ minutes: 120, source: 'default' }]);
});

test('history needs 3 samples, same-subject-kind beats same-kind', () => {
    assert.equal(est({ history: { ...noHist, sameSubjectKind: [60, 90] } })[0].source, 'default');
    const both = { ...noHist, sameSubjectKind: [30, 30, 30], sameKind: [100, 100, 100] };
    assert.deepEqual(est({ history: both })[0], { minutes: 30, source: 'history' });
    const fall = { ...noHist, sameSubjectKind: [30, 30], sameKind: [100, 100, 100] };
    assert.deepEqual(est({ history: fall })[0], { minutes: 100, source: 'history' });
});

test('median of an even count is the rounded mean of the middle two', () => {
    const h = { ...noHist, sameKind: [61, 100, 20, 40] };
    assert.equal(est({ history: h })[0].minutes, 51); // (40+61)/2 = 50.5 -> 51
});

test('pages need 3 finished page-range parts', () => {
    const parts = [{ name: 'S. 10-20', kind: 'part' }];
    assert.equal(est({ parts, history: { ...noHist, minutesPerPage: [2, 2] } })[0].source, 'default');
});

test('estimates clamp to 15-1200', () => {
    assert.equal(est({ history: { ...noHist, sameKind: [5, 5, 5] } })[0].minutes, 15);
    assert.equal(est({ history: { ...noHist, sameKind: [5000, 5000, 5000] } })[0].minutes, 1200);
    assert.equal(est({ ai: [5] })[0].minutes, 15);
    assert.equal(est({ ai: [99999] })[0].minutes, 1200);
});

test('defaults by kind', () => {
    assert.equal(est({ kind: 'exam' })[0].minutes, 120);
    assert.equal(est({ kind: 'assignment' })[0].minutes, 180);
    assert.equal(est({ kind: 'presentation' })[0].minutes, 90);
    assert.equal(est({ kind: 'other' })[0].minutes, 120);
});

test('reviewMinutes is 15 % clamped 60-240', () => {
    assert.equal(reviewMinutes([120, 120, 120]), 60);
    assert.equal(reviewMinutes(Array(20).fill(120)), 240);
    assert.equal(reviewMinutes([600, 600]), 180);
    assert.equal(reviewMinutes([]), 60);
});

const okClient = (estimates) => ({
    messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'give_estimates', input: { estimates } }] }) },
});
const args = (client, over = {}) => ({
    client, model: 'm', subjectName: 'Mathe', kind: 'exam', daysUntilDue: 5, parts: ['a', 'b'], timeoutMs: 50, ...over,
});

test('askAi maps valid entries by index', async () => {
    const r = await askAi(args(okClient([{ index: 1, minutes: 90 }, { index: 0, minutes: 45.4 }])));
    assert.deepEqual(r, [45, 90]);
});

test('askAi: thrown error gives all null', async () => {
    const c = { messages: { create: async () => { throw new Error('boom'); } } };
    assert.deepEqual(await askAi(args(c)), [null, null]);
});

test('askAi: hung client gives all null after the timeout', async () => {
    const c = { messages: { create: () => new Promise(() => {}) } };
    const t = Date.now();
    assert.deepEqual(await askAi(args(c)), [null, null]);
    assert.ok(Date.now() - t < 1000);
});

test('askAi: garbage and out-of-range entries become null', async () => {
    const r = await askAi(args(okClient([{ index: 7, minutes: 90 }, { index: 0, minutes: 'x' }])));
    assert.deepEqual(r, [null, null]);
    assert.deepEqual(await askAi(args(okClient('nope'))), [null, null]);
    assert.deepEqual(await askAi(args({ messages: { create: async () => ({ content: [] }) } })), [null, null]);
});

test('askAi sends only names, subject, kind and days', async () => {
    let body;
    const c = { messages: { create: async (b) => { body = b; return { content: [] }; } } };
    await askAi(args(c, { parts: ['Kapitel 1'] }));
    assert.equal(body.model, 'm');
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'give_estimates' });
    const text = JSON.stringify(body.messages);
    for (const s of ['Kapitel 1', 'Mathe', 'exam', '5']) assert.ok(text.includes(s));
});

test('makeAiClient is null without a key', () => {
    const old = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try { assert.equal(makeAiClient(), null); } finally { if (old !== undefined) process.env.ANTHROPIC_API_KEY = old; }
});
