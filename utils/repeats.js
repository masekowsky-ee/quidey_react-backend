// Repeat projection: the days on which open repeating tasks come back. A port of repeatDate /
// projectRepeats in the app (src/features/calendar/calendar.js); scripts/test/fixtures/repeats.json
// is run against both so they give the same days. Days are 'YYYY-MM-DD' text, calculated in UTC so
// the server's timezone never shifts them.

const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];
const MAX_PREVIEWS = 400;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// A task's day as text: node-postgres returns a `date` column as a Date at local midnight, so read
// it with local getters (toISOString would shift it by the timezone); text is cut to its day
function dayOf(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return '';
        const pad = (n, width = 2) => String(n).padStart(width, '0');
        return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    return typeof value === 'string' ? value.slice(0, 10) : '';
}

const toKey = (date) => date.toISOString().slice(0, 10);
const fromKey = (key) => new Date(`${key}T00:00:00Z`);

function addDays(key, days) {
    const date = fromKey(key);
    date.setUTCDate(date.getUTCDate() + days);
    return toKey(date);
}

// Same day n months later; the 31st becomes the month's last day instead of spilling over
function addMonths(key, months) {
    const date = fromKey(key);
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    return toKey(target);
}

// The day of the n-th repeat after `start`, n steps from the day itself (the 31st stays the 31st
// where the month has one); null for an unknown rhythm
function repeatDate(start, repeat, n) {
    if (repeat === 'daily') return addDays(start, n);
    if (repeat === 'weekly') return addDays(start, 7 * n);
    if (repeat === 'monthly') return addMonths(start, n);
    if (repeat === 'yearly') return addMonths(start, 12 * n);
    return null;
}

// The coming repeats of open repeating tasks up to and including `until`: copies of the task with
// id `<id>@<day>`, due: the day and repeatStep: how many steps of its rhythm away. A task with an
// end (repeat_left) stops after that many steps; days deleted on their own (repeat_skip) are left
// out but still count as a step. Dates compare as text, which is right for YYYY-MM-DD.
function projectRepeats(tasks, until) {
    if (typeof until !== 'string' || !DAY_KEY.test(until)) throw new Error(`projectRepeats: until must be YYYY-MM-DD, got ${until}`);
    const previews = [];
    for (const task of tasks) {
        const start = dayOf(task.due);
        if (task.done || !REPEATS.includes(task.repeat) || !DAY_KEY.test(start)) continue;
        const skipped = new Set(task.repeat_skip ?? []);
        const steps = Number.isInteger(task.repeat_left) ? Math.min(task.repeat_left, MAX_PREVIEWS) : MAX_PREVIEWS;
        for (let n = 1; n <= steps; n++) {
            const date = repeatDate(start, task.repeat, n);
            if (date > until) break;
            if (skipped.has(date)) continue;
            previews.push({ ...task, id: `${task.id}@${date}`, due: date, repeatStep: n });
        }
    }
    return previews;
}

module.exports = { REPEATS, repeatDate, projectRepeats };
