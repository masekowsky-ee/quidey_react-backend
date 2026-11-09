import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { plan, chunk, planningDays, freeGaps } = require('../../utils/studyPlanner');

// 2026-11-09 is a Monday (weekday 1); a goal due Sunday 2026-11-15 has six planning days, 09..14
const TODAY = '2026-11-09';
const everyDay = (start, end) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start, end }));
const goal = (over = {}) => ({
    id: 'g1', kind: 'exam', due: '2026-11-15', planMode: 'days',
    parts: [{ id: 'p1', position: 1, role: 'part', remaining: 270 }],
    ...over,
});
const input = (over = {}) => ({
    today: TODAY, nowMinutes: 8 * 60,
    goals: [goal()],
    windows: everyDay('08:00', '20:00'),
    sessionMinutes: 45, dailyMaxMinutes: 180,
    busy: [], kept: [],
    ...over,
});
const dates = (sessions) => sessions.map((s) => s.date);
const times = (sessions) => sessions.map((s) => s.time);

// ---------- chunk ----------

test('chunk: cuts into session lengths, merges a leftover under 15 minutes', () => {
    assert.deepEqual(chunk(100, 45), [45, 55]);
    assert.deepEqual(chunk(105, 45), [45, 45, 15]);
    assert.deepEqual(chunk(90, 45), [45, 45]);
    assert.deepEqual(chunk(0, 45), []);
    assert.deepEqual(chunk(-5, 45), []);
    assert.deepEqual(chunk(10, 45), [10]);
});

// ---------- planningDays ----------

test('planningDays: from today to the day before due', () => {
    assert.deepEqual(planningDays(goal(), TODAY, 8 * 60, everyDay('08:00', '20:00')),
        ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
});

test('planningDays (days): starts tomorrow from 19:00 on', () => {
    const w = everyDay('08:00', '20:00');
    assert.equal(planningDays(goal(), TODAY, 19 * 60 - 1, w)[0], '2026-11-09');
    assert.equal(planningDays(goal(), TODAY, 19 * 60, w)[0], '2026-11-10');
});

test('planningDays (slots): starts tomorrow once no window today has a session left', () => {
    const g = goal({ planMode: 'slots' });
    const w = everyDay('15:00', '19:00');
    // 18:15 leaves exactly 45 minutes; 18:11 rounds up to 18:15
    assert.equal(planningDays(g, TODAY, 18 * 60 + 11, w, 45)[0], '2026-11-09');
    assert.equal(planningDays(g, TODAY, 18 * 60 + 15, w, 45)[0], '2026-11-09');
    // 18:16 rounds up to 18:20: only 40 minutes left
    assert.equal(planningDays(g, TODAY, 18 * 60 + 16, w, 45)[0], '2026-11-10');
    assert.equal(planningDays(g, TODAY, 18 * 60 + 30, w, 45)[0], '2026-11-10');
    assert.equal(planningDays(g, TODAY, 19 * 60, w, 45)[0], '2026-11-10');
    // two windows today: still open while the later one runs
    const two = [{ weekday: 1, start: '08:00', end: '09:00' }, { weekday: 1, start: '18:00', end: '20:00' }, ...everyDay('15:00', '16:00').slice(1)];
    assert.equal(planningDays(g, TODAY, 12 * 60, two, 45)[0], '2026-11-09');
});

test('slots: at 18:30 with windows to 19:00, today is no planning day and 3 sessions stay evenly spaced', () => {
    const { sessions } = plan(input({
        nowMinutes: 18 * 60 + 30,
        windows: everyDay('15:00', '19:00'),
        goals: [goal({ planMode: 'slots', due: '2026-11-16', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 135 }] })],
    }));
    // planning days 10..15 (six), sessions on days 0, 2, 4
    assert.deepEqual(dates(sessions), ['2026-11-10', '2026-11-12', '2026-11-14']);
});

test('planningDays (slots): only weekdays that have a window', () => {
    const g = goal({ planMode: 'slots' });
    const w = [{ weekday: 1, start: '15:00', end: '17:00' }, { weekday: 3, start: '15:00', end: '17:00' }];
    assert.deepEqual(planningDays(g, TODAY, 8 * 60, w), ['2026-11-09', '2026-11-11']);
});

test('planningDays: due tomorrow gives today while open; due today or earlier gives nothing', () => {
    const w = everyDay('08:00', '20:00');
    assert.deepEqual(planningDays(goal({ due: '2026-11-10' }), TODAY, 8 * 60, w), ['2026-11-09']);
    assert.deepEqual(planningDays(goal({ due: '2026-11-10' }), TODAY, 20 * 60, w), []);
    assert.deepEqual(planningDays(goal({ due: TODAY }), TODAY, 8 * 60, w), []);
    assert.deepEqual(planningDays(goal({ due: '2026-11-01' }), TODAY, 8 * 60, w), []);
});

test('planningDays: crosses month and year ends in UTC', () => {
    const w = everyDay('08:00', '20:00');
    assert.deepEqual(planningDays(goal({ due: '2027-01-02' }), '2026-12-30', 8 * 60, w),
        ['2026-12-30', '2026-12-31', '2027-01-01']);
});

// ---------- freeGaps ----------

test('freeGaps: windows of the weekday minus busy items with a 10-minute buffer', () => {
    const w = [{ weekday: 1, start: '15:00', end: '19:00' }, { weekday: 2, start: '08:00', end: '09:00' }];
    const busy = [{ date: TODAY, start: '16:00', minutes: 60 }, { date: '2026-11-10', start: '15:00', minutes: 600 }];
    assert.deepEqual(freeGaps(TODAY, w, busy, []), [{ start: 900, end: 950 }, { start: 1030, end: 1140 }]);
});

test('freeGaps: kept timed sessions are busy, untimed ones are not', () => {
    const w = [{ weekday: 1, start: '15:00', end: '19:00' }];
    const kept = [
        { goalId: 'g1', partId: 'p1', date: TODAY, time: '15:00', minutes: 45 },
        { goalId: 'g1', partId: 'p1', date: TODAY, time: null, minutes: 45 },
    ];
    assert.deepEqual(freeGaps(TODAY, w, [], kept), [{ start: 955, end: 1140 }]);
});

test('freeGaps: no windows that weekday gives no gaps', () => {
    assert.deepEqual(freeGaps('2026-11-10', [{ weekday: 1, start: '15:00', end: '19:00' }], [], []), []);
});

// ---------- spreading and capacity ----------

test('spreading: 6 sessions over 6 days, one per day', () => {
    const { sessions, shortfall } = plan(input());
    assert.deepEqual(dates(sessions),
        ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    assert.deepEqual(shortfall, { g1: 0 });
});

test('spreading: 3 sessions over 6 days land on days 0, 2, 4', () => {
    const { sessions } = plan(input({ goals: [goal({ parts: [{ id: 'p1', position: 1, role: 'part', remaining: 135 }] })] }));
    assert.deepEqual(dates(sessions), ['2026-11-09', '2026-11-11', '2026-11-13']);
});

test('daily max 90 with 45-minute sessions: never more than 2 sessions a day', () => {
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 90,
        goals: [goal({ parts: [{ id: 'p1', position: 1, role: 'part', remaining: 45 * 14 }] })],
    }));
    const perDay = {};
    for (const s of sessions) perDay[s.date] = (perDay[s.date] || 0) + s.minutes;
    for (const minutes of Object.values(perDay)) assert.ok(minutes <= 90);
    assert.equal(sessions.length, 12);
    assert.deepEqual(shortfall, { g1: 90 });
});

// ---------- slots ----------

const monOnly = (start, end) => [{ weekday: 1, start, end }];

test('slots: an event 16:00-17:00 in a 15:00-19:00 window gives sessions at 15:00 and 17:10', () => {
    const { sessions } = plan(input({
        nowMinutes: 9 * 60, dailyMaxMinutes: 90,
        windows: monOnly('15:00', '19:00'),
        busy: [{ date: TODAY, start: '16:00', minutes: 60 }],
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 90 }] })],
    }));
    assert.deepEqual(sessions, [
        { goalId: 'g1', partId: 'p1', date: TODAY, time: '15:00', minutes: 45 },
        { goalId: 'g1', partId: 'p1', date: TODAY, time: '17:10', minutes: 45 },
    ]);
});

test('slots: a gap of exactly sessionMinutes after the buffers fits, one minute less does not', () => {
    const run = (secondStart) => plan(input({
        nowMinutes: 9 * 60,
        windows: monOnly('14:00', '18:00'),
        busy: [{ date: TODAY, start: '14:00', minutes: 60 }, { date: TODAY, start: secondStart, minutes: 30 }],
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 45 }] })],
    }));
    // 15:00 + 10 buffer = 15:10; 16:05 - 10 buffer = 15:55 → exactly 45 minutes
    const fits = run('16:05');
    assert.deepEqual(times(fits.sessions), ['15:10']);
    const tooShort = run('16:04');
    // the only other room is after the second event: 16:34 + 10 = 16:44..18:00
    assert.deepEqual(times(tooShort.sessions), ['16:44']);
});

test('slots: an event ending 14:55 just before a 15:00 window pushes the first slot to 15:05', () => {
    const { sessions } = plan(input({
        nowMinutes: 9 * 60,
        windows: monOnly('15:00', '19:00'),
        busy: [{ date: TODAY, start: '14:00', minutes: 55 }],
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 45 }] })],
    }));
    assert.deepEqual(times(sessions), ['15:05']);
});

test('slots: two windows on one weekday are both used', () => {
    const { sessions } = plan(input({
        nowMinutes: 7 * 60,
        windows: [{ weekday: 1, start: '18:00', end: '18:45' }, { weekday: 1, start: '08:00', end: '08:45' }],
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 90 }] })],
    }));
    assert.deepEqual(times(sessions), ['08:00', '18:00']);
});

test('slots: no session crosses a window end, not even into an adjoining window', () => {
    const { sessions, shortfall } = plan(input({
        nowMinutes: 7 * 60,
        windows: [{ weekday: 1, start: '15:00', end: '15:30' }, { weekday: 1, start: '15:30', end: '16:00' }, { weekday: 1, start: '17:00', end: '17:40' }],
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 45 }] })],
    }));
    assert.deepEqual(sessions, []);
    assert.deepEqual(shortfall, { g1: 45 });
});

test('slots: consecutive planned sessions keep the 10-minute buffer between them', () => {
    const { sessions } = plan(input({
        nowMinutes: 7 * 60,
        windows: monOnly('15:00', '17:00'),
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 90 }] })],
    }));
    assert.deepEqual(times(sessions), ['15:00', '15:55']);
});

test('slots: today starts no earlier than now, rounded up to 5 minutes', () => {
    const { sessions } = plan(input({
        nowMinutes: 15 * 60 + 17,
        windows: monOnly('15:00', '19:00'),
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 45 }] })],
    }));
    assert.deepEqual(times(sessions), ['15:20']);
});

// ---------- days ----------

test('days: time is null and only the daily max limits', () => {
    const { sessions, shortfall } = plan(input({
        nowMinutes: 18 * 60,
        windows: [{ weekday: 3, start: '15:00', end: '15:30' }],
        busy: [{ date: TODAY, start: '08:00', minutes: 720 }],
        goals: [goal({ due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 225 }] })],
    }));
    assert.equal(sessions.length, 4);
    assert.ok(sessions.every((s) => s.time === null && s.date === TODAY));
    assert.deepEqual(shortfall, { g1: 45 });
});

// ---------- kept ----------

test('kept: minutes count against the daily max and never appear in the output', () => {
    const kept = [{ goalId: 'g1', partId: 'p1', date: TODAY, time: null, minutes: 135 }];
    const { sessions, shortfall } = plan(input({
        kept,
        goals: [goal({ due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 90 }] })],
    }));
    assert.deepEqual(sessions, [{ goalId: 'g1', partId: 'p1', date: TODAY, time: null, minutes: 45 }]);
    assert.deepEqual(shortfall, { g1: 45 });
});

test('kept: a timed kept session blocks its slot with the buffer', () => {
    const kept = [{ goalId: 'g1', partId: 'p1', date: TODAY, time: '15:00', minutes: 45 }];
    const { sessions } = plan(input({
        nowMinutes: 7 * 60,
        kept,
        windows: monOnly('15:00', '19:00'),
        goals: [goal({ planMode: 'slots', due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 45 }] })],
    }));
    assert.deepEqual(sessions, [{ goalId: 'g1', partId: 'p1', date: TODAY, time: '15:55', minutes: 45 }]);
});

test('kept: on another day it changes nothing today', () => {
    const kept = [{ goalId: 'g1', partId: 'p1', date: '2026-11-10', time: null, minutes: 180 }];
    const { sessions } = plan(input({
        kept,
        goals: [goal({ due: '2026-11-10', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 180 }] })],
    }));
    assert.equal(sessions.length, 4);
});

test('kept (pending): its minutes come off its part\'s remaining, so they are not planned twice', () => {
    const kept = [{ goalId: 'g1', partId: 'p1', date: '2026-11-12', time: null, minutes: 45, pending: true }];
    const { sessions, shortfall } = plan(input({
        kept,
        goals: [goal({ parts: [{ id: 'p1', position: 1, role: 'part', remaining: 90 }] })],
    }));
    assert.equal(sessions.reduce((sum, s) => sum + s.minutes, 0), 45);
    assert.deepEqual(shortfall, { g1: 0 });
});

test('kept (not pending, done or with focus time): remaining is not reduced', () => {
    const kept = [{ goalId: 'g1', partId: 'p1', date: '2026-11-12', time: null, minutes: 45, pending: false }];
    const { sessions } = plan(input({
        kept,
        goals: [goal({ parts: [{ id: 'p1', position: 1, role: 'part', remaining: 90 }] })],
    }));
    assert.equal(sessions.reduce((sum, s) => sum + s.minutes, 0), 90);
});

test('kept (pending): remaining never goes below 0, other parts are untouched', () => {
    const kept = [
        { goalId: 'g1', partId: 'p1', date: '2026-11-12', time: null, minutes: 45, pending: true },
        { goalId: 'g1', partId: 'p1', date: '2026-11-13', time: null, minutes: 45, pending: true },
    ];
    const { sessions, shortfall } = plan(input({
        kept,
        goals: [goal({ parts: [
            { id: 'p1', position: 1, role: 'part', remaining: 60 },
            { id: 'p2', position: 2, role: 'part', remaining: 45 },
        ] })],
    }));
    assert.deepEqual(sessions.map((s) => [s.partId, s.minutes]), [['p2', 45]]);
    assert.deepEqual(shortfall, { g1: 0 });
});

// ---------- parts ----------

test('parts: sessions go to parts in position order, whatever the input order', () => {
    const { sessions } = plan(input({
        goals: [goal({ parts: [
            { id: 'p2', position: 2, role: 'part', remaining: 100 },
            { id: 'p1', position: 1, role: 'part', remaining: 45 },
        ] })],
    }));
    assert.deepEqual(sessions.map((s) => [s.partId, s.minutes]), [['p1', 45], ['p2', 45], ['p2', 55]]);
});

test('parts: a review part does not break the single-goal plan', () => {
    const { sessions, shortfall } = plan(input({
        goals: [goal({ parts: [
            { id: 'p1', position: 1, role: 'part', remaining: 90 },
            { id: 'r', position: 2, role: 'review', remaining: 45 },
        ] })],
    }));
    assert.equal(sessions.reduce((sum, s) => sum + s.minutes, 0), 135);
    assert.deepEqual(shortfall, { g1: 0 });
});

// ---------- shortfall ----------

test('shortfall: more remaining than capacity plans what fits, the rest is shortfall', () => {
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 90,
        goals: [goal({ due: '2026-11-11', parts: [{ id: 'p1', position: 1, role: 'part', remaining: 300 }] })],
    }));
    assert.deepEqual(dates(sessions), ['2026-11-09', '2026-11-09', '2026-11-10', '2026-11-10']);
    assert.deepEqual(shortfall, { g1: 120 });
});

test('shortfall: due tomorrow with nothing left today gives zero sessions and full shortfall', () => {
    const slots = plan(input({
        nowMinutes: 19 * 60 + 30,
        windows: everyDay('15:00', '19:00'),
        goals: [goal({ planMode: 'slots', due: '2026-11-10' })],
    }));
    assert.deepEqual(slots, { sessions: [], shortfall: { g1: 270 } });
    const days = plan(input({ nowMinutes: 19 * 60, goals: [goal({ due: '2026-11-10' })] }));
    assert.deepEqual(days, { sessions: [], shortfall: { g1: 270 } });
});

test('shortfall: due today or in the past gives zero sessions and full shortfall', () => {
    for (const due of [TODAY, '2026-11-01']) {
        assert.deepEqual(plan(input({ goals: [goal({ due })] })), { sessions: [], shortfall: { g1: 270 } });
    }
});

test('never a session on or after the due date', () => {
    const { sessions } = plan(input({ dailyMaxMinutes: 720, goals: [goal({ parts: [{ id: 'p1', position: 1, role: 'part', remaining: 5000 }] })] }));
    assert.ok(sessions.length > 0);
    assert.ok(sessions.every((s) => s.date < '2026-11-15'));
});

// ---------- malformed input ----------

test('plan: a malformed today or due throws a TypeError', () => {
    for (const today of ['2026-11-9', '09.11.2026', '', null, new Date('2026-11-09T00:00:00Z'), '2026-13-40']) {
        assert.throws(() => plan(input({ today })), TypeError, String(today));
    }
    for (const due of ['2026-11-15T00:00:00Z', undefined, new Date('2026-11-15T00:00:00Z'), '2026-02-30x']) {
        assert.throws(() => plan(input({ goals: [goal({ due })] })), TypeError, String(due));
    }
});

test('plan: non-positive or non-finite session length or daily max throws a TypeError', () => {
    for (const bad of [0, -45, NaN, Infinity, undefined, '45']) {
        assert.throws(() => plan(input({ sessionMinutes: bad })), TypeError, `sessionMinutes ${bad}`);
        assert.throws(() => plan(input({ dailyMaxMinutes: bad })), TypeError, `dailyMaxMinutes ${bad}`);
    }
});

test('chunk: a non-positive or non-finite size throws instead of looping', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined]) {
        assert.throws(() => chunk(100, bad), TypeError, String(bad));
    }
});

// ---------- ties ----------

test('ties: numeric ids break numerically, goal 9 before goal 10', () => {
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 45,
        goals: [
            goal({ id: 10, due: '2026-11-10', parts: [{ id: 101, position: 1, role: 'part', remaining: 45 }] }),
            goal({ id: 9, due: '2026-11-10', parts: [{ id: 91, position: 1, role: 'part', remaining: 45 }] }),
        ],
    }));
    assert.deepEqual(sessions.map((s) => s.goalId), [9]);
    assert.deepEqual(shortfall, { 9: 0, 10: 45 });
});

// ---------- determinism ----------

test('determinism: the same input twice gives the same output, input untouched', () => {
    const make = () => input({
        nowMinutes: 9 * 60,
        windows: [...everyDay('15:00', '19:00'), { weekday: 2, start: '08:00', end: '10:00' }],
        busy: [{ date: TODAY, start: '16:00', minutes: 60 }, { date: '2026-11-11', start: '15:30', minutes: 90 }],
        kept: [{ goalId: 'g1', partId: 'p1', date: '2026-11-12', time: '15:00', minutes: 45 }],
        goals: [goal({ planMode: 'slots', parts: [
            { id: 'p2', position: 2, role: 'part', remaining: 200 },
            { id: 'p1', position: 1, role: 'part', remaining: 130 },
        ] })],
    });
    const a = make();
    const first = plan(a);
    assert.deepEqual(a, make());
    assert.deepEqual(plan(make()), first);
});

// ---------- several goals (task 4) ----------

const part = (id, remaining, over = {}) => ({ id, position: 1, role: 'part', remaining, ...over });
const review = (id, remaining, position = 2) => ({ id, position, role: 'review', remaining });
const minutesOf = (sessions) => sessions.reduce((sum, s) => sum + s.minutes, 0);
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const perDayMinutes = (sessions) => {
    const perDay = {};
    for (const s of sessions) perDay[s.date] = (perDay[s.date] || 0) + s.minutes;
    return perDay;
};

test('several goals: each stays before its own due; on shared days the earlier-due goal comes first', () => {
    const { sessions, shortfall } = plan(input({
        windows: everyDay('15:00', '19:00'),
        goals: [
            goal({ id: 'b', planMode: 'slots', due: '2026-11-19', parts: [part('pb', 450)] }),
            goal({ id: 'a', planMode: 'slots', due: '2026-11-14', parts: [part('pa', 225)] }),
        ],
    }));
    const a = sessions.filter((s) => s.goalId === 'a');
    const b = sessions.filter((s) => s.goalId === 'b');
    assert.equal(a.length, 5);
    assert.equal(b.length, 10);
    assert.ok(a.every((s) => s.date < '2026-11-14'));
    assert.ok(b.every((s) => s.date < '2026-11-19'));
    assert.deepEqual(shortfall, { a: 0, b: 0 });
    for (const date of new Set(dates(a))) {
        const onDay = sessions.filter((s) => s.date === date);
        assert.equal(onDay[0].goalId, 'a', date);
        const lastA = Math.max(...onDay.filter((s) => s.goalId === 'a').map((s) => toMin(s.time)));
        const firstB = Math.min(...onDay.filter((s) => s.goalId === 'b').map((s) => toMin(s.time)));
        assert.ok(lastA < firstB, date);
    }
});

test('several goals: capacity of 3 sessions a day gives one of each goal, not three of one (Mathe · Bio · Statistik)', () => {
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 135,
        goals: [3, 1, 2].map((id) => goal({ id, due: '2026-11-12', parts: [part(id * 10, 135)] })),
    }));
    const byDay = {};
    for (const s of sessions) (byDay[s.date] ||= []).push(s.goalId);
    assert.deepEqual(byDay, {
        '2026-11-09': [1, 2, 3],
        '2026-11-10': [1, 2, 3],
        '2026-11-11': [1, 2, 3],
    });
    assert.deepEqual(shortfall, { 1: 0, 2: 0, 3: 0 });
});

test('several goals: overlapping deadlines with too little capacity plan the earlier goal fully', () => {
    // capacity 4 days × 90 = 360; goal 1 (due 11-12) needs 180, goal 2 (due 11-13) needs 270
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 90,
        goals: [
            goal({ id: 2, due: '2026-11-13', parts: [part(20, 270)] }),
            goal({ id: 1, due: '2026-11-12', parts: [part(10, 180)] }),
        ],
    }));
    assert.deepEqual(shortfall, { 1: 0, 2: 90 });
    const first = sessions.filter((s) => s.goalId === 1);
    assert.equal(minutesOf(first), 180);
    assert.ok(first.every((s) => s.date < '2026-11-12'));
    for (const minutes of Object.values(perDayMinutes(sessions))) assert.ok(minutes <= 90);
});

test('several goals: a goal that cannot fit by its own due does not push shortfall onto a later goal', () => {
    // one session a day; goal 1 has 2 days for 5 sessions, goal 2 has 10 days for 8 sessions
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 45,
        goals: [
            goal({ id: 1, due: '2026-11-11', parts: [part(10, 225)] }),
            goal({ id: 2, due: '2026-11-19', parts: [part(20, 360)] }),
        ],
    }));
    assert.deepEqual(shortfall, { 1: 135, 2: 0 });
    assert.deepEqual(dates(sessions.filter((s) => s.goalId === 1)), ['2026-11-09', '2026-11-10']);
});

test('several goals: goals due the same day share a shortfall, one session each in turn', () => {
    // room 3 days × 135 = 405 for 3 × 270: each loses 135, none is dropped entirely
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 135,
        goals: [3, 1, 2].map((id) => goal({ id, due: '2026-11-12', parts: [part(id * 10, 270)] })),
    }));
    assert.deepEqual(shortfall, { 1: 135, 2: 135, 3: 135 });
    assert.deepEqual(sessions.map((s) => s.goalId), [1, 2, 3, 1, 2, 3, 1, 2, 3]);
});

test('several goals: a later goal leaves today a whole session for an earlier goal that needs it', () => {
    // goal 1 needs 180 in 2 days of 120: 60 must go today, i.e. two 45-minute sessions, not one
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 120,
        goals: [
            goal({ id: 1, due: '2026-11-11', parts: [part(10, 180)] }),
            goal({ id: 2, due: '2026-11-19', parts: [part(20, 90)] }),
        ],
    }));
    assert.deepEqual(shortfall, { 1: 0, 2: 0 });
    assert.deepEqual(dates(sessions.filter((s) => s.goalId === 1)), ['2026-11-09', '2026-11-09', '2026-11-10', '2026-11-10']);
});

test('review: up to one session lands on the last planning day, never on the due day', () => {
    const { sessions, shortfall } = plan(input({
        goals: [goal({ parts: [part('p1', 90), review('r', 45)] })],
    }));
    assert.deepEqual(dates(sessions.filter((s) => s.partId === 'r')), ['2026-11-14']);
    assert.ok(sessions.every((s) => s.date < '2026-11-15'));
    assert.deepEqual(shortfall, { g1: 0 });
});

test('review: more than one session is split over the last 2 planning days', () => {
    const { sessions, shortfall } = plan(input({
        goals: [goal({ parts: [part('p1', 90), review('r', 120)] })],
    }));
    assert.deepEqual(sessions.filter((s) => s.partId === 'r').map((s) => [s.date, s.minutes]),
        [['2026-11-13', 45], ['2026-11-13', 45], ['2026-11-14', 30]]);
    assert.ok(sessions.every((s) => s.date < '2026-11-15'));
    assert.deepEqual(shortfall, { g1: 0 });
});

test('review: a review that does not fit its last day becomes shortfall', () => {
    const { sessions, shortfall } = plan(input({
        kept: [{ goalId: 'g1', partId: 'p1', date: '2026-11-14', time: null, minutes: 180, pending: false }],
        goals: [goal({ parts: [part('p1', 90), review('r', 45)] })],
    }));
    assert.deepEqual(sessions.filter((s) => s.partId === 'r'), []);
    assert.equal(minutesOf(sessions), 90);
    assert.deepEqual(shortfall, { g1: 45 });
});

test('kept: sessions of goal A reduce capacity and block slots for goal B on that day', () => {
    const daysRun = plan(input({
        kept: [{ goalId: 'a', partId: 'pa', date: TODAY, time: null, minutes: 135 }],
        goals: [
            goal({ id: 'a', due: '2026-11-10', parts: [part('pa', 0)] }),
            goal({ id: 'b', due: '2026-11-10', parts: [part('pb', 90)] }),
        ],
    }));
    assert.deepEqual(daysRun.sessions, [{ goalId: 'b', partId: 'pb', date: TODAY, time: null, minutes: 45 }]);
    assert.deepEqual(daysRun.shortfall, { a: 0, b: 45 });

    const slotsRun = plan(input({
        windows: monOnly('15:00', '16:45'),
        kept: [{ goalId: 'a', partId: 'pa', date: TODAY, time: '15:00', minutes: 45 }],
        goals: [
            goal({ id: 'a', planMode: 'slots', due: '2026-11-10', parts: [part('pa', 0)] }),
            goal({ id: 'b', planMode: 'slots', due: '2026-11-10', parts: [part('pb', 90)] }),
        ],
    }));
    assert.deepEqual(slotsRun.sessions, [{ goalId: 'b', partId: 'pb', date: TODAY, time: '15:55', minutes: 45 }]);
    assert.deepEqual(slotsRun.shortfall, { a: 0, b: 45 });
});

test('mixed modes: a days goal and a slots goal share the daily max; only the slots one needs a gap', () => {
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 135,
        windows: monOnly('15:00', '15:45'),
        goals: [
            goal({ id: 's', planMode: 'slots', due: '2026-11-10', parts: [part('ps', 90)] }),
            goal({ id: 'd', planMode: 'days', due: '2026-11-10', parts: [part('pd', 90)] }),
        ],
    }));
    assert.deepEqual(times(sessions.filter((s) => s.goalId === 'd')), [null, null]);
    assert.deepEqual(times(sessions.filter((s) => s.goalId === 's')), ['15:00']);
    assert.ok(minutesOf(sessions) <= 135);
    assert.deepEqual(shortfall, { d: 0, s: 45 });
});

test('determinism with several goals: same output twice, input untouched, never overbooked', () => {
    const make = () => input({
        nowMinutes: 9 * 60, dailyMaxMinutes: 150,
        windows: [...everyDay('15:00', '19:00'), { weekday: 2, start: '08:00', end: '10:00' }],
        busy: [{ date: TODAY, start: '16:00', minutes: 60 }, { date: '2026-11-11', start: '15:30', minutes: 90 }],
        kept: [{ goalId: 1, partId: 11, date: '2026-11-12', time: '15:00', minutes: 45, pending: true }],
        goals: [
            goal({ id: 2, due: '2026-11-18', parts: [part(21, 300), review(22, 100)] }),
            goal({ id: 1, planMode: 'slots', due: '2026-11-14', parts: [
                part(12, 200, { position: 2 }),
                part(11, 130, { position: 1 }),
                review(13, 60, 3),
            ] }),
            goal({ id: 3, planMode: 'slots', due: '2026-11-12', parts: [part(31, 180)] }),
        ],
    });
    const a = make();
    const first = plan(a);
    assert.deepEqual(a, make());
    assert.deepEqual(plan(make()), first);
    const dueOf = { 1: '2026-11-14', 2: '2026-11-18', 3: '2026-11-12' };
    assert.ok(first.sessions.length > 0);
    assert.ok(first.sessions.every((s) => s.date < dueOf[s.goalId]));
    const perDay = perDayMinutes(first.sessions);
    perDay['2026-11-12'] = (perDay['2026-11-12'] || 0) + 45;
    for (const minutes of Object.values(perDay)) assert.ok(minutes <= 150);
});

// ---------- fix round 1 (task 4 review) ----------

// Mon 08:00-14:00 holds 6 sessions; Tue and Wed hold one each
const monLongTueWedShort = (tueWedEnd) => [
    { weekday: 1, start: '08:00', end: '14:00' },
    { weekday: 2, start: '15:00', end: tueWedEnd },
    { weekday: 3, start: '15:00', end: tueWedEnd },
];

test('slots: a later-due slots goal does not take the gap an earlier goal needs today', () => {
    // each day's window holds two sessions; goal A needs 4 in its 2 days, B has 10 days for 1
    const windows = everyDay('15:00', '16:40');
    const A = goal({ id: 'A', planMode: 'slots', due: '2026-11-11', parts: [part('a', 180)] });
    const B = goal({ id: 'B', planMode: 'slots', due: '2026-11-19', parts: [part('b', 45)] });
    assert.deepEqual(plan(input({ nowMinutes: 7 * 60, windows, goals: [A] })).shortfall, { A: 0 });
    const both = plan(input({ nowMinutes: 7 * 60, windows, goals: [A, B] }));
    assert.deepEqual(both.shortfall, { A: 0, B: 0 });
    assert.deepEqual(dates(both.sessions.filter((s) => s.goalId === 'A')), ['2026-11-09', '2026-11-09', '2026-11-10', '2026-11-10']);
});

test('slots: an unrelated days goal does not hide how little the slots days hold', () => {
    const run = (goals) => plan(input({ nowMinutes: 7 * 60, dailyMaxMinutes: 360, windows: monLongTueWedShort('15:45'), goals }));
    const A = goal({ id: 'A', planMode: 'slots', due: '2026-11-12', parts: [part('a', 270)] });
    const B = goal({ id: 'B', planMode: 'days', due: '2026-11-19', parts: [part('b', 45)] });
    assert.deepEqual(run([A]).shortfall, { A: 0 });
    assert.deepEqual(run([A, B]).shortfall, { A: 0, B: 0 });
});

test('slots: a 90-minute window counts as one session, not 90 minutes, when planning ahead', () => {
    const { sessions, shortfall } = plan(input({
        nowMinutes: 7 * 60, dailyMaxMinutes: 360, windows: monLongTueWedShort('16:30'),
        goals: [goal({ id: 'A', planMode: 'slots', due: '2026-11-12', parts: [part('a', 360)] })],
    }));
    assert.deepEqual(shortfall, { A: 0 });
    assert.deepEqual(Object.values(perDayMinutes(sessions)), [270, 45, 45]);
});

test('slots: a merged 50-minute chunk still counts as fitting a 60-minute window', () => {
    // 230 → chunks 45, 45, 45, 45, 50; one 17:00-18:00 window a day for 5 days
    const { sessions, shortfall } = plan(input({
        nowMinutes: 7 * 60, windows: everyDay('17:00', '18:00'),
        goals: [goal({ id: 'A', planMode: 'slots', due: '2026-11-14', parts: [part('a', 230)] })],
    }));
    assert.deepEqual(shortfall, { A: 0 });
    assert.deepEqual(sessions.map((s) => s.minutes), [45, 45, 45, 45, 50]);
});

test('slots: a short last chunk still counts as fitting a window shorter than a session', () => {
    // 60-minute sessions, 200 → chunks 60, 60, 60, 20; Mon-Wed 60-minute windows, Thu 30 minutes
    const { sessions, shortfall } = plan(input({
        nowMinutes: 7 * 60, sessionMinutes: 60,
        windows: [1, 2, 3].map((weekday) => ({ weekday, start: '17:00', end: '18:00' })).concat({ weekday: 4, start: '17:00', end: '17:30' }),
        goals: [goal({ id: 'A', planMode: 'slots', due: '2026-11-13', parts: [part('a', 200)] })],
    }));
    assert.deepEqual(shortfall, { A: 0 });
    assert.deepEqual(sessions.at(-1), { goalId: 'A', partId: 'a', date: '2026-11-12', time: '17:00', minutes: 20 });
});

test('slots: later goals do not take a gap an earlier goal needs on room its chunks could not use', () => {
    // goal 1 needs 10 + 60 + 60 + 40 before Thu; Tue (2 h) and Wed (1.5 h left after the review) look
    // like room for 110 + 80, but in part order they take one 60 each, so Mon must hold 10 + 60
    const run = (goals) => plan(input({
        nowMinutes: 14 * 60, sessionMinutes: 60, dailyMaxMinutes: 315,
        windows: [
            { weekday: 1, start: '15:00', end: '17:30' }, { weekday: 2, start: '09:30', end: '11:30' },
            { weekday: 3, start: '07:00', end: '09:30' }, { weekday: 4, start: '12:00', end: '16:00' },
        ],
        goals,
    }));
    const first = goal({ id: 1, planMode: 'slots', due: '2026-11-12', parts: [
        part(11, 10), part(12, 160, { position: 2 }), review(13, 50, 9),
    ] });
    assert.deepEqual(run([first]).shortfall, { 1: 0 });
    const all = run([
        first,
        goal({ id: 2, planMode: 'slots', due: '2026-11-21', parts: [part(21, 40)] }),
        goal({ id: 3, planMode: 'slots', due: '2026-11-18', parts: [part(31, 40)] }),
    ]);
    assert.deepEqual(all.shortfall, { 1: 0, 2: 0, 3: 0 });
});

test('review: on its day it comes after the goal\'s regular sessions (slots and days)', () => {
    const run = (planMode) => plan(input({
        nowMinutes: 7 * 60, windows: everyDay('15:00', '19:00'),
        goals: [goal({ planMode, due: '2026-11-12', parts: [part('p', 360), review('r', 45)] })],
    }));
    for (const planMode of ['slots', 'days']) {
        const { sessions, shortfall } = run(planMode);
        assert.deepEqual(shortfall, { g1: 0 }, planMode);
        const onDay = sessions.filter((s) => s.date === '2026-11-11');
        assert.equal(onDay.at(-1).partId, 'r', planMode);
        assert.ok(onDay.filter((s) => s.partId === 'p').length > 0, planMode);
        if (planMode === 'slots') {
            const reviewAt = toMin(onDay.at(-1).time);
            assert.ok(onDay.slice(0, -1).every((s) => toMin(s.time) < reviewAt), planMode);
        }
    }
});

test('feasibility: goals due the same day lose sessions from the largest first, so a small goal keeps its one', () => {
    // one session a day for 5 days, 13 sessions wanted: goals 2 and 3 keep 2 each, goal 1 its single one
    const { sessions, shortfall } = plan(input({
        dailyMaxMinutes: 45,
        goals: [
            goal({ id: 1, due: '2026-11-14', parts: [part(10, 45)] }),
            goal({ id: 2, due: '2026-11-14', parts: [part(20, 270)] }),
            goal({ id: 3, due: '2026-11-14', parts: [part(30, 270)] }),
        ],
    }));
    assert.deepEqual(shortfall, { 1: 0, 2: 180, 3: 180 });
    assert.equal(sessions.filter((s) => s.goalId === 1).length, 1);
});
