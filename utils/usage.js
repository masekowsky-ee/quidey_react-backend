// Anonymous usage statistics, only for people who agreed (users.usage_consent = 'granted').
//
// countUsage() adds one event to usage_hourly (totals per hour and dimensions, no user id: this is what
// stays) and counts every person once per hour / day / week. To know "once", it keeps short-lived marks
// in usage_seen (user id is there, cascades with the user, withdrawn with the consent, deleted by
// cleanupUsage when the period is over). usage_people holds the distinct people per local day / week.
//
// Periods: hour marks are the UTC hour. Day and week marks (usage_seen.period) are the UTC instant of
// the start of the person's LOCAL day / ISO week (Monday 00:00 local, timestamptz). usage_people.period
// is the same local date (day) / local Monday date (week) as a plain date.
// cleanupUsage deletes marks that ended: hour marks 26 h after the hour starts (the beacon takes events
// up to 24 h late, a mark that went earlier would count the same person twice), day marks 2 days after
// the local day starts, week marks 8 days after the week starts.
//
// The 60 s account cache is only a cheap pre-check: inside the transaction the consent is read again
// (FOR SHARE), so a count racing a withdrawal writes nothing.
//
// Nothing here may break the app: countUsage swallows and logs every error and returns false.
const { hasPro } = require("./access");

const FALLBACK_ZONE = "Europe/Berlin";
const PLATFORMS = new Set(["web", "pwa", "android"]);
const LANGUAGES = new Set(["de", "en"]);

// The only metrics there are (spec § 2). `active` ("any activity") is written by countUsage itself.
const VIEW_AREAS = new Set([
    "home", "calendar", "focus", "stats", "profile", "settings", "inbox", "feedback", "admin", "tester", "fun", "pro", "beta",
    "notes", "study", "user_profile", "session", "family", "routines", "routine_run", "community", "community_progress",
    "community_sessions", "community_friends", "community_family", "other",
]);
const SERVER_METRICS = new Set(["task_created", "task_done", "focus_done"]);
const CLIENT_METRICS = new Set([
    "app_open", "active_minute", "focus_start", "group_created", "friend_request_sent", "friend_added", "shared_session_created",
    "family_created", "routine_run", "note_written", "study_plan_applied", "reminder_created",
    ...[...VIEW_AREAS].map((area) => `view:${area}`),
]);
const METRICS = new Set([...CLIENT_METRICS, ...SERVER_METRICS]);

const isMetric = (name) => typeof name === "string" && METRICS.has(name);

const planOf = (row) => (hasPro(row) ? "pro" : row.is_tester || row.is_admin ? "tester" : "free");

const cleanPlatform = (value) => (PLATFORMS.has(value) ? value : "web");

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();
function formatterFor(timeZone) {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" });
        formatters.set(timeZone, f);
    }
    return f;
}

// The local hour (0-23), ISO weekday (1 = Monday), local day and the Monday of that week
function localParts(date, timeZone) {
    let f;
    try { f = formatterFor(timeZone || FALLBACK_ZONE); } catch { f = formatterFor(FALLBACK_ZONE); }
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    const weekday = WEEKDAYS[p.weekday];
    const day = `${p.year}-${p.month}-${p.day}`;
    const monday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - (weekday - 1)));
    return { localHour: Number(p.hour) % 24, weekday, day, weekStart: monday.toISOString().slice(0, 10) };
}

function validZone(timeZone) {
    try { formatterFor(timeZone); return timeZone; } catch { return FALLBACK_ZONE; }
}

// The account (consent, zone, language, plan) is read at most once a minute per person
const ACCOUNT_TTL_MS = 60_000;
const accounts = new Map();

async function accountOf(db, userId) {
    const hit = accounts.get(userId);
    if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.account;
    const { rows } = await db.query(
        "SELECT usage_consent, timezone, language, is_pro, pro_until, is_tester, is_admin FROM users WHERE id = $1", [userId]);
    const account = rows[0] ?? null;
    accounts.set(userId, { at: Date.now(), account });
    return account;
}

const forgetUsageAccount = (userId) => { accounts.delete(userId); };

async function countUsage(db, userId, metric, { value = 0, platform = "web", at = new Date() } = {}) {
    if (!isMetric(metric)) return false;
    let client;
    try {
        const account = await accountOf(db, userId);
        if (account?.usage_consent !== "granted") return false;

        const zone = account.timezone ? validZone(account.timezone) : FALLBACK_ZONE;
        const { localHour, weekday, day, weekStart } = localParts(at, zone);
        const dims = [cleanPlatform(platform), LANGUAGES.has(account.language) ? account.language : "de", planOf(account)];
        const amount = Math.max(0, Math.round(Number(value) || 0));
        const hour = new Date(Math.floor(at.getTime() / 3600e3) * 3600e3);

        client = await db.connect();
        await client.query("BEGIN");
        // the cache may be up to a minute old: the consent as it is now, held until the commit
        const { rows: current } = await client.query("SELECT usage_consent FROM users WHERE id = $1 FOR SHARE", [userId]);
        if (current[0]?.usage_consent !== "granted") {
            await client.query("ROLLBACK");
            forgetUsageAccount(userId);
            return false;
        }
        // marks: [scope, period, metric]; the period of day / week is local midnight as an instant
        const wanted = [];
        for (const m of [metric, "*"]) {
            wanted.push(["hour", m], ["day", m], ["week", m]);
        }
        const periodSql = (scope, i) => (scope === "hour" ? `$${i}::timestamptz` : `($${i}::date::timestamp AT TIME ZONE $1::text)`);
        const params = [zone, userId];
        const values = wanted.map(([scope, m], k) => {
            const periodValue = scope === "hour" ? hour.toISOString() : scope === "day" ? day : weekStart;
            params.push(scope, periodValue, m);
            const base = 3 + k * 3;
            return `($${base}::text, ${periodSql(scope, base + 1)}, $${base + 2}::text, $2::integer)`;
        });
        const { rows: fresh } = await client.query(
            `INSERT INTO usage_seen (scope, period, metric, user_id) VALUES ${values.join(", ")}
             ON CONFLICT DO NOTHING RETURNING scope, metric`, params);
        const isNew = (scope, m) => fresh.some((r) => r.scope === scope && r.metric === m);

        const hourly = `INSERT INTO usage_hourly (hour, local_hour, weekday, metric, platform, language, plan, events, people, value_sum)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (hour, local_hour, weekday, metric, platform, language, plan)
             DO UPDATE SET events = usage_hourly.events + EXCLUDED.events, people = usage_hourly.people + EXCLUDED.people,
                           value_sum = usage_hourly.value_sum + EXCLUDED.value_sum`;
        const head = [hour.toISOString(), localHour, weekday];
        await client.query(hourly, [...head, metric, ...dims, 1, isNew("hour", metric) ? 1 : 0, amount]);
        if (isNew("hour", "*")) await client.query(hourly, [...head, "active", ...dims, 1, 1, 0]);

        const people = `INSERT INTO usage_people (scope, period, metric, platform, language, plan, people)
             VALUES ($1, $2, $3, $4, $5, $6, 1)
             ON CONFLICT (scope, period, metric, platform, language, plan) DO UPDATE SET people = usage_people.people + 1`;
        for (const [scope, period] of [["day", day], ["week", weekStart]]) {
            if (isNew(scope, metric)) await client.query(people, [scope, period, metric, ...dims]);
            if (isNew(scope, "*")) await client.query(people, [scope, period, "active", ...dims]);
        }
        await client.query("COMMIT");
        return true;
    } catch (err) {
        if (client) {
            await client.query("ROLLBACK").catch(() => {});
            client.release(err); // a connection that failed mid-transaction isn't given back to the pool
            client = null;
        }
        console.error("Counting usage failed:", err.message);
        return false;
    } finally {
        client?.release();
    }
}

// Deletes the marks of periods that are over; returns how many. Totals stay.
async function cleanupUsage(db, now = new Date()) {
    const { rowCount } = await db.query(
        `DELETE FROM usage_seen WHERE
            (scope = 'hour' AND period < $1::timestamptz - interval '26 hours') OR
            (scope = 'day'  AND period < $1::timestamptz - interval '2 days') OR
            (scope = 'week' AND period < $1::timestamptz - interval '8 days')`, [now.toISOString()]);
    return rowCount;
}

// Withdrawing the consent: the person's marks go at once
async function withdrawUsage(db, userId) {
    await db.query("DELETE FROM usage_seen WHERE user_id = $1", [userId]);
    forgetUsageAccount(userId);
}

module.exports = { METRICS, CLIENT_METRICS, SERVER_METRICS, isMetric, planOf, cleanPlatform, localParts, countUsage, forgetUsageAccount, cleanupUsage, withdrawUsage };
