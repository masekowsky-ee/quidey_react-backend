// Admin usage report (spec § 5): reads the totals in usage_hourly / usage_people, never a person.
//
// Dates (from / to) are calendar dates in Europe/Berlin. Hourly rows are cut at Berlin midnights
// (hour >= from 00:00 and < to + 1 day 00:00); the daily numbers from usage_hourly (tasks, focus,
// active minutes) are grouped by the Berlin day of the hour. usage_people day rows use the person's
// own local day (`period`). "people" per platform / language / plan is counted under the dimensions of
// a person's first event in that hour / day / week: sums over a split are exact, per-split distinctness
// is approximate.
const { localParts } = require("./usage");

const ZONE = "Europe/Berlin";
const DAY_MS = 86400e3;
const MAX_DAYS = 366 * 5;
const HEATMAP_METRICS = ["active", "task_done", "focus_start"];
const round1 = (n) => Math.round(n * 10) / 10;

const parseDay = (s) => {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : t;
};
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const mondayOf = (ms) => dayOf(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
const todayBerlin = () => localParts(new Date(), ZONE).day;

// -> { from, to } or { error }
function resolveRange(fromIn, toIn) {
    const to = toIn === undefined || toIn === "" ? todayBerlin() : toIn;
    const toMs = parseDay(to);
    const from = fromIn === undefined || fromIn === "" ? (toMs === null ? null : dayOf(toMs - 29 * DAY_MS)) : fromIn;
    const fromMs = parseDay(from);
    if (fromMs === null || toMs === null) return { error: "Dates must be YYYY-MM-DD" };
    if (fromMs > toMs) return { error: "from must not be after to" };
    if ((toMs - fromMs) / DAY_MS + 1 > MAX_DAYS) return { error: "The range is at most 5 years" };
    return { from, to, fromMs, toMs };
}

// $1 from, $2 to (dates), $3 platform, $4 language, $5 plan; null = no filter
const HOURLY_WHERE = `hour >= ($1::date::timestamp AT TIME ZONE '${ZONE}')
    AND hour < (($2::date + 1)::timestamp AT TIME ZONE '${ZONE}')
    AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR language = $4) AND ($5::text IS NULL OR plan = $5)`;
const PEOPLE_WHERE = `period BETWEEN $1::date AND $2::date
    AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR language = $4) AND ($5::text IS NULL OR plan = $5)`;
const BERLIN_DAY = `to_char(hour AT TIME ZONE '${ZONE}', 'YYYY-MM-DD')`;

const args = (p) => [p.from, p.to, p.platform ?? null, p.language ?? null, p.plan ?? null];

async function usageReport(db, p) {
    const a = args(p);
    const fromMs = parseDay(p.from), toMs = parseDay(p.to);
    const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
    const dates = Array.from({ length: days }, (_, i) => dayOf(fromMs + i * DAY_MS));
    const today = todayBerlin();
    const thisMonday = mondayOf(parseDay(today));
    const weekFrom = mondayOf(fromMs);
    const filters = [p.platform ?? null, p.language ?? null, p.plan ?? null];

    const [heat, peopleDaily, hourlyDaily, weeks, now, featPeople, featEvents, splitPeople, splitEvents, consent] = await Promise.all([
        db.query(`SELECT metric, weekday, local_hour, sum(people)::int AS people, sum(events)::int AS events FROM usage_hourly
            WHERE ${HOURLY_WHERE} AND metric = ANY($6::text[]) GROUP BY metric, weekday, local_hour ORDER BY metric, weekday, local_hour`,
            [...a, HEATMAP_METRICS]),
        db.query(`SELECT to_char(period, 'YYYY-MM-DD') AS day, metric, sum(people)::int AS people FROM usage_people
            WHERE scope = 'day' AND ${PEOPLE_WHERE} GROUP BY day, metric`, a),
        db.query(`SELECT ${BERLIN_DAY} AS day, metric, sum(events)::int AS events, sum(value_sum)::bigint AS value_sum FROM usage_hourly
            WHERE ${HOURLY_WHERE} AND metric IN ('task_created', 'task_done', 'focus_done', 'active_minute') GROUP BY day, metric`, a),
        db.query(`SELECT to_char(period, 'YYYY-MM-DD') AS day, sum(people)::int AS people FROM usage_people
            WHERE scope = 'week' AND metric = 'active' AND $1::date IS NOT NULL AND period BETWEEN $6::date AND $2::date
            AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR language = $4) AND ($5::text IS NULL OR plan = $5)
            GROUP BY day`, [...a, weekFrom]),
        db.query(`SELECT
            (SELECT coalesce(sum(people), 0)::int FROM usage_people WHERE scope = 'day' AND metric = 'active' AND period = $1::date
                AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR language = $4) AND ($5::text IS NULL OR plan = $5)) AS today,
            (SELECT coalesce(sum(people), 0)::int FROM usage_people WHERE scope = 'week' AND metric = 'active' AND period = $2::date
                AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR language = $4) AND ($5::text IS NULL OR plan = $5)) AS week`,
            [today, thisMonday, ...filters]),
        db.query(`SELECT to_char(period, 'YYYY-MM-DD') AS day, metric, sum(people)::int AS people FROM usage_people
            WHERE scope = 'day' AND metric <> 'active' AND ${PEOPLE_WHERE} GROUP BY day, metric`, a),
        db.query(`SELECT metric, sum(events)::int AS events FROM usage_hourly WHERE ${HOURLY_WHERE} AND metric <> 'active' GROUP BY metric`, a),
        db.query(`SELECT platform, language, plan, sum(people)::int AS people FROM usage_people
            WHERE scope = 'day' AND metric = 'active' AND ${PEOPLE_WHERE} GROUP BY platform, language, plan`, a),
        db.query(`SELECT platform, language, plan, sum(events)::int AS events FROM usage_hourly
            WHERE ${HOURLY_WHERE} AND metric <> 'active' GROUP BY platform, language, plan`, a),
        db.query(`SELECT count(*) FILTER (WHERE usage_consent = 'granted')::int AS granted,
            count(*) FILTER (WHERE usage_consent = 'denied')::int AS denied,
            count(*) FILTER (WHERE usage_consent IS NULL)::int AS not_asked FROM users`),
    ]);

    // daily
    const peopleBy = (metric) => {
        const m = new Map();
        for (const r of peopleDaily.rows) if (r.metric === metric) m.set(r.day, r.people);
        return m;
    };
    const activeBy = peopleBy("active");
    const hourlyBy = (metric, field) => {
        const m = new Map();
        for (const r of hourlyDaily.rows) if (r.metric === metric) m.set(r.day, Number(r[field]));
        return m;
    };
    const created = hourlyBy("task_created", "events"), done = hourlyBy("task_done", "events");
    const focusSec = hourlyBy("focus_done", "value_sum"), minutes = hourlyBy("active_minute", "value_sum");
    const daily = dates.map((date) => {
        const active = activeBy.get(date) ?? 0;
        return {
            date, active,
            tasksCreated: created.get(date) ?? 0,
            tasksDone: done.get(date) ?? 0,
            focusMinutes: round1((focusSec.get(date) ?? 0) / 60),
            activeMinutesPerPerson: active > 0 ? round1((minutes.get(date) ?? 0) / active) : 0,
        };
    });

    // weekly: every ISO week that touches the range
    const weekBy = new Map(weeks.rows.map((r) => [r.day, r.people]));
    const weekly = [];
    for (let ms = parseDay(weekFrom); ms <= toMs; ms += 7 * DAY_MS) weekly.push({ weekStart: dayOf(ms), active: weekBy.get(dayOf(ms)) ?? 0 });

    // summary
    const totalActive = daily.reduce((s, d) => s + d.active, 0);
    let busiest = null;
    for (const d of daily) if (d.active > 0 && (!busiest || d.active > busiest.people)) busiest = { date: d.date, people: d.active };
    let focusSecondsTotal = 0;
    for (const v of focusSec.values()) focusSecondsTotal += v;

    // heatmap
    const heatmap = Object.fromEntries(HEATMAP_METRICS.map((m) => [m, []]));
    for (const r of heat.rows) heatmap[r.metric].push({ weekday: r.weekday, hour: r.local_hour, people: r.people, events: r.events });

    // features
    const sparkDates = dates.slice(-14);
    const pad = 14 - sparkDates.length;
    const personDays = new Map(), perDay = new Map();
    for (const r of featPeople.rows) {
        personDays.set(r.metric, (personDays.get(r.metric) ?? 0) + r.people);
        if (!perDay.has(r.metric)) perDay.set(r.metric, new Map());
        perDay.get(r.metric).set(r.day, r.people);
    }
    const eventsBy = new Map(featEvents.rows.map((r) => [r.metric, r.events]));
    const features = [...new Set([...personDays.keys(), ...eventsBy.keys()])].map((metric) => {
        const pd = personDays.get(metric) ?? 0, events = eventsBy.get(metric) ?? 0;
        const series = perDay.get(metric);
        return {
            metric, personDays: pd, events, perPersonDay: pd > 0 ? round1(events / pd) : 0,
            spark: [...Array(pad).fill(0), ...sparkDates.map((d) => series?.get(d) ?? 0)],
        };
    }).sort((x, y) => y.personDays - x.personDays || y.events - x.events || x.metric.localeCompare(y.metric));

    // splits
    const splits = {};
    for (const dim of ["platform", "language", "plan"]) {
        const m = new Map();
        for (const r of splitPeople.rows) m.set(r[dim], { key: r[dim], personDays: (m.get(r[dim])?.personDays ?? 0) + r.people, events: m.get(r[dim])?.events ?? 0 });
        for (const r of splitEvents.rows) {
            const cur = m.get(r[dim]) ?? { key: r[dim], personDays: 0, events: 0 };
            m.set(r[dim], { ...cur, events: cur.events + r.events });
        }
        splits[dim] = [...m.values()].sort((x, y) => y.personDays - x.personDays || x.key.localeCompare(y.key));
    }

    const c = consent.rows[0];
    return {
        range: { from: p.from, to: p.to },
        summary: {
            activeToday: now.rows[0].today,
            avgActivePerDay: round1(totalActive / days),
            busiestDay: busiest,
            activeThisWeek: now.rows[0].week,
            focusHours: round1(focusSecondsTotal / 3600),
            consent: { granted: c.granted, denied: c.denied, notAsked: c.not_asked },
        },
        heatmap, daily, weekly, features, splits,
    };
}

// The usage_hourly rows of the range as they are; null when there are more than `max`
async function usageRaw(db, p, max) {
    const a = args(p);
    const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM usage_hourly WHERE ${HOURLY_WHERE}`, a);
    if (n > max) return null;
    const { rows } = await db.query(
        `SELECT hour, local_hour, weekday, metric, platform, language, plan, events, people, value_sum FROM usage_hourly
         WHERE ${HOURLY_WHERE} ORDER BY hour, metric, platform, language, plan`, a);
    return rows.map((r) => ({
        hour: r.hour.toISOString(), localHour: r.local_hour, weekday: r.weekday, metric: r.metric, platform: r.platform,
        language: r.language, plan: r.plan, events: r.events, people: r.people, valueSum: Number(r.value_sum),
    }));
}

module.exports = { resolveRange, usageReport, usageRaw };
