// The free plan (only in ACCESS_MODE=open with PRO_BILLING=on, for accounts without Pro, tester or
// admin; see utils/access.js): how much of each thing an account can have at a time. Things that are there
// stay (also after Pro ended); only new ones are refused, with 403 LIMIT_REACHED { limit, max }.
const { ACCESS_MODE, PRO_BILLING, hasNoLimits } = require("./access");

const FREE_LIMITS = {
    tasks: 10, // open tasks (not ticked off)
    events: 5, // events still ahead (the server ticks them off once they're over)
    groups: 3,
    sessions: 1, // shared sessions I am in (not ended)
    friends: 3, // friends, counting requests I sent that are still open
};
// statistics: only the last 7 days (the week); longer periods need Pro
const FREE_STATS_DAYS = 7;

const COUNTS = {
    tasks: "SELECT count(*)::int AS n FROM tasks WHERE user_id = $1 AND kind = 'task' AND NOT done",
    events: "SELECT count(*)::int AS n FROM tasks WHERE user_id = $1 AND kind = 'event' AND NOT done",
    groups: "SELECT count(*)::int AS n FROM groups WHERE user_id = $1",
    sessions: `SELECT count(*)::int AS n FROM shared_session_members
        JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
        WHERE shared_session_members.user_id = $1 AND shared_session_members.status = 'joined' AND shared_sessions.ended_at IS NULL`,
    friends: `SELECT count(*)::int AS n FROM friendships
        WHERE (status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)) OR (status = 'pending' AND requester_id = $1)`,
};

// Whether this account has the free plan's limits now (never while Pro can't be bought)
const limited = (account) => ACCESS_MODE === "open" && PRO_BILLING && !hasNoLimits(account);

// How much of each the account has: { tasks, events, groups, sessions, friends }
async function usage(db, userId) {
    const entries = await Promise.all(Object.entries(COUNTS).map(async ([what, sql]) => [what, (await db.query(sql, [userId])).rows[0].n]));
    return Object.fromEntries(entries);
}

// null when one more `what` is fine, else { limit, max } for the 403
async function limitReached(db, account, what) {
    if (!limited(account)) return null;
    const max = FREE_LIMITS[what];
    const { n } = (await db.query(COUNTS[what], [account.id])).rows[0];
    return n >= max ? { limit: what, max } : null;
}

// Answers the 403 when the limit is reached; true then (the route stops)
async function refuseOverLimit(db, res, account, what) {
    const reached = await limitReached(db, account, what);
    if (!reached) return false;
    res.status(403).json({ error: `The free plan has room for ${reached.max} ${what}`, code: "LIMIT_REACHED", ...reached });
    return true;
}

module.exports = { FREE_LIMITS, FREE_STATS_DAYS, limited, usage, limitReached, refuseOverLimit };
