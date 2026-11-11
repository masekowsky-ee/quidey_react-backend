// The free plan (only in ACCESS_MODE=open with PRO_BILLING=on, for accounts without Pro, tester or
// admin; see utils/access.js): how much of each thing an account can have at a time. Things that are there
// stay (also after Pro ended); only new ones are refused, with 403 LIMIT_REACHED { limit, max }.
const { ACCESS_MODE, PRO_BILLING, hasNoLimits, hasTrial } = require("./access");

const FREE_LIMITS = {
    tasks: 10, // open tasks (not ticked off)
    events: 5, // events still ahead (the server ticks them off once they're over)
    groups: 3,
    sessions: 1, // shared sessions I am in (not ended)
    friends: 3, // friends, counting requests I sent that are still open
    subjects: 3, // Lernen: my own subjects (not archived, not made by Untis)
    goals: 1, // Lernen: active goals per subject (not the exams Untis made)
};
// statistics: only the last 7 days (the week); longer periods need Pro
const FREE_STATS_DAYS = 7;

const COUNTS = {
    // not counted: what the app makes itself, the study planner's sessions and tasks made from Untis homework
    tasks: `SELECT count(*)::int AS n FROM tasks WHERE user_id = $1 AND kind = 'task' AND NOT done AND goal_part_id IS NULL
        AND id NOT IN (SELECT task_id FROM untis_homework_suggestions WHERE user_id = $1 AND task_id IS NOT NULL)`,
    events: "SELECT count(*)::int AS n FROM tasks WHERE user_id = $1 AND kind = 'event' AND NOT done",
    groups: "SELECT count(*)::int AS n FROM groups WHERE user_id = $1",
    subjects: "SELECT count(*)::int AS n FROM subjects WHERE user_id = $1 AND NOT archived AND untis_name IS NULL",
    sessions: `SELECT count(*)::int AS n FROM shared_session_members
        JOIN shared_sessions ON shared_sessions.id = shared_session_members.session_id
        WHERE shared_session_members.user_id = $1 AND shared_session_members.status = 'joined' AND shared_sessions.ended_at IS NULL`,
    friends: `SELECT count(*)::int AS n FROM friendships
        WHERE (status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)) OR (status = 'pending' AND requester_id = $1)`,
};

// Whether this account has the free plan's limits now: on the trial version (whatever the mode), else only after
// the beta with Pro on sale; never with Pro, a tester or an admin
const limited = (account) => !hasNoLimits(account) && (hasTrial(account) || (ACCESS_MODE === "open" && PRO_BILLING));

// active goals of one subject that count (the exams Untis made don't)
const GOALS_SQL = `SELECT count(*)::int AS n FROM goals WHERE user_id = $1 AND subject_id = $2 AND status = 'active'
    AND id NOT IN (SELECT goal_id FROM untis_exams WHERE user_id = $1 AND goal_id IS NOT NULL)`;

// How much of each the account has: { tasks, events, groups, sessions, friends }
async function usage(db, userId) {
    const entries = await Promise.all(Object.entries(COUNTS).map(async ([what, sql]) => [what, (await db.query(sql, [userId])).rows[0].n]));
    return Object.fromEntries(entries);
}

// null when one more `what` is fine, else { limit, max } for the 403 (`goals` is counted per subject: { subjectId })
async function limitReached(db, account, what, { subjectId } = {}) {
    if (!limited(account)) return null;
    const max = FREE_LIMITS[what];
    const { n } = what === "goals" ? (await db.query(GOALS_SQL, [account.id, subjectId])).rows[0] : (await db.query(COUNTS[what], [account.id])).rows[0];
    return n >= max ? { limit: what, max } : null;
}

// Answers the 403 when the limit is reached; true then (the route stops)
async function refuseOverLimit(db, res, account, what, args) {
    const reached = await limitReached(db, account, what, args);
    if (!reached) return false;
    res.status(403).json({ error: `The free plan has room for ${reached.max} ${what}`, code: "LIMIT_REACHED", ...reached });
    return true;
}

module.exports = { FREE_LIMITS, FREE_STATS_DAYS, limited, usage, limitReached, refuseOverLimit };
