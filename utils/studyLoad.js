// Study goals: SQL loaders shared by the study routes. Dates leave the database as strings
// ('YYYY-MM-DD', 'HH:MM'): the status and planner modules need strings, pg would hand out Date objects.
// `db` is a pool or a client.

const { partProgress, goalStatus } = require('./studyStatus');

// The user's settings and "now" in their timezone.
async function getClock(db, userId) {
    const { rows } = await db.query(
        `SELECT to_char(local_now, 'YYYY-MM-DD') AS today,
            (extract(hour FROM local_now) * 60 + extract(minute FROM local_now))::int AS now_minutes,
            study_session_minutes, study_daily_max_minutes, study_ai_auto
        FROM (SELECT *, now() AT TIME ZONE COALESCE(timezone, 'Europe/Berlin') AS local_now FROM users WHERE id = $1) u`,
        [userId]
    );
    const row = rows[0];
    return {
        today: row.today,
        nowMinutes: row.now_minutes,
        sessionMinutes: row.study_session_minutes,
        dailyMaxMinutes: row.study_daily_max_minutes,
        aiAuto: row.study_ai_auto,
    };
}

// Planned sessions of the given parts, in the shape of utils/studyStatus.js (plus dueTime-less date/time).
async function loadSessions(db, userId, partIds) {
    if (partIds.length === 0) return [];
    const { rows } = await db.query(
        `SELECT tasks.id, tasks.goal_part_id, to_char(tasks.due, 'YYYY-MM-DD') AS date,
            to_char(tasks.due_time, 'HH24:MI') AS time, COALESCE(tasks.duration_minutes, 0) AS minutes,
            COALESCE(tasks.done, false) AS done, tasks.plan_pinned,
            COALESCE((SELECT sum(time_ms) FROM session_tasks WHERE session_tasks.task_id = tasks.id), 0)::float8 AS focus_ms
        FROM tasks
        WHERE tasks.user_id = $1 AND tasks.goal_part_id = ANY($2::int[]) AND tasks.due IS NOT NULL
        ORDER BY tasks.due, tasks.due_time NULLS FIRST, tasks.id`,
        [userId, partIds]
    );
    return rows.map((r) => ({
        taskId: r.id, partId: r.goal_part_id, date: r.date, time: r.time,
        minutes: r.minutes, done: r.done, focusMs: r.focus_ms, pinned: r.plan_pinned,
    }));
}

// My goals (all, one by id, or one subject's) with parts and sessions: [{ goal, parts, sessions }].
async function loadGoals(db, userId, { id = null, subjectId = null } = {}) {
    const where = ['user_id = $1'];
    const params = [userId];
    if (id != null) { params.push(id); where.push(`id = $${params.length}`); }
    if (subjectId != null) { params.push(subjectId); where.push(`subject_id = $${params.length}`); }
    const goals = (await db.query(
        `SELECT id, subject_id, kind, name, to_char(due, 'YYYY-MM-DD') AS due, to_char(due_time, 'HH24:MI') AS due_time,
            plan_mode, status, freed_minutes
        FROM goals WHERE ${where.join(' AND ')} ORDER BY due, id`,
        params
    )).rows;
    if (goals.length === 0) return [];
    const parts = (await db.query(
        `SELECT id, goal_id, name, position, estimate_minutes, estimate_source, role, done_at, actual_minutes
        FROM goal_parts WHERE goal_id = ANY($1::int[]) ORDER BY position, id`,
        [goals.map((g) => g.id)]
    )).rows;
    const sessions = await loadSessions(db, userId, parts.map((p) => p.id));
    return goals.map((g) => {
        const own = parts.filter((p) => p.goal_id === g.id);
        const ids = new Set(own.map((p) => p.id));
        return {
            goal: {
                id: g.id, subjectId: g.subject_id, kind: g.kind, name: g.name, due: g.due, dueTime: g.due_time,
                planMode: g.plan_mode, status: g.status, freedMinutes: g.freed_minutes,
            },
            parts: own.map((p) => ({
                id: p.id, name: p.name, position: p.position, estimate: p.estimate_minutes,
                estimateSource: p.estimate_source, role: p.role, doneAt: p.done_at, actualMinutes: p.actual_minutes,
            })),
            sessions: sessions.filter((s) => ids.has(s.partId)),
        };
    });
}

// Credit of a part: what it was finished with, otherwise the sum over its sessions.
function partView(part, sessions) {
    const own = sessions.filter((s) => s.partId === part.id);
    const progress = partProgress(part, own);
    const credit = part.doneAt && part.actualMinutes != null ? part.actualMinutes : progress.credit;
    return {
        id: part.id, name: part.name, position: part.position, estimateMinutes: part.estimate,
        estimateSource: part.estimateSource, role: part.role, doneAt: part.doneAt,
        credit, remaining: progress.remaining,
    };
}

// The shape of GET /goals/:id.
function goalView({ goal, parts, sessions }) {
    return {
        id: goal.id, subjectId: goal.subjectId, kind: goal.kind, name: goal.name, due: goal.due,
        dueTime: goal.dueTime, planMode: goal.planMode, status: goal.status,
        parts: parts.map((p) => partView(p, sessions)),
        sessions: sessions.map((s) => ({
            taskId: s.taskId, partId: s.partId, due: s.date, dueTime: s.time,
            minutes: s.minutes, done: s.done, focusMs: s.focusMs, pinned: s.pinned,
        })),
    };
}

// Share of the estimates covered (0-1) and how far behind the goal is.
function goalProgress({ goal, parts, sessions }, clock) {
    const total = parts.reduce((sum, p) => sum + p.estimate, 0);
    const covered = parts.reduce((sum, p) => sum + (p.estimate - partProgress(p, sessions.filter((s) => s.partId === p.id)).remaining), 0);
    const { behindMinutes } = goalStatus({ goal, parts, sessions, busy: [] }, clock);
    return { progress: total > 0 ? Math.round((covered / total) * 100) / 100 : 0, behindMinutes };
}

module.exports = { getClock, loadSessions, loadGoals, partView, goalView, goalProgress };
