import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    sessionCredit, partProgress, isMissed, isPending, isReplaceable, goalStatus, shouldNotify, pushText,
} = require('../../utils/studyStatus');

const TODAY = '2026-11-09';
const ctx = (over = {}) => ({ today: TODAY, nowMinutes: 12 * 60, planMode: 'slots', ...over });
const sess = (over = {}) => ({
    taskId: 1, partId: 'p1', date: TODAY, time: '10:00', minutes: 45, done: false, focusMs: 0, pinned: false, ...over,
});

test('sessionCredit takes the larger of focus time and ticked minutes', () => {
    assert.equal(sessionCredit({ focusMs: 30 * 60000, done: true, minutes: 45 }), 45);
    assert.equal(sessionCredit({ focusMs: 50 * 60000, done: false, minutes: 45 }), 50);
    assert.equal(sessionCredit({ focusMs: 0, done: false, minutes: 45 }), 0);
});

test('partProgress sums credit and is 0 remaining when done', () => {
    const sessions = [sess({ done: true }), sess({ focusMs: 10 * 60000 })];
    assert.deepEqual(partProgress({ estimate: 120, doneAt: null }, sessions), { credit: 55, remaining: 65 });
    assert.deepEqual(partProgress({ estimate: 120, doneAt: '2026-11-08' }, sessions), { credit: 55, remaining: 0 });
    assert.deepEqual(partProgress({ estimate: 30, doneAt: null }, sessions), { credit: 55, remaining: 0 });
});

test('isMissed slots: planned end + 60 min', () => {
    const s = sess({ time: '10:00', minutes: 45 }); // ends 10:45
    assert.equal(isMissed(s, ctx({ nowMinutes: 10 * 60 + 45 + 59 })), false);
    assert.equal(isMissed(s, ctx({ nowMinutes: 10 * 60 + 45 + 60 })), true);
    assert.equal(isMissed(sess({ date: '2026-11-08' }), ctx({ nowMinutes: 0 })), true);
    assert.equal(isMissed(sess({ date: '2026-11-10' }), ctx({ nowMinutes: 23 * 60 })), false);
});

test('isMissed days: only once the day is over', () => {
    const c = ctx({ planMode: 'days', nowMinutes: 23 * 60 });
    assert.equal(isMissed(sess({ time: null }), c), false);
    assert.equal(isMissed(sess({ time: null, date: '2026-11-08' }), c), true);
    // an untimed session in a slots goal follows the days rule
    assert.equal(isMissed(sess({ time: null }), ctx({ nowMinutes: 23 * 60 })), false);
});

test('done or focused sessions are never missed', () => {
    const c = ctx({ nowMinutes: 23 * 60 });
    assert.equal(isMissed(sess({ done: true, date: '2026-11-01' }), c), false);
    assert.equal(isMissed(sess({ focusMs: 1000, date: '2026-11-01' }), c), false);
});

test('isPending / isReplaceable', () => {
    const c = { today: TODAY, nowMinutes: 9 * 60 };
    assert.equal(isPending(sess({ time: '09:01' }), c), true);
    assert.equal(isPending(sess({ time: '09:00' }), c), false);
    assert.equal(isPending(sess({ time: null }), c), true);
    assert.equal(isPending(sess({ time: null, date: '2026-11-08' }), c), false);
    assert.equal(isPending(sess({ date: '2026-11-10' }), c), true);
    assert.equal(isPending(sess({ done: true, date: '2026-11-10' }), c), false);
    assert.equal(isPending(sess({ focusMs: 5, date: '2026-11-10' }), c), false);
    assert.equal(isPending(sess({ pinned: true, date: '2026-11-10' }), c), true);
    assert.equal(isReplaceable(sess({ pinned: true, date: '2026-11-10' }), c), false);
    assert.equal(isReplaceable(sess({ date: '2026-11-10' }), c), true);
});

const baseGoal = { id: 'g1', planMode: 'slots' };
const status = (sessions, parts, busy = [], over = {}) =>
    goalStatus({ goal: baseGoal, parts, sessions, busy }, { today: TODAY, nowMinutes: 12 * 60, sessionMinutes: 45, ...over });

test('goalStatus: behind threshold is sessionMinutes', () => {
    const part = { id: 'p1', estimate: 300, doneAt: null };
    // 45 missed, 1 min of credit from a focused session => deficit 44
    const s44 = [sess({ taskId: 1, date: '2026-11-08' }), sess({ taskId: 2, date: '2026-11-08', focusMs: 60000 })];
    assert.equal(status(s44, [part]).behindMinutes, 0);
    const s45 = [sess({ taskId: 1, date: '2026-11-08' })];
    assert.equal(status(s45, [part]).behindMinutes, 45);
});

test('goalStatus: credit offsets missed minutes per part, not across parts', () => {
    const parts = [{ id: 'p1', estimate: 300, doneAt: null }, { id: 'p2', estimate: 300, doneAt: null }];
    const sessions = [
        sess({ taskId: 1, partId: 'p1', date: '2026-11-08' }),
        sess({ taskId: 2, partId: 'p1', date: '2026-11-08' }),
        sess({ taskId: 3, partId: 'p1', date: TODAY, time: '11:00', done: true }),
        sess({ taskId: 4, partId: 'p2', date: '2026-11-08' }),
    ];
    // p1: missed 90 - credit 45 = 45; p2: 45 => 90
    assert.equal(status(sessions, parts).behindMinutes, 90);
});

test('goalStatus: a finished part is never behind', () => {
    const part = { id: 'p1', estimate: 300, doneAt: '2026-11-08' };
    assert.equal(status([sess({ date: '2026-11-08' })], [part]).behindMinutes, 0);
});

test('goalStatus: conflicts with replaceable slots sessions', () => {
    const part = { id: 'p1', estimate: 300, doneAt: null };
    const sessions = [
        sess({ taskId: 7, date: '2026-11-10', time: '10:00' }),   // 10:00-10:45
        sess({ taskId: 8, date: '2026-11-10', time: '12:00' }),
        sess({ taskId: 9, date: '2026-11-10', time: '14:00', pinned: true }),
        sess({ taskId: 10, date: '2026-11-10', time: null }),
    ];
    const busy = [
        { date: '2026-11-10', start: '10:30', minutes: 60 },       // overlaps 7
        { date: '2026-11-10', start: '10:45', minutes: 30 },       // only touches 7
        { date: '2026-11-10', start: '14:00', minutes: 30 },       // hits pinned 9
        { date: '2026-11-10', start: '09:00', minutes: 60 },       // ends 10:00, touches 7
        { date: '2026-11-11', start: '12:00', minutes: 60 },       // other day
    ];
    assert.deepEqual(status(sessions, [part], busy).conflictTaskIds, [7]);
});

test('goalStatus: days goals have no conflicts', () => {
    const part = { id: 'p1', estimate: 300, doneAt: null };
    const r = goalStatus(
        { goal: { id: 'g', planMode: 'days' }, parts: [part], sessions: [sess({ taskId: 7, date: '2026-11-10', time: null })], busy: [{ date: '2026-11-10', start: '10:00', minutes: 600 }] },
        { today: TODAY, nowMinutes: 0, sessionMinutes: 45 },
    );
    assert.deepEqual(r.conflictTaskIds, []);
});

test('goalStatus: ahead parts', () => {
    const parts = [
        { id: 'p1', estimate: 45, doneAt: null },
        { id: 'p2', estimate: 90, doneAt: null },
        { id: 'p3', estimate: 90, doneAt: '2026-11-08' },
    ];
    const sessions = [sess({ taskId: 1, partId: 'p1', done: true }), sess({ taskId: 2, partId: 'p2', focusMs: 30 * 60000 })];
    assert.deepEqual(status(sessions, parts).aheadPartIds, ['p1', 'p3']);
});

test('shouldNotify', () => {
    const base = { deficit: 90, notifiedMinutes: 0, sentToday: false, nowMinutes: 10 * 60, sessionMinutes: 45 };
    assert.equal(shouldNotify(base), true);
    assert.equal(shouldNotify({ ...base, nowMinutes: 7 * 60 + 59 }), false);
    assert.equal(shouldNotify({ ...base, nowMinutes: 8 * 60 }), true);
    assert.equal(shouldNotify({ ...base, nowMinutes: 18 * 60 + 59 }), true);
    assert.equal(shouldNotify({ ...base, nowMinutes: 19 * 60 }), false);
    assert.equal(shouldNotify({ ...base, sentToday: true }), false);
    assert.equal(shouldNotify({ ...base, deficit: 44 }), false);
    assert.equal(shouldNotify({ ...base, notifiedMinutes: 50 }), false);
    assert.equal(shouldNotify({ ...base, notifiedMinutes: 45 }), true);
});

test('pushText de/en', () => {
    const one = [{ name: 'Statistik II', behindMinutes: 90 }];
    const two = [{ name: 'A', behindMinutes: 45 }, { name: 'B', behindMinutes: 60 }];
    assert.equal(pushText(one, 'de').title, 'Statistik II liegt 1,5 h zurück – Plan anpassen?');
    assert.equal(pushText(one, 'en').title, 'Statistik II is 1.5 h behind – adjust the plan?');
    assert.equal(pushText(two, 'de').title, '2 Ziele liegen zurück – Plan anpassen?');
    assert.equal(pushText(two, 'en').title, '2 goals are behind – adjust the plan?');
    assert.equal(pushText([{ name: 'A', behindMinutes: 120 }], 'en').title, 'A is 2 h behind – adjust the plan?');
    assert.equal(pushText([{ name: 'A', behindMinutes: 120 }], 'de').title, 'A liegt 2 h zurück – Plan anpassen?');
    assert.equal(typeof pushText(one, 'de').body, 'string');
});
