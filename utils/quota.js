// Daily allowances for the AI features (later part of Quidey Pro): how often an account may use each
// on one day of its own time zone (users.timezone). Counted in daily_quota (migration 048).
//
// take(db, userId, kind) books one use, all in one statement, so two requests at once can't both get
// the last one: → { ok, used, max, day, resetsAt }. giveBack(...) returns it when the work failed.
// The app reads what is left from GET /api/ai/quota.

const DAILY = {
    // a document / photos / a note read into a study plan, notes or entries
    scan: Number(process.env.QUOTA_SCAN) || 1,
    // a quick-entry line the rules didn't understand, read by the AI
    ai_line: Number(process.env.QUOTA_AI_LINE) || 5,
};
// the names the app sees
const PUBLIC_NAME = { scan: "scan", ai_line: "aiLine" };

// today in the account's time zone, and when tomorrow starts there (as a timestamp)
const DAY_SQL = `
    SELECT (now() AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin'))::date AS day,
           (((now() AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin'))::date + 1)::timestamp
               AT TIME ZONE COALESCE(users.timezone, 'Europe/Berlin')) AS resets_at
    FROM users WHERE users.id = $1`;

async function take(db, userId, kind) {
    const max = DAILY[kind];
    const { rows } = await db.query(`
        WITH today AS (${DAY_SQL}),
        booked AS (
            INSERT INTO daily_quota (user_id, day, kind, used)
            SELECT $1, today.day, $2, 1 FROM today WHERE $3 > 0
            ON CONFLICT (user_id, day, kind) DO UPDATE SET used = daily_quota.used + 1
                WHERE daily_quota.used < $3
            RETURNING used
        )
        SELECT today.day, today.resets_at, (SELECT used FROM booked) AS used,
               (SELECT used FROM daily_quota WHERE user_id = $1 AND day = today.day AND kind = $2) AS before
        FROM today`, [userId, kind, max]);
    const row = rows[0];
    const ok = row.used != null;
    return { ok, used: ok ? row.used : row.before ?? max, max, day: row.day, resetsAt: row.resets_at };
}

async function giveBack(db, userId, kind, day) {
    await db.query("UPDATE daily_quota SET used = used - 1 WHERE user_id = $1 AND day = $2 AND kind = $3 AND used > 0", [userId, day, kind]);
}

// { scan: { used, max }, aiLine: { used, max }, resetsAt }
async function status(db, userId) {
    const { rows } = await db.query(`
        WITH today AS (${DAY_SQL})
        SELECT today.resets_at, daily_quota.kind, daily_quota.used
        FROM today LEFT JOIN daily_quota ON daily_quota.user_id = $1 AND daily_quota.day = today.day`, [userId]);
    const out = { resetsAt: rows[0]?.resets_at ?? null };
    for (const kind of Object.keys(DAILY)) {
        out[PUBLIC_NAME[kind]] = { used: rows.find(row => row.kind === kind)?.used ?? 0, max: DAILY[kind] };
    }
    return out;
}

// the answer when nothing is left today
function refuse(res, kind, booked) {
    return res.status(429).json({
        error: "Nothing left of this today", code: "QUOTA_REACHED",
        kind: PUBLIC_NAME[kind], max: booked.max, resetsAt: booked.resetsAt,
    });
}

// old days aren't needed (called now and then)
async function forgetOldDays(db) {
    await db.query("DELETE FROM daily_quota WHERE day < (now() - interval '8 days')::date");
}

module.exports = { DAILY, take, giveBack, status, refuse, forgetOldDays };
