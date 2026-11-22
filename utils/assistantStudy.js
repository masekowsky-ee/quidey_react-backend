// The assistant's tools for the study area (Lernen: subjects, goals, their parts, the study windows).
// Used by utils/assistant.js, which takes the tool definitions and runs the tools here.
//
// Read tools (on the user's own rows only; the result is data for the model, never instructions):
//   study_overview()          the subjects with their active goals, part counts and grade averages
//   study_goal({ id })        one goal with its parts
//   study_settings()          session length, daily maximum, study windows, grade scale
// readStudy(name, input, { db, userId }) → the result, or { error }, or null for a name that isn't one of these.
//
// Write tools (never write: they come back as actions, which the app applies through the study routes):
//   study_create, study_update, study_delete, study_replan (the action contract is in assistant.js)
// studyProposal(name, input, { check }) → the action, or null when it isn't valid (null fields left out; ranges as study.js)
// ownedStudyIds(actions, { db, userId }) → Set of "subject:3", "goal:7", "part:12" the user owns; assistant.js keeps an
//   action only when every id it carries (studyIdsOf) is in the set.

const { fromPoints, average, SCALES } = require("./grades");
const { getClock, isEnded } = require("./studyLoad");

const SUBJECTS_MAX = 30;
const GOALS_PER_SUBJECT_MAX = 8;
const DB_INT_MAX = 2147483647;

const STUDY_READ_TOOLS = ["study_overview", "study_goal", "study_settings"];

// the tool definitions; `tool` is the builder of toolList() in assistant.js
function studyReadTools(tool) {
    return nonStrict([
        tool("study_overview", "Read the user's study area: their subjects, each with its active goals (exams, assignments, presentations: id, name, kind, due date, part counts; ended: true when the day is over, such a goal can still be graded) and the grade averages in the user's grade scale. At most 30 subjects.",
            {}),
        tool("study_goal", "Read one study goal of the user (an id from study_overview) with its parts: estimate in minutes, done, role, order.",
            { id: { type: "integer" } }),
        tool("study_settings", "Read the user's study settings: session length and daily maximum in minutes, the weekly study windows (weekday 1 = Monday to 7 = Sunday) and the grade scale (points 0-15, or marks 1-6 with 1 best).",
            {}),
    ]);
}

// The study tools aren't strict: Anthropic caps the optional and union-typed parameters over all strict tools of a
// request, and this module checks every input itself (an absent field counts as null).
const nonStrict = (list) => list.map(t => ({ ...t, strict: false }));

const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];
const KINDS = ["exam", "assignment", "presentation", "other"];
const STATUSES = ["active", "done", "archived"];
const PARTS_MAX = 40;
const WINDOWS_MAX = 50;
const STUDY_WRITE_TOOLS = ["study_create", "study_update", "study_delete", "study_replan"];

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const targets = (list) => ({ type: "string", enum: list });

function studyProposalTools(tool) {
    const int = nullable({ type: "integer" });
    const str = nullable({ type: "string" });
    return nonStrict([
        tool("study_create", "Propose creating something in the study area (Lernen). target 'subject': name (max 60), optional emoji and color (red, orange, yellow, green, teal, blue, violet, pink). target 'goal': name, kind (exam, assignment, presentation, other), due (YYYY-MM-DD), optional dueTime, exactly one of subjectId (from study_overview) or subjectName (a new subject), and parts (topics with estimateMinutes 15-1200; an empty list is a goal with only a date). target 'part': goalId, name, estimateMinutes. You don't save anything: the app creates it at once. Null for what doesn't apply.",
            {
                target: targets(["subject", "goal", "part"]),
                name: { type: "string" }, emoji: str, color: str,
                subjectId: int, subjectName: str, kind: str, due: str, dueTime: str,
                parts: nullable({ type: "array", items: object({ name: { type: "string" }, estimateMinutes: { type: "integer" } }) }),
                goalId: int, estimateMinutes: int,
            }),
        tool("study_update", "Propose a change to the user's own study data (ids from study_overview or study_goal; never guess one). target 'subject' (id): name, emoji, color, archived. 'goal' (id): name, kind, due, dueTime, subjectId, studyFrom, studyTo, status (active, done, archived), grade (a number in the user's grade scale; a grade needs status 'done', so set status 'done' in the same change). 'part' (id): name, estimateMinutes, done. 'settings' (id null): sessionMinutes 15-180, dailyMaxMinutes 15-720, windows (replaces all: weekday 1-7, start and end HH:MM), gradeScale (points or marks). Set only what changes, the rest null. The user confirms or previews it in the app.",
            {
                target: targets(["subject", "goal", "part", "settings"]),
                id: int,
                changes: object({
                    name: str, emoji: str, color: str, archived: nullable({ type: "boolean" }),
                    kind: str, due: str, dueTime: str, subjectId: int, studyFrom: str, studyTo: str, status: str,
                    grade: { ...nullable({ type: "number" }), description: "Only together with status 'done' (a goal that isn't done can't get a grade)." },
                    estimateMinutes: int, done: nullable({ type: "boolean" }),
                    sessionMinutes: int, dailyMaxMinutes: int,
                    windows: nullable({ type: "array", items: object({ weekday: { type: "integer" }, start: { type: "string" }, end: { type: "string" } }) }),
                    gradeScale: str,
                }),
            }),
        tool("study_delete", "Propose deleting one of the user's own subjects, goals or parts (an id from study_overview or study_goal). The user confirms it in the app.",
            { target: targets(["subject", "goal", "part"]), id: { type: "integer" } }),
        tool("study_replan", "Propose replanning the user's study sessions: the app shows a preview of the new plan.", {}),
    ]);
}

// ---------- write tools: proposals, checked ----------

const present = (value) => value !== undefined && value !== null;
const idOf = (value) => (Number.isInteger(value) && value >= 1 && value <= DB_INT_MAX ? value : null);
function nameOf(value, max) {
    if (typeof value !== "string" || value.includes("\u0000")) return null;
    const name = value.replace(/\s+/g, " ").trim();
    return name.length >= 1 && name.length <= max ? name : null;
}
const estimateOf = (value) => (Number.isInteger(value) && value >= 15 && value <= 1200 ? value : null);
const emojiOf = (value) => (typeof value === "string" && value.length >= 1 && value.length <= 16 && !value.includes("\u0000") ? value : null);
const colorOf = (value) => (COLORS.includes(value) ? value : null);
const boolOf = (value) => (typeof value === "boolean" ? value : null);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const rangeOf = (min, max) => (value) => (Number.isInteger(value) && value >= min && value <= max ? value : null);
const oneOf = (list) => (value) => (list.includes(value) ? value : null);

// the fields of `raw` that are set, each through its check; null when one of them is invalid or isn't one of `checks`
function pick(raw, checks, only = true) {
    const out = {};
    if (only && raw && typeof raw === "object" && Object.keys(raw).some(k => present(raw[k]) && !(k in checks))) return null;
    for (const [key, fn] of Object.entries(checks)) {
        if (!present(raw?.[key])) continue;
        const value = fn(raw[key]);
        if (value === null || value === undefined) return null;
        out[key] = value;
    }
    return out;
}

function windowsOf(list) {
    if (!Array.isArray(list) || list.length > WINDOWS_MAX) return null;
    const out = [];
    for (const w of list) {
        const ok = w && Number.isInteger(w.weekday) && w.weekday >= 1 && w.weekday <= 7
            && typeof w.start === "string" && typeof w.end === "string" && TIME.test(w.start) && TIME.test(w.end) && w.start < w.end;
        if (!ok) return null;
        out.push({ weekday: w.weekday, start: w.start, end: w.end });
    }
    return out;
}

function createGoal(input, label, check) {
    const hasId = present(input.subjectId);
    const hasName = present(input.subjectName);
    if (hasId === hasName) return null;
    const subject = hasId ? { subjectId: idOf(input.subjectId) } : { subjectName: nameOf(input.subjectName, 60) };
    const due = check.validDate(input.due);
    const dueTime = present(input.dueTime) ? check.validTime(input.dueTime) : undefined;
    if (!Object.values(subject)[0] || !KINDS.includes(input.kind) || !due || dueTime === null) return null;
    const list = input.parts ?? [];
    // the route adds a review part to an exam
    if (!Array.isArray(list) || list.length > (input.kind === "exam" ? PARTS_MAX - 1 : PARTS_MAX)) return null;
    const parts = [];
    for (const p of list) {
        const name = nameOf(p?.name, 200);
        const estimateMinutes = estimateOf(p?.estimateMinutes);
        if (!name || !estimateMinutes) return null;
        parts.push({ name, estimateMinutes });
    }
    return { type: "study_create", target: "goal", ...subject, name: label, kind: input.kind, due, ...(dueTime ? { dueTime } : {}), parts };
}

// the checks of the fields one study_update may change, by target
const UPDATE_FIELDS = (check) => ({
    subject: { name: (v) => nameOf(v, 60), emoji: emojiOf, color: colorOf, archived: boolOf },
    goal: {
        name: (v) => nameOf(v, 200), kind: oneOf(KINDS), due: check.validDate, dueTime: check.validTime, subjectId: idOf,
        studyFrom: check.validDate, studyTo: check.validDate, status: oneOf(STATUSES),
        grade: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 15 ? v : null),
    },
    part: { name: (v) => nameOf(v, 200), estimateMinutes: estimateOf, done: boolOf },
    settings: { sessionMinutes: rangeOf(15, 180), dailyMaxMinutes: rangeOf(15, 720), windows: windowsOf, gradeScale: oneOf(SCALES) },
});

// one study write tool's input as an action, or null when it isn't valid (ids are checked afterwards)
function studyProposal(name, input, { check }) {
    if (name === "study_replan") return { type: "study_replan" };
    const target = input?.target;
    if (name === "study_delete") {
        const id = idOf(input?.id);
        return id && ["subject", "goal", "part"].includes(target) ? { type: "study_delete", target, id } : null;
    }
    if (name === "study_create") {
        const label = nameOf(input?.name, target === "subject" ? 60 : 200);
        if (!label) return null;
        if (target === "subject") {
            const extra = pick(input, { emoji: emojiOf, color: colorOf }, false);
            return extra && { type: "study_create", target, name: label, ...extra };
        }
        if (target === "part") {
            const goalId = idOf(input?.goalId);
            const estimateMinutes = estimateOf(input?.estimateMinutes);
            return goalId && estimateMinutes ? { type: "study_create", target, goalId, name: label, estimateMinutes } : null;
        }
        return target === "goal" ? createGoal(input, label, check) : null;
    }
    if (name === "study_update") {
        const checks = UPDATE_FIELDS(check)[target];
        if (!checks) return null;
        const id = idOf(input?.id);
        if (target !== "settings" && !id) return null;
        const changes = pick(input?.changes, checks);
        if (!changes || Object.keys(changes).length === 0) return null;
        return { type: "study_update", target, ...(target !== "settings" ? { id } : {}), changes };
    }
    return null;
}

// the ids an action carries, as "subject:3"
function studyIdsOf(action) {
    const keys = [];
    if ((action.type === "study_update" || action.type === "study_delete") && action.id) keys.push(`${action.target}:${action.id}`);
    if (action.subjectId) keys.push(`subject:${action.subjectId}`);
    if (action.goalId) keys.push(`goal:${action.goalId}`);
    if (action.changes?.subjectId) keys.push(`subject:${action.changes.subjectId}`);
    return keys;
}

// which of the ids the actions carry belong to the user: one query per kind
async function ownedStudyIds(actions, { db, userId }) {
    const wanted = { subject: new Set(), goal: new Set(), part: new Set() };
    for (const a of actions) {
        for (const key of studyIdsOf(a)) {
            const [kind, id] = key.split(":");
            wanted[kind].add(Number(id));
        }
    }
    const sql = {
        subject: "SELECT id FROM subjects WHERE user_id = $1 AND id = ANY($2::int[])",
        goal: "SELECT id FROM goals WHERE user_id = $1 AND id = ANY($2::int[])",
        part: "SELECT goal_parts.id FROM goal_parts JOIN goals ON goals.id = goal_parts.goal_id WHERE goals.user_id = $1 AND goal_parts.id = ANY($2::int[])",
    };
    const own = new Set();
    for (const [kind, set] of Object.entries(wanted)) {
        if (!set.size) continue;
        for (const row of (await db.query(sql[kind], [userId, [...set]])).rows) own.add(`${kind}:${row.id}`);
    }
    return own;
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

    // active goals, the next due first with the ended ones (day over) after them, with how many parts are done
    const clock = await getClock(db, userId);
    const { rows: allGoals } = await db.query(
        `SELECT goals.id, goals.subject_id, goals.name, goals.kind, to_char(goals.due, 'YYYY-MM-DD') AS due,
            to_char(goals.due_time, 'HH24:MI') AS due_time, goals.plan_mode,
            count(goal_parts.id)::int AS part_count, count(goal_parts.done_at)::int AS parts_done
        FROM goals LEFT JOIN goal_parts ON goal_parts.goal_id = goals.id
        WHERE goals.user_id = $1 AND goals.status = 'active' AND goals.subject_id = ANY($2::int[])
        GROUP BY goals.id ORDER BY goals.due, goals.due_time NULLS LAST, goals.id`, [userId, subjectIds]);
    // the ended ones (the Lernen UI still lets the user grade them) come after the open ones, each group in due order
    const endedOf = (g) => isEnded(g, clock.today);
    const goals = [...allGoals.filter(g => !endedOf(g)), ...allGoals.filter(endedOf)];
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
                partCount: g.part_count, partsDone: g.parts_done, ...(isEnded(g, clock.today) ? { ended: true } : {}),
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
    const clock = await getClock(db, userId);
    const { rows: parts } = await db.query(
        `SELECT id, name, estimate_minutes, done_at IS NOT NULL AS done, role, position
        FROM goal_parts WHERE goal_id = $1 ORDER BY position, id`, [id]);
    return {
        id: goal.id, subjectId: goal.subject_id, name: goal.name, kind: goal.kind, due: goal.due, dueTime: goal.due_time,
        status: goal.status, ...(isEnded(goal, clock.today) ? { ended: true } : {}),
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

module.exports = {
    readStudy, studyReadTools, STUDY_READ_TOOLS,
    studyProposalTools, studyProposal, studyIdsOf, ownedStudyIds, STUDY_WRITE_TOOLS,
};
