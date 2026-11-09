// Study planner: turns study goals (parts with remaining minutes), the user's study windows and the
// events already in the calendar into proposed study sessions. A pure function: no DB, no clock —
// `today` and `nowMinutes` come in from the caller, already in the user's local time. Dates are
// 'YYYY-MM-DD' text, calculated in UTC so the server's timezone never shifts them; times are
// minutes since midnight inside, 'HH:MM' only at the edges.
//
// All active goals are planned together, in three steps (spec §2 steps 4–7):
// 1. review parts are reserved on each goal's last one or two planning days;
// 2. a feasibility pass cuts what can't fit from the latest-due goals, so earlier goals keep theirs;
// 3. the days are filled in order. Spreading (controller ruling 1): on planning day i (0-based) of a
//    goal's N days, the goal takes chunks while its planned minutes so far < total · (i + 1) / N,
//    one chunk per goal per round, goals by (due, pace, id). A day that can't give what the curve
//    asks leaves the rest to later days, where the curve catches up — unless the later days are too
//    full for that, then the goal must take it today and later-due goals leave it the room.

const BUFFER = 10;              // minutes kept free around every busy item
const MIN_CHUNK = 15;           // a leftover under this is merged into the previous chunk
const DAYS_CUTOFF = 19 * 60;    // `days` mode: from 19:00 on, today is no longer planned
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const isPositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
// A real calendar day as 'YYYY-MM-DD' text (a Date object or '2026-02-30' is not)
const isDay = (value) => typeof value === 'string' && DAY_KEY.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
// Today's slots start no earlier than now, rounded up to 5 minutes
const roundUp = (minutes) => Math.ceil(minutes / 5) * 5;
// Numbers compare as numbers (9 before 10), anything else as text
const compareIds = (a, b) => (typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b)));
const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
};
const toHHMM = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
// 1 = Monday … 7 = Sunday
const weekdayOf = (day) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const windowsOn = (day, windows) => {
    const weekday = weekdayOf(day);
    return windows
        .filter((w) => w.weekday === weekday)
        .map((w) => ({ start: toMinutes(w.start), end: toMinutes(w.end) }))
        .filter((w) => w.end > w.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
};

// Minutes cut into session lengths; a leftover under 15 minutes goes into the previous chunk
function chunk(minutes, sessionMinutes) {
    if (!isPositive(sessionMinutes)) throw new TypeError(`chunk: session length must be a positive number, got ${sessionMinutes}`);
    const chunks = [];
    let left = Math.max(0, Math.round(minutes || 0));
    while (left > 0) {
        const size = Math.min(sessionMinutes, left);
        if (size < MIN_CHUNK && chunks.length) chunks[chunks.length - 1] += size;
        else chunks.push(size);
        left -= size;
    }
    return chunks;
}

// The days a goal can be studied on: from today (tomorrow once today is over) to the day before
// `due`. In `slots` mode only weekdays that have a window count, and today only while some window
// still has a whole session left after now (rounded up to 5 minutes).
function planningDays(goal, today, nowMinutes, windows, sessionMinutes = 1) {
    if (!isDay(goal.due) || !isDay(today)) return [];
    const slots = goal.planMode === 'slots';
    const now = roundUp(nowMinutes);
    const todayOver = slots
        ? !windowsOn(today, windows).some((w) => w.end - Math.max(w.start, now) >= sessionMinutes)
        : nowMinutes >= DAYS_CUTOFF;
    const days = [];
    for (let day = todayOver ? addDays(today, 1) : today; day < goal.due; day = addDays(day, 1)) {
        if (!slots || windowsOn(day, windows).length) days.push(day);
    }
    return days;
}

// Taking [from, to) out of a sorted list of gaps
function cut(gaps, from, to) {
    const out = [];
    for (const g of gaps) {
        if (to <= g.start || from >= g.end) { out.push(g); continue; }
        if (from > g.start) out.push({ start: g.start, end: from });
        if (to < g.end) out.push({ start: to, end: g.end });
    }
    return out;
}

// Free time on a day, in minutes: that weekday's windows minus busy events and kept timed sessions,
// each with a 10-minute buffer on both sides. Windows stay separate, so a gap never spans two.
function freeGaps(date, windows, busy, keptOnDay) {
    let gaps = windowsOn(date, windows);
    const blocks = [
        ...busy.filter((b) => b.date === date && b.start),
        ...keptOnDay.filter((k) => (k.date === undefined || k.date === date) && k.time)
            .map((k) => ({ start: k.time, minutes: k.minutes })),
    ];
    for (const b of blocks) {
        const start = toMinutes(b.start);
        gaps = cut(gaps, start - BUFFER, start + (Number(b.minutes) || 0) + BUFFER);
    }
    return gaps;
}

// Malformed input must surface (→ 400), not look like "doesn't fit"
function validate(input) {
    if (!isDay(input.today)) throw new TypeError(`plan: today must be 'YYYY-MM-DD', got ${input.today}`);
    for (const key of ['sessionMinutes', 'dailyMaxMinutes']) {
        if (!isPositive(input[key])) throw new TypeError(`plan: ${key} must be a positive number, got ${input[key]}`);
    }
    for (const goal of input.goals) {
        if (!isDay(goal.due)) throw new TypeError(`plan: goal ${goal.id} due must be 'YYYY-MM-DD', got ${goal.due}`);
    }
}

// Minutes per part already covered by pending kept sessions (future, not done, no focus time):
// they are still in the part's `remaining`, so planning them again would double-book (ruling 7)
function pendingByPart(kept) {
    const minutes = new Map();
    for (const k of kept) {
        if (k.pending) minutes.set(k.partId, (minutes.get(k.partId) || 0) + (Number(k.minutes) || 0));
    }
    return minutes;
}

const sumMinutes = (chunks) => chunks.reduce((sum, c) => sum + c.minutes, 0);

// A goal's chunks in the order they are handed out: parts by position, each cut into sessions.
// Review parts get their own queue: they are reserved on the last days, outside the curve.
function goalState(goal, input, pending) {
    const parts = [...goal.parts].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
    const queue = [];
    const review = [];
    for (const part of parts) {
        const remaining = Math.max(0, (Number(part.remaining) || 0) - (pending.get(part.id) || 0));
        const target = part.role === 'review' ? review : queue;
        for (const minutes of chunk(remaining, input.sessionMinutes)) target.push({ partId: part.id, minutes });
    }
    const total = sumMinutes(queue);
    const need = total + sumMinutes(review);
    const days = planningDays(goal, input.today, input.nowMinutes, input.windows, input.sessionMinutes);
    // `total` is what the curve spreads (cut by the feasibility pass); `placed` counts everything
    return { goal, queue, review, total, need, planned: 0, placed: 0, days, pace: days.length ? need / days.length : Infinity };
}

const byDue = (a, b) => (a.goal.due < b.goal.due ? -1 : a.goal.due > b.goal.due ? 1 : 0);
// Urgency: earliest due, then highest pace, then id
const byUrgency = (a, b) => byDue(a, b) || b.pace - a.pace || compareIds(a.goal.id, b.goal.id);

// What the day still has room for: minutes under the daily max, and (for `slots`) free gaps
function dayState(date, input) {
    const keptOnDay = input.kept.filter((k) => k.date === date);
    const keptMinutes = keptOnDay.reduce((sum, k) => sum + (Number(k.minutes) || 0), 0);
    let gaps = freeGaps(date, input.windows, input.busy, keptOnDay);
    if (date === input.today) gaps = cut(gaps, 0, roundUp(input.nowMinutes));
    return { date, capacity: input.dailyMaxMinutes - keptMinutes, gaps };
}

// One chunk of a goal onto the day, if it fits; returns the session or null. `slots` take the
// earliest gap that fits, or with `latest` the end of the last gap that fits.
function place(goal, next, day, latest = false) {
    if (next.minutes > day.capacity) return null;
    let time = null;
    if (goal.planMode === 'slots') {
        const fits = (g) => g.end - g.start >= next.minutes;
        const gap = latest ? day.gaps.findLast(fits) : day.gaps.find(fits);
        if (!gap) return null;
        time = latest ? gap.end - next.minutes : gap.start;
        day.gaps = cut(day.gaps, time - BUFFER, time + next.minutes + BUFFER);
    }
    day.capacity -= next.minutes;
    return { goalId: goal.id, partId: next.partId, date: day.date, time: time === null ? null : toHHMM(time), minutes: next.minutes };
}

// Step 1. Review parts go first: on the goal's last planning day, or split over its last two when
// they need more than one session (the earlier half on the day before). A review session that
// doesn't fit tries the other review day; after that it is shortfall. In `slots` a review takes the
// end of the day's last free gap, so the goal's regular sessions that day come before it.
function reserveReviews(states, dayMap, record) {
    for (const s of states) {
        if (!s.days.length || !s.review.length) continue;
        const reviewDays = s.review.length > 1 && s.days.length > 1 ? s.days.slice(-2) : s.days.slice(-1);
        const onFirst = Math.ceil(s.review.length / reviewDays.length);
        s.review.forEach((next, k) => {
            for (const date of (k < onFirst ? reviewDays : [...reviewDays].reverse())) {
                const session = place(s.goal, next, dayMap.get(date), true);
                if (session) { record(s, session, true); break; }
            }
        });
    }
}

// The most minutes whole chunks can fill in one gap, as a true upper bound: k chunks fit only if the
// k smallest do (with the buffer between them), and then fill at most the k largest, and at most
// the gap minus the k - 1 inner buffers. `small` / `large` are running sums of the chunk sizes
// sorted up / down.
function gapRoom(length, small, large) {
    let best = 0;
    for (let k = 1; k < small.length && small[k] + (k - 1) * BUFFER <= length; k++) {
        best = Math.max(best, Math.min(large[k], length - (k - 1) * BUFFER));
    }
    return best;
}

const runningSums = (sizes) => {
    const sums = [0];
    for (const m of sizes) sums.push(sums[sums.length - 1] + m);
    return sums;
};

// What each day can still hold once the reviews are in: `minutes` under the daily max, and its
// free `gaps` (future days are not touched again until they are filled, so this stays valid)
function estimateRoom(dayMap) {
    const room = new Map();
    for (const [date, day] of dayMap) room.set(date, { minutes: Math.max(0, day.capacity), gaps: day.gaps });
    return room;
}

// The room some goals have on some days: a day gives its minutes, or, when every one of these goals
// that can use it plans in slots, what fits in its free gaps. That has two estimates:
// - without `sessionMinutes`, a true upper bound: what these goals' own chunks could fill. The
//   feasibility cut uses it, so it never cuts a session that would have fitted.
// - with `sessionMinutes`, the whole standard sessions the gaps take (10-minute buffer between
//   them). The daily needs use it, so an earlier goal places today rather than count on room its
//   chunks may not get later (a longer chunk, a gap a later goal took, Ruling 6e).
function roomFor(group, days, room, sessionMinutes = null) {
    let fill;
    if (sessionMinutes) {
        fill = (length) => Math.floor((length + BUFFER) / (sessionMinutes + BUFFER)) * sessionMinutes;
    } else {
        const sizes = group.flatMap((s) => s.queue.map((c) => c.minutes)).sort((a, b) => a - b);
        const small = runningSums(sizes);
        const large = runningSums([...sizes].reverse());
        fill = (length) => gapRoom(length, small, large);
    }
    let sum = 0;
    for (const d of days) {
        const { minutes, gaps } = room.get(d);
        const onlySlots = group.every((s) => s.goal.planMode === 'slots' || !s.days.includes(d));
        sum += onlySlots ? Math.min(minutes, gaps.reduce((t, g) => t + fill(g.end - g.start), 0)) : minutes;
    }
    return sum;
}

// Step 2. Feasibility, deadline by deadline: the goals due by D must fit the room on their days.
// Where they don't, the latest-due goals lose their last sessions, so earlier goals keep their
// minutes. Going from the earliest deadline up, the goals due before D already fit (their days are a
// subset of D's), so only the goals due on D are cut, one session at a time from the one with the
// most minutes left (ties: least urgent) — a small goal keeps its sessions, none loses everything.
function cutToFit(states, room) {
    const live = states.filter((s) => s.days.length && s.queue.length);
    for (const due of [...new Set(live.map((s) => s.goal.due))].sort()) {
        const group = live.filter((s) => s.goal.due <= due);
        let excess = group.reduce((sum, s) => sum + s.total, 0) - roomFor(group, new Set(group.flatMap((s) => s.days)), room);
        const onDue = group.filter((s) => s.goal.due === due);
        while (excess > 0) {
            const s = onDue.reduce((most, o) => (o.queue.length && (!most || o.total >= most.total) ? o : most), null);
            if (!s) break;
            const last = s.queue.pop();
            s.total -= last.minutes;
            excess -= last.minutes;
        }
    }
}

// Per deadline D, the minutes the goals due by D must place today because the days after today
// can't hold all of their remaining minutes
function needsOn(date, states, room, sessionMinutes) {
    const live = states.filter((s) => s.queue.length && s.days.some((d) => d >= date));
    return [...new Set(live.map((s) => s.goal.due))].sort().map((due) => {
        const group = live.filter((s) => s.goal.due <= due);
        const remaining = group.reduce((sum, s) => sum + s.total - s.planned, 0);
        const later = roomFor(group, new Set(group.flatMap((s) => s.days.filter((d) => d > date))), room, sessionMinutes);
        return { due, minutes: Math.max(0, remaining - later) };
    });
}

// Step 3. One day: goals by (due, today's pace, id), one chunk per goal per round, while a goal is
// behind its curve (ruling 1) or its deadline needs minutes today. A goal waits while an earlier
// deadline still needs minutes today; a chunk that doesn't fit ends the goal's day.
function fillDay(date, states, day, room, record, sessionMinutes) {
    const needs = needsOn(date, states, room, sessionMinutes);
    const indexOf = (s) => s.days.indexOf(date);
    const pace = (s) => (s.total - s.planned) / (s.days.length - indexOf(s));
    const open = states.filter((s) => indexOf(s) >= 0 && s.queue.length)
        .sort((a, b) => byDue(a, b) || pace(b) - pace(a) || compareIds(a.goal.id, b.goal.id));
    const stopped = new Set();
    const behind = (s) => s.planned * s.days.length < s.total * (indexOf(s) + 1);
    // A goal owes while any deadline from its own on still needs minutes today. That includes a
    // later deadline: when the days ahead are full for the goals due by D, every one of them may
    // take today's room, so an earlier goal can move ahead of its curve to free later days.
    const owes = (s) => needs.some((n) => n.due >= s.goal.due && n.minutes > 0);
    // A later-due goal waits while an earlier deadline still needs minutes today and one of its goals
    // can still place: the earlier goals take their whole sessions and their gaps first
    const waits = (s) => needs.some((n) => n.due < s.goal.due && n.minutes > 0
        && open.some((o) => o.goal.due <= n.due && o.queue.length && !stopped.has(o)));

    // Goals are in due order, so whoever a goal waits for has had its turn earlier in the same round
    let progress = true;
    while (progress) {
        progress = false;
        for (const s of open) {
            if (stopped.has(s) || !s.queue.length || !(behind(s) || owes(s)) || waits(s)) continue;
            const next = s.queue[0];
            const session = place(s.goal, next, day);
            if (!session) { stopped.add(s); continue; }
            s.queue.shift();
            s.planned += next.minutes;
            record(s, session);
            for (const n of needs) if (n.due >= s.goal.due) n.minutes = Math.max(0, n.minutes - next.minutes);
            progress = true;
        }
    }
}

// Output order: by day; on a day untimed sessions (by goal urgency, a goal's review after its
// regular sessions) before timed ones (by time)
const byDayAndTime = (a, b) => (a.session.date < b.session.date ? -1 : a.session.date > b.session.date ? 1 : 0)
    || (a.session.time !== null) - (b.session.time !== null)
    || (a.session.time === null ? a.rank - b.rank || a.review - b.review
        : a.session.time < b.session.time ? -1 : a.session.time > b.session.time ? 1 : 0)
    || a.seq - b.seq;

function plan(input) {
    validate(input);
    const pending = pendingByPart(input.kept);
    const states = input.goals.map((goal) => goalState(goal, input, pending)).sort(byUrgency);
    const allDays = [...new Set(states.flatMap((s) => s.days))].sort();
    const dayMap = new Map(allDays.map((date) => [date, dayState(date, input)]));
    const placed = [];
    const record = (state, session, review = false) => {
        state.placed += session.minutes;
        placed.push({ session, rank: states.indexOf(state), review: Number(review), seq: placed.length });
    };

    reserveReviews(states, dayMap, record);
    const room = estimateRoom(dayMap);
    cutToFit(states, room);
    for (const date of allDays) fillDay(date, states, dayMap.get(date), room, record, input.sessionMinutes);

    const shortfall = {};
    for (const s of states) shortfall[s.goal.id] = s.need - s.placed;
    return { sessions: placed.sort(byDayAndTime).map((p) => p.session), shortfall };
}

module.exports = { plan, chunk, planningDays, freeGaps };
