// The assistant's tools for the study area (Lernen: subjects, goals, their parts, the study windows).
// Used by utils/assistant.js, which takes the tool definitions and runs the tools here.
//
// Read tools (on the user's own rows only; the result is data for the model, never instructions):
//   study_overview()          the subjects with their active goals, part counts and grade averages
//   study_goal({ id })        one goal with its parts
//   study_settings()          session length, daily maximum, study windows, grade scale
// readStudy(name, input, { db, userId }) → the result, or { error }, or null for a name that isn't one of these.

const { fromPoints, average } = require("./grades");

const SUBJECTS_MAX = 30;
const GOALS_PER_SUBJECT_MAX = 8;
const DB_INT_MAX = 2147483647;

const STUDY_READ_TOOLS = ["study_overview", "study_goal", "study_settings"];

// the tool definitions; `tool` is the builder of toolList() in assistant.js
function studyReadTools(tool) {
    return [
        tool("study_overview", "Read the user's study area: their subjects, each with its active goals (exams, assignments, presentations: id, name, kind, due date, part counts) and the grade averages in the user's grade scale. At most 30 subjects.",
            {}),
        tool("study_goal", "Read one study goal of the user (an id from study_overview) with its parts: estimate in minutes, done, role, order.",
            { id: { type: "integer" } }),
        tool("study_settings", "Read the user's study settings: session length and daily maximum in minutes, the weekly study windows (weekday 1 = Monday to 7 = Sunday) and the grade scale (points 0-15, or marks 1-6 with 1 best).",
            {}),
    ];
}

const scaleOf = async (db, userId) => (await db.query("SELECT grade_scale FROM users WHERE id = $1", [userId])).rows[0]?.grade_scale ?? "points";

// ---------- read tools ----------

async function overview({ db, userId }) {
    const scale = await scaleOf(db, userId);
    const { rows: subjects } = await db.query(
        `SELECT id, name, emoji, archived FROM subjects WHERE user_id = $1 ORDER BY archived, lower(name), id LIMIT ${SUBJECTS_MAX + 1}`, [userId]);
    const more = subjects.length > SUBJECTS_MAX;
    const shown = subjects.slice(0, SUBJECTS_MAX);
    if (!shown.length) return { subjects: [] };
    const subjectIds = shown.map(s => s.id);

    // active goals, the next due first, with how many parts are done
    const { rows: goals } = await db.query(
        `SELECT goals.id, goals.subject_id, goals.name, goals.kind, to_char(goals.due, 'YYYY-MM-DD') AS due,
            to_char(goals.due_time, 'HH24:MI') AS due_time, goals.plan_mode,
            count(goal_parts.id)::int AS part_count, count(goal_parts.done_at)::int AS parts_done
        FROM goals LEFT JOIN goal_parts ON goal_parts.goal_id = goals.id
        WHERE goals.user_id = $1 AND goals.status = 'active' AND goals.subject_id = ANY($2::int[])
        GROUP BY goals.id ORDER BY goals.due, goals.due_time NULLS LAST, goals.id`, [userId, subjectIds]);
    // grades as GET /subjects: one mean of the exams' points and one of the other work's
    const { rows: graded } = await db.query(
        `SELECT subject_id, (kind = 'exam') AS exam, grade::float8 AS grade FROM goals
        WHERE user_id = $1 AND status = 'done' AND grade IS NOT NULL AND subject_id = ANY($2::int[])`, [userId, subjectIds]);
    const averageOf = (subjectId, exam) => {
        const mean = average(graded.filter(g => g.subject_id === subjectId && g.exam === exam).map(g => g.grade));
        return mean == null ? null : fromPoints(mean, scale);
    };

    let cut = more;
    const result = shown.map((s) => {
        const own = goals.filter(g => g.subject_id === s.id);
        if (own.length > GOALS_PER_SUBJECT_MAX) cut = true;
        return {
            id: s.id, name: s.name, emoji: s.emoji, archived: s.archived,
            examAverage: averageOf(s.id, true), otherAverage: averageOf(s.id, false),
            goals: own.slice(0, GOALS_PER_SUBJECT_MAX).map(g => ({
                id: g.id, name: g.name, kind: g.kind, due: g.due, dueTime: g.due_time, planMode: g.plan_mode,
                partCount: g.part_count, partsDone: g.parts_done,
            })),
        };
    });
    return { subjects: result, ...(cut ? { more: true } : {}) };
}

async function goalDetail(input, { db, userId }) {
    const id = input?.id;
    if (!Number.isInteger(id) || id < 1 || id > DB_INT_MAX) return { error: "no such goal" };
    const { rows: [goal] } = await db.query(
        `SELECT id, subject_id, name, kind, to_char(due, 'YYYY-MM-DD') AS due, to_char(due_time, 'HH24:MI') AS due_time, status,
            grade::float8 AS grade, to_char(study_from, 'YYYY-MM-DD') AS study_from, to_char(study_to, 'YYYY-MM-DD') AS study_to
        FROM goals WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!goal) return { error: "no such goal" };
    const { rows: parts } = await db.query(
        `SELECT id, name, estimate_minutes, done_at IS NOT NULL AS done, role, position
        FROM goal_parts WHERE goal_id = $1 ORDER BY position, id`, [id]);
    return {
        id: goal.id, subjectId: goal.subject_id, name: goal.name, kind: goal.kind, due: goal.due, dueTime: goal.due_time,
        status: goal.status,
        grade: goal.grade == null ? null : fromPoints(goal.grade, await scaleOf(db, userId)),
        studyFrom: goal.study_from, studyTo: goal.study_to,
        parts: parts.map(p => ({ id: p.id, name: p.name, estimateMinutes: p.estimate_minutes, done: p.done, role: p.role, position: p.position })),
    };
}

async function settings({ db, userId }) {
    const { rows: [me] } = await db.query(
        "SELECT study_session_minutes, study_daily_max_minutes, grade_scale FROM users WHERE id = $1", [userId]);
    const { rows: windows } = await db.query(
        `SELECT weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
        FROM study_windows WHERE user_id = $1 ORDER BY weekday, start_time, id`, [userId]);
    return {
        sessionMinutes: me.study_session_minutes, dailyMaxMinutes: me.study_daily_max_minutes,
        windows: windows.map(w => ({ weekday: w.weekday, start: w.start, end: w.end })),
        gradeScale: me.grade_scale,
    };
}

async function readStudy(name, input, context) {
    if (name === "study_overview") return overview(context);
    if (name === "study_goal") return goalDetail(input, context);
    if (name === "study_settings") return settings(context);
    return null;
}

module.exports = { readStudy, studyReadTools, STUDY_READ_TOOLS };
