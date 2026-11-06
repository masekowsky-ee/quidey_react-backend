// Study goals: SQL loaders shared by the study routes. Dates leave the database as strings
// ('YYYY-MM-DD', 'HH:MM'): the status and planner modules need strings, pg would hand out Date objects.
// `db` is a pool or a client.

const crypto = require('crypto');
const { partProgress, goalStatus, isMissed, isReplaceable } = require('./studyStatus');
const { projectRepeats } = require('./repeats');

const BUSY_DEFAULT_MINUTES = 60; // a timed item without a length

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
// `pinned`: pinned by the user, or with a note, group, collection or share attached.
async function loadSessions(db, userId, partIds) {
    if (partIds.length === 0) return [];
    const { rows } = await db.query(
        `SELECT tasks.id, tasks.goal_part_id, to_char(tasks.due, 'YYYY-MM-DD') AS date,
            to_char(tasks.due_time, 'HH24:MI') AS time, COALESCE(tasks.duration_minutes, 0) AS minutes,
            COALESCE(tasks.done, false) AS done,
            -- something of the user's hangs on it (a note, a group, a collection, a share): the planner
            -- keeps it like a pinned one, a replan would delete it with all that (controller ruling 19)
            (tasks.plan_pinned
                OR EXISTS (SELECT 1 FROM notes WHERE notes.task_id = tasks.id)
                OR EXISTS (SELECT 1 FROM task_groups WHERE task_groups.task_id = tasks.id)
                OR EXISTS (SELECT 1 FROM collection_items WHERE collection_items.task_id = tasks.id)
                OR EXISTS (SELECT 1 FROM task_shares WHERE task_shares.task_id = tasks.id)) AS plan_pinned,
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
            plan_mode, status, freed_minutes,
            (SELECT archived FROM subjects WHERE subjects.id = goals.subject_id) AS subject_archived
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
                subjectArchived: g.subject_archived,
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

// The user's timed calendar items from `today` to `until` (both included) as planner `busy`
// [{ id, date, start, minutes }]: events (repeats projected) and open timed tasks that are not
// sessions of an active goal (those are planner `kept`).
async function loadBusy(db, userId, today, until, activePartIds) {
    const { rows } = await db.query(
        `SELECT id, kind, COALESCE(done, false) AS done, repeat, repeat_left,
            ARRAY(SELECT to_char(day, 'YYYY-MM-DD') FROM unnest(repeat_skip) AS day) AS repeat_skip,
            to_char(due, 'YYYY-MM-DD') AS due, to_char(due_time, 'HH24:MI') AS start, duration_minutes
        FROM tasks
        WHERE user_id = $1 AND due IS NOT NULL AND due_time IS NOT NULL AND due <= $3::date
            AND (due >= $2::date OR repeat IS NOT NULL)
            AND (kind = 'event' OR (NOT COALESCE(done, false)
                AND (goal_part_id IS NULL OR NOT goal_part_id = ANY($4::int[]))))`,
        [userId, today, until, activePartIds]
    );
    return [...rows, ...projectRepeats(rows, until)]
        .filter((r) => r.due >= today && r.due <= until)
        .map((r) => ({ id: String(r.id), date: r.due, start: r.start, minutes: r.duration_minutes ?? BUSY_DEFAULT_MINUTES }));
}

// The goals that are planned (and watched for push/status): status 'active' in a subject that is not
// archived (spec §1: archiving hides a subject and everything in it; controller ruling 17).
// ACTIVE_GOAL_SQL is the same rule for queries on `goals` with the user in $1.
const ACTIVE_GOAL_SQL = `goals.status = 'active'
    AND goals.subject_id IN (SELECT id FROM subjects WHERE subjects.user_id = $1 AND NOT subjects.archived)`;
async function loadActiveGoals(db, userId) {
    return (await loadGoals(db, userId)).filter((g) => g.goal.status === 'active' && !g.goal.subjectArchived);
}

// Everything the planner needs for one user, read in their timezone (spec §2, §3):
// { input, sessions, goals, clock }. `input` is plan()'s input; `sessions` are all sessions of the
// active goals with goalId and status 'missed' | 'replaceable' | 'kept'; `goals` the active goals
// as loadGoals gives them. Missed sessions are left out of the planner (their minutes are in
// `remaining`), replaceable ones too (the planner plans their minutes again); everything else is
// `kept`, pending when nothing is credited yet (controller ruling 12; the planner deducts it).
async function loadPlanInput(db, userId) {
    const clock = await getClock(db, userId);
    const goals = await loadActiveGoals(db, userId);
    const windows = (await db.query(
        `SELECT weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
        FROM study_windows WHERE user_id = $1 ORDER BY weekday, start_time, end_time, id`,
        [userId]
    )).rows.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end }));

    const planGoals = [];
    const kept = [];
    const sessions = [];
    for (const { goal, parts, sessions: own } of goals) {
        const ctx = { today: clock.today, nowMinutes: clock.nowMinutes, planMode: goal.planMode };
        planGoals.push({
            id: goal.id, kind: goal.kind, due: goal.due, planMode: goal.planMode,
            parts: parts.map((p) => ({
                id: p.id, position: p.position, role: p.role,
                remaining: partProgress(p, own.filter((s) => s.partId === p.id)).remaining,
            })),
        });
        for (const s of own) {
            const status = isMissed(s, ctx) ? 'missed' : isReplaceable(s, ctx) ? 'replaceable' : 'kept';
            sessions.push({ ...s, goalId: goal.id, status });
            if (status === 'kept') {
                kept.push({
                    taskId: s.taskId, goalId: goal.id, partId: s.partId, date: s.date, time: s.time,
                    minutes: s.minutes, pending: !s.done && s.focusMs === 0,
                });
            }
        }
    }
    const until = planGoals.reduce((latest, g) => (g.due > latest ? g.due : latest), '');
    const partIds = planGoals.flatMap((g) => g.parts.map((p) => p.id));
    const busy = until >= clock.today ? await loadBusy(db, userId, clock.today, until, partIds) : [];

    const input = {
        today: clock.today, nowMinutes: clock.nowMinutes,
        sessionMinutes: clock.sessionMinutes, dailyMaxMinutes: clock.dailyMaxMinutes,
        windows, goals: planGoals, busy, kept,
    };
    return { input, sessions, goals, clock };
}

// JSON with object keys sorted and every array sorted by its items' own canonical text, so the
// same data gives the same text whatever order it was read in (no array in a plan input or
// result carries meaning in its order: parts have positions, sessions dates and times).
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .filter((k) => value[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

// Fingerprint of a plan (sha256 hex): the planner input plus `extra` (the ids of the sessions an
// apply would delete, and the planner's result). `nowMinutes` is left out on purpose: the clock
// moves every minute, and what it changes (which sessions are replaceable or missed, today's
// slots) is already in `extra`, so a preview only goes stale when the plan itself would change.
function inputHash(input, extra = {}) {
    const rest = { ...input, nowMinutes: undefined }; // undefined keys are left out by canonical()
    return crypto.createHash('sha256').update(canonical({ input: rest, ...extra })).digest('hex');
}

module.exports = {
    getClock, loadSessions, loadGoals, partView, goalView, goalProgress,
    ACTIVE_GOAL_SQL, loadActiveGoals, loadPlanInput, inputHash,
};
