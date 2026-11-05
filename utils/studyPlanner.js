// Study planner: turns study goals (parts with remaining minutes), the user's study windows and the
// events already in the calendar into proposed study sessions. A pure function: no DB, no clock —
// `today` and `nowMinutes` come in from the caller, already in the user's local time. Dates are
// 'YYYY-MM-DD' text, calculated in UTC so the server's timezone never shifts them; times are
// minutes since midnight inside, 'HH:MM' only at the edges.
//
// Spreading (controller ruling 1): on planning day i (0-based) of a goal's N days, the goal takes
// chunks while its planned minutes so far < total · (i + 1) / N, one chunk per goal per round. A day
// that can't give what the curve asks leaves the rest to later days, where the curve catches up.

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

// A goal's chunks in the order they are handed out: parts by position, each cut into sessions
function goalState(goal, input, pending) {
    const parts = [...goal.parts].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
    const queue = [];
    for (const part of parts) {
        const remaining = Math.max(0, (Number(part.remaining) || 0) - (pending.get(part.id) || 0));
        for (const minutes of chunk(remaining, input.sessionMinutes)) queue.push({ partId: part.id, minutes });
    }
    const total = queue.reduce((sum, c) => sum + c.minutes, 0);
    const days = planningDays(goal, input.today, input.nowMinutes, input.windows, input.sessionMinutes);
    return { goal, queue, total, planned: 0, days, pace: days.length ? total / days.length : Infinity };
}

// Urgency: earliest due, then highest pace, then id
const byUrgency = (a, b) => (a.goal.due < b.goal.due ? -1 : a.goal.due > b.goal.due ? 1 : 0)
    || b.pace - a.pace
    || compareIds(a.goal.id, b.goal.id);

// What the day still has room for: minutes under the daily max, and (for `slots`) free gaps
function dayState(date, input) {
    const keptOnDay = input.kept.filter((k) => k.date === date);
    const keptMinutes = keptOnDay.reduce((sum, k) => sum + (Number(k.minutes) || 0), 0);
    let gaps = freeGaps(date, input.windows, input.busy, keptOnDay);
    if (date === input.today) gaps = cut(gaps, 0, roundUp(input.nowMinutes));
    return { date, capacity: input.dailyMaxMinutes - keptMinutes, gaps };
}

// One chunk of a goal onto the day, if it fits; returns the session or null
function place(state, day) {
    const next = state.queue[0];
    if (!next || next.minutes > day.capacity) return null;
    let time = null;
    if (state.goal.planMode === 'slots') {
        const gap = day.gaps.find((g) => g.end - g.start >= next.minutes);
        if (!gap) return null;
        time = gap.start;
        day.gaps = cut(day.gaps, time - BUFFER, time + next.minutes + BUFFER);
    }
    state.queue.shift();
    state.planned += next.minutes;
    day.capacity -= next.minutes;
    return { goalId: state.goal.id, partId: next.partId, date: day.date, time: time === null ? null : toHHMM(time), minutes: next.minutes };
}

function plan(input) {
    validate(input);
    const pending = pendingByPart(input.kept);
    const states = input.goals.map((goal) => goalState(goal, input, pending)).sort(byUrgency);
    const allDays = [...new Set(states.flatMap((s) => s.days))].sort();
    const sessions = [];

    for (const date of allDays) {
        const day = dayState(date, input);
        // A goal is open on this day while it is behind its curve: planned < total·(i+1)/N
        const behind = (s) => {
            const i = s.days.indexOf(date);
            return i >= 0 && s.queue.length > 0 && s.planned * s.days.length < s.total * (i + 1);
        };
        let open = states.filter(behind);
        while (open.length) {
            const stillOpen = [];
            for (const s of open) {
                const session = place(s, day);
                if (session) sessions.push(session);
                if (session && behind(s)) stillOpen.push(s);
            }
            open = stillOpen;
        }
    }

    const shortfall = {};
    for (const s of states) shortfall[s.goal.id] = s.total - s.planned;
    return { sessions, shortfall };
}

module.exports = { plan, chunk, planningDays, freeGaps };
