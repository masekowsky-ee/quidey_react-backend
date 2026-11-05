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
// `due`. In `slots` mode only weekdays that have a window count.
function planningDays(goal, today, nowMinutes, windows) {
    if (!DAY_KEY.test(goal.due || '') || !DAY_KEY.test(today || '')) return [];
    const slots = goal.planMode === 'slots';
    const todayOver = slots
        ? !windowsOn(today, windows).some((w) => w.end > nowMinutes)
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

// A goal's chunks in the order they are handed out: parts by position, each cut into sessions
function goalState(goal, input) {
    const parts = [...goal.parts].sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)));
    const queue = [];
    for (const part of parts) {
        for (const minutes of chunk(part.remaining, input.sessionMinutes)) queue.push({ partId: part.id, minutes });
    }
    const total = queue.reduce((sum, c) => sum + c.minutes, 0);
    const days = planningDays(goal, input.today, input.nowMinutes, input.windows);
    return { goal, queue, total, planned: 0, days, pace: days.length ? total / days.length : Infinity };
}

// Urgency: earliest due, then highest pace, then id
const byUrgency = (a, b) => (a.goal.due < b.goal.due ? -1 : a.goal.due > b.goal.due ? 1 : 0)
    || b.pace - a.pace
    || String(a.goal.id).localeCompare(String(b.goal.id));

// What the day still has room for: minutes under the daily max, and (for `slots`) free gaps
function dayState(date, input) {
    const keptOnDay = input.kept.filter((k) => k.date === date);
    const keptMinutes = keptOnDay.reduce((sum, k) => sum + (Number(k.minutes) || 0), 0);
    let gaps = freeGaps(date, input.windows, input.busy, keptOnDay);
    if (date === input.today) {
        const now = Math.ceil(input.nowMinutes / 5) * 5;
        gaps = cut(gaps, 0, now);
    }
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
    const states = input.goals.map((goal) => goalState(goal, input)).sort(byUrgency);
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
