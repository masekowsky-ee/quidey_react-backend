// The assistant's read tools for the study area (utils/assistantStudy.js, used by utils/assistant.js).
// Same harness as assistant.test.mjs: a scripted fake model (utils/ai.js useTestClient) and the router
// mounted in-process on a throwaway database built from schema.sql (connection from .env).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, "..", "..", ".env"), quiet: true });
const require = createRequire(import.meta.url);
const express = require("express");
const aiUtil = require("../../utils/ai.js");
const aiRouter = require("../../ai.js");

const NO_DB = !process.env.DB_USER && "no database configured (DB_* in .env)";
const dbName = `quidey_assistant_study_${process.pid}`;
const conn = (database) => ({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
});

let admin, pool, server, API;
const users = {};
const ids = {};

// ---------- the scripted model ----------
let calls = [];
let script = () => { throw new Error("no script"); };
let toolId = 0;
const usage = (i, o) => ({ input_tokens: i, output_tokens: o });
const toolTurn = (...uses) => ({
    stop_reason: "tool_use",
    content: [
        { type: "thinking", thinking: "", signature: "sig-" + toolId },
        ...uses.map(([name, input]) => ({ type: "tool_use", id: `toolu_${++toolId}`, name, input })),
    ],
    usage: usage(100, 20),
});
const textTurn = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: usage(50, 10) });
const turns = (...list) => (params, n) => {
    const turn = list[Math.min(n, list.length) - 1];
    return typeof turn === "function" ? turn(params) : structuredClone(turn);
};

async function call(method, path, body, who) {
    const res = await fetch(API + path, {
        method,
        headers: { "Content-Type": "application/json", ...(who ? { "x-user": String(who.id) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
}
const ask = (who, text) => call("POST", "/api/ai/assistant", { messages: [{ role: "user", content: text }], language: "en" }, who);
// the tool results the model got in its last call
const lastResults = () => calls.at(-1).messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter(b => b.type === "tool_result");
// runs one tool through the loop; the model then answers with text
async function useTool(who, name, input) {
    calls = [];
    script = turns(toolTurn([name, input]), textTurn("ok"));
    const r = await ask(who, "study?");
    assert.equal(r.status, 200);
    const [result] = lastResults();
    return { ...result, data: result.is_error ? result.content : JSON.parse(result.content) };
}

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

before(async () => {
    if (NO_DB) return;
    admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool(conn(dbName));
    await pool.query(readFileSync(join(here, "..", "..", "schema.sql"), "utf8"));
    await pool.query("SET search_path = public");

    const add = async (name, scale) => {
        const { rows: [u] } = await pool.query(
            `INSERT INTO users (username, password_hash, email, is_pro, is_max, timezone, grade_scale)
            VALUES ($1, 'x', $1 || '@example.com', true, true, 'Europe/Berlin', $2) RETURNING id`, [name, scale]);
        users[name] = { id: u.id };
    };
    await add("maxi", "points");
    await add("otto", "points");
    await add("mara", "marks");
    await add("many", "points");

    const subject = async (key, owner, name, emoji) => {
        const { rows: [s] } = await pool.query("INSERT INTO subjects (user_id, name, emoji) VALUES ($1, $2, $3) RETURNING id", [owner.id, name, emoji ?? null]);
        ids[key] = s.id;
    };
    const goal = async (key, owner, subjectKey, kind, name, extra = {}) => {
        const { rows: [g] } = await pool.query(
            `INSERT INTO goals (user_id, subject_id, kind, name, due, status, grade) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [owner.id, ids[subjectKey], kind, name, extra.due ?? day(10), extra.status ?? "active", extra.grade ?? null]);
        ids[key] = g.id;
    };
    const part = async (key, goalKey, name, position, done, role = "part") => {
        const { rows: [p] } = await pool.query(
            `INSERT INTO goal_parts (goal_id, name, position, estimate_minutes, role, done_at) VALUES ($1, $2, $3, 45, $4, $5) RETURNING id`,
            [ids[goalKey], name, position, role, done ? new Date() : null]);
        ids[key] = p.id;
    };

    await subject("math", users.maxi, "Mathe", "M");
    await goal("exam", users.maxi, "math", "exam", "Klausur Analysis");
    await part("p1", "exam", "Ableitungen", 0, true);
    await part("p2", "exam", "Integrale", 1, false);
    await part("p3", "exam", "Wiederholung", 2, false, "review");
    await goal("oldExam", users.maxi, "math", "exam", "Test 1", { status: "done", grade: 12 });
    await goal("oldExam2", users.maxi, "math", "exam", "Test 2", { status: "done", grade: 10 });
    await goal("oldHw", users.maxi, "math", "assignment", "Blatt 3", { status: "done", grade: 6 });
    await goal("archivedGoal", users.maxi, "math", "other", "Alt", { status: "archived" });
    await goal("endedGoal", users.maxi, "math", "assignment", "Gestern faellig", { due: day(-1) });

    await subject("secret", users.otto, "Ottos Geheimfach");
    await goal("ottoGoal", users.otto, "secret", "exam", "Ottos Klausur");
    await part("ottoPart", "ottoGoal", "Ottos Teil", 0, false);

    await subject("bio", users.mara, "Bio");
    await goal("marksGoal", users.mara, "bio", "exam", "Bio-Test", { status: "done", grade: 12 });

    for (let i = 0; i < 40; i++) await subject(`many${i}`, users.many, `Fach ${String(i).padStart(2, "0")}`);
    for (let i = 0; i < 10; i++) await goal(`manyGoal${i}`, users.many, "many0", "assignment", `Aufgabe ${i}`, { due: day(i + 1) });

    await pool.query("UPDATE users SET study_session_minutes = 60, study_daily_max_minutes = 240 WHERE id = $1", [users.maxi.id]);
    await pool.query("INSERT INTO study_windows (user_id, weekday, start_time, end_time) VALUES ($1, 3, '16:00', '18:00'), ($1, 1, '09:30', '11:00')", [users.maxi.id]);

    aiUtil.useTestClient({ messages: { create: async (params) => {
        calls.push(structuredClone(params));
        return script(params, calls.length);
    } } });

    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use(async (req, res, next) => {
        const id = Number(req.get("x-user"));
        if (!id) return res.status(401).end();
        const { rows: [account] } = await pool.query("SELECT id, is_pro, pro_until, is_max, max_until, is_tester, is_admin, trial_at FROM users WHERE id = $1", [id]);
        req.user = { userId: id };
        req.account = account;
        next();
    });
    app.use("/api/ai", aiRouter({ pool }));
    app.use((err, req, res, next) => { res.status(500).json({ error: String(err?.message) }); });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    API = `http://localhost:${server.address().port}`;
});

after(async () => {
    aiUtil.useTestClient?.(null);
    server?.close();
    await pool?.end().catch(() => {});
    if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
        await admin.end().catch(() => {});
    }
});

beforeEach(async () => {
    if (NO_DB) return;
    calls = [];
    script = () => { throw new Error("no script"); };
    await pool.query("DELETE FROM daily_quota");
    await pool.query("DELETE FROM assistant_usage");
});

test("study_overview: the user's subjects with active goals, part counts and averages; not another user's", { skip: NO_DB }, async () => {
    const r = await useTool(users.maxi, "study_overview", {});
    assert.equal(r.is_error, undefined);
    assert.equal(r.data.subjects.length, 1);
    const [math] = r.data.subjects;
    assert.equal(math.id, ids.math);
    assert.equal(math.name, "Mathe");
    assert.equal(math.emoji, "M");
    assert.equal(math.archived, false);
    assert.equal(math.examAverage, 11);   // points scale: (12 + 10) / 2
    assert.equal(math.otherAverage, 6);
    assert.equal(math.goals.length, 1);   // done, archived and ended (due yesterday) goals are left out
    assert.deepEqual(math.goals[0], {
        id: ids.exam, name: "Klausur Analysis", kind: "exam", due: day(10), dueTime: null, planMode: "slots", partCount: 3, partsDone: 1,
    });
    assert.equal(r.data.more, undefined);
    assert.ok(!JSON.stringify(r.data).includes("Ottos"));
});

test("study_overview: averages in the user's grade scale, null without grades", { skip: NO_DB }, async () => {
    const r = await useTool(users.mara, "study_overview", {});
    assert.equal(r.data.subjects[0].examAverage, 1.7);  // 12 points = mark 1.7 on the marks scale
    assert.equal(r.data.subjects[0].otherAverage, null);
    const o = await useTool(users.otto, "study_overview", {});
    assert.equal(o.data.subjects[0].examAverage, null);
});

test("study_overview: at most 30 subjects and 8 goals per subject, more: true when cut", { skip: NO_DB }, async () => {
    const r = await useTool(users.many, "study_overview", {});
    assert.equal(r.data.subjects.length, 30);
    assert.equal(r.data.more, true);
    assert.equal(r.data.subjects[0].goals.length, 8);
    assert.equal(r.data.subjects[0].goals[0].name, "Aufgabe 0");  // the next due first
});

test("study_goal: own goal with its parts and done flags", { skip: NO_DB }, async () => {
    const r = await useTool(users.maxi, "study_goal", { id: ids.exam });
    assert.equal(r.is_error, undefined);
    assert.equal(r.data.id, ids.exam);
    assert.equal(r.data.subjectId, ids.math);
    assert.equal(r.data.name, "Klausur Analysis");
    assert.equal(r.data.kind, "exam");
    assert.equal(r.data.status, "active");
    assert.equal(r.data.grade, null);
    assert.deepEqual(r.data.parts.map(p => [p.name, p.done, p.role, p.position, p.estimateMinutes]), [
        ["Ableitungen", true, "part", 0, 45], ["Integrale", false, "part", 1, 45], ["Wiederholung", false, "review", 2, 45],
    ]);
    assert.equal(r.data.parts[0].id, ids.p1);
    const graded = await useTool(users.maxi, "study_goal", { id: ids.oldExam });
    assert.equal(graded.data.grade, 12);
    const marks = await useTool(users.mara, "study_goal", { id: ids.marksGoal });
    assert.equal(marks.data.grade, 1.7);
});

test("study_goal: another user's goal or a missing id is an error result", { skip: NO_DB }, async () => {
    for (const id of [ids.ottoGoal, 999999]) {
        const r = await useTool(users.maxi, "study_goal", { id });
        assert.equal(r.is_error, true);
        assert.equal(r.data, "no such goal");
    }
});

test("study_settings: the stored values", { skip: NO_DB }, async () => {
    const r = await useTool(users.maxi, "study_settings", {});
    assert.deepEqual(r.data, {
        sessionMinutes: 60, dailyMaxMinutes: 240, gradeScale: "points",
        windows: [{ weekday: 1, start: "09:30", end: "11:00" }, { weekday: 3, start: "16:00", end: "18:00" }],
    });
    const d = await useTool(users.mara, "study_settings", {});
    assert.deepEqual(d.data, { sessionMinutes: 45, dailyMaxMinutes: 180, gradeScale: "marks", windows: [] });
});

test("the study tools count as lookups: the fourth in one turn gets an error", { skip: NO_DB }, async () => {
    script = turns(toolTurn(["study_settings", {}], ["study_settings", {}], ["study_overview", {}], ["study_settings", {}]), textTurn("ok"));
    await ask(users.maxi, "x");
    const results = lastResults();
    assert.equal(results.length, 4);
    assert.equal(results[3].is_error, true);
    assert.ok(!results[0].is_error && !results[2].is_error);
});

test("study_overview: an active goal whose day is over is left out and not counted, one due tomorrow stays", { skip: NO_DB }, async () => {
    await pool.query("INSERT INTO goals (user_id, subject_id, kind, name, due) VALUES ($1, $2, 'assignment', 'Morgen faellig', $3)", [users.maxi.id, ids.math, day(1)]);
    try {
        const r = await useTool(users.maxi, "study_overview", {});
        const names = r.data.subjects[0].goals.map(g => g.name);
        assert.deepEqual(names, ["Morgen faellig", "Klausur Analysis"]);
        assert.ok(!names.includes("Gestern faellig"));
    } finally {
        await pool.query("DELETE FROM goals WHERE name = 'Morgen faellig'");
    }
});

// ---------- write tools: proposals ----------

// runs the write tools of one turn; the loop ends with them, the answer is { message, actions }
async function propose(who, ...uses) {
    calls = [];
    script = turns(toolTurn(...uses));
    const r = await ask(who, "change study");
    assert.equal(r.status, 200);
    return r.data;
}
const droppedNote = /couldn't prepare/;

test("study_create goal: own subject and two parts come back as one action, nulls removed", { skip: NO_DB }, async () => {
    const r = await propose(users.maxi, ["study_create", {
        target: "goal", name: " Klausur  Algebra ", emoji: null, color: null, subjectId: ids.math, subjectName: null,
        kind: "exam", due: day(20), dueTime: null, goalId: null, estimateMinutes: null,
        parts: [{ name: "Gruppen", estimateMinutes: 60 }, { name: "Ringe", estimateMinutes: 90 }],
    }]);
    assert.deepEqual(r.actions, [{
        type: "study_create", target: "goal", subjectId: ids.math, name: "Klausur Algebra", kind: "exam", due: day(20),
        parts: [{ name: "Gruppen", estimateMinutes: 60 }, { name: "Ringe", estimateMinutes: 90 }],
    }]);
    assert.ok(!droppedNote.test(r.message));
});

test("study_create goal: no parts is valid, a part without or under 15 minutes drops it", { skip: NO_DB }, async () => {
    const base = { target: "goal", name: "Abgabe", subjectId: ids.math, subjectName: null, kind: "assignment", due: day(5), dueTime: "10:30" };
    const ok = await propose(users.maxi, ["study_create", { ...base, parts: [] }]);
    assert.deepEqual(ok.actions, [{ type: "study_create", target: "goal", subjectId: ids.math, name: "Abgabe", kind: "assignment", due: day(5), dueTime: "10:30", parts: [] }]);
    for (const part of [{ name: "x" }, { name: "x", estimateMinutes: 10 }, { name: "x", estimateMinutes: null }]) {
        const r = await propose(users.maxi, ["study_create", { ...base, parts: [part] }]);
        assert.deepEqual(r.actions, []);
        assert.match(r.message, droppedNote);
    }
});

test("study_create goal: exactly one of subjectId and subjectName", { skip: NO_DB }, async () => {
    const base = { target: "goal", name: "Abgabe", kind: "other", due: day(5), parts: [] };
    for (const both of [{ subjectId: ids.math, subjectName: "Neu" }, { subjectId: null, subjectName: null }]) {
        const r = await propose(users.maxi, ["study_create", { ...base, ...both }]);
        assert.deepEqual(r.actions, []);
    }
    const named = await propose(users.maxi, ["study_create", { ...base, subjectId: null, subjectName: "Physik" }]);
    assert.equal(named.actions[0].subjectName, "Physik");
    assert.equal(named.actions[0].subjectId, undefined);
});

test("study_create goal: another user's subject is dropped; part create needs an own goal", { skip: NO_DB }, async () => {
    const goal = { target: "goal", name: "Abgabe", subjectId: ids.secret, kind: "other", due: day(5), parts: [] };
    const r = await propose(users.maxi, ["study_create", goal]);
    assert.deepEqual(r.actions, []);
    assert.match(r.message, droppedNote);
    const part = { target: "part", name: "Neu", estimateMinutes: 30 };
    assert.deepEqual((await propose(users.maxi, ["study_create", { ...part, goalId: ids.ottoGoal }])).actions, []);
    assert.deepEqual((await propose(users.maxi, ["study_create", { ...part, goalId: ids.exam }])).actions,
        [{ type: "study_create", target: "part", goalId: ids.exam, name: "Neu", estimateMinutes: 30 }]);
});

test("study_create subject: name, emoji and color; a bad color is dropped", { skip: NO_DB }, async () => {
    const r = await propose(users.maxi, ["study_create", { target: "subject", name: "Chemie", emoji: "C", color: "teal" }]);
    assert.deepEqual(r.actions, [{ type: "study_create", target: "subject", name: "Chemie", emoji: "C", color: "teal" }]);
    assert.deepEqual((await propose(users.maxi, ["study_create", { target: "subject", name: "Chemie", color: "#ff0000" }])).actions, []);
    assert.deepEqual((await propose(users.maxi, ["study_create", { target: "subject", name: "x".repeat(61) }])).actions, []);
});

test("study_update part: done for an own part comes back, another user's is dropped with a note", { skip: NO_DB }, async () => {
    const own = await propose(users.maxi, ["study_update", { target: "part", id: ids.p2, changes: { done: true } }]);
    assert.deepEqual(own.actions, [{ type: "study_update", target: "part", id: ids.p2, changes: { done: true } }]);
    const other = await propose(users.maxi, ["study_update", { target: "part", id: ids.ottoPart, changes: { done: true } }]);
    assert.deepEqual(other.actions, []);
    assert.match(other.message, droppedNote);
});

test("a goal id passed with target part is dropped", { skip: NO_DB }, async () => {
    // ids of goals and parts are separate sequences: take the user's goal whose number is no part's
    const { rows: [g] } = await pool.query("SELECT id FROM goals WHERE user_id = $1 AND id NOT IN (SELECT id FROM goal_parts) LIMIT 1", [users.maxi.id]);
    const r = await propose(users.maxi, ["study_update", { target: "part", id: g.id, changes: { done: true } }]);
    assert.deepEqual(r.actions, []);
    const d = await propose(users.maxi, ["study_delete", { target: "part", id: g.id }]);
    assert.deepEqual(d.actions, []);
});

test("study_update goal: changes through the routes' rules, a moved subject must be the user's", { skip: NO_DB }, async () => {
    const full = { name: "Neu", kind: "assignment", due: day(30), dueTime: "08:00", subjectId: ids.math, studyFrom: day(1), studyTo: day(20), status: "done", grade: 12 };
    const r = await propose(users.maxi, ["study_update", { target: "goal", id: ids.exam, changes: full }]);
    assert.deepEqual(r.actions, [{ type: "study_update", target: "goal", id: ids.exam, changes: full }]);
    for (const bad of [{ kind: "party" }, { due: "2026-13-01" }, { status: "gone" }, { grade: 99 }, { dueTime: "25:00" }, { name: "" }]) {
        assert.deepEqual((await propose(users.maxi, ["study_update", { target: "goal", id: ids.exam, changes: bad }])).actions, []);
    }
    assert.deepEqual((await propose(users.maxi, ["study_update", { target: "goal", id: ids.exam, changes: { subjectId: ids.secret } }])).actions, []);
});

test("study_update settings: ranges (sessionMinutes 5 dropped, 60 kept), windows, grade scale", { skip: NO_DB }, async () => {
    const settings = (changes) => propose(users.maxi, ["study_update", { target: "settings", id: null, changes }]);
    assert.deepEqual((await settings({ sessionMinutes: 5 })).actions, []);
    assert.deepEqual((await settings({ sessionMinutes: 60 })).actions, [{ type: "study_update", target: "settings", changes: { sessionMinutes: 60 } }]);
    assert.deepEqual((await settings({ dailyMaxMinutes: 721 })).actions, []);
    assert.deepEqual((await settings({ gradeScale: "letters" })).actions, []);
    const windows = [{ weekday: 2, start: "16:00", end: "18:00" }];
    assert.deepEqual((await settings({ windows, gradeScale: "marks" })).actions[0].changes, { windows, gradeScale: "marks" });
    assert.deepEqual((await settings({ windows: [{ weekday: 2, start: "18:00", end: "16:00" }] })).actions, []);
    assert.deepEqual((await settings({ windows: [{ weekday: 8, start: "16:00", end: "18:00" }] })).actions, []);
});

test("study_delete: an own subject comes back, another user's is dropped", { skip: NO_DB }, async () => {
    const own = await propose(users.maxi, ["study_delete", { target: "subject", id: ids.math }]);
    assert.deepEqual(own.actions, [{ type: "study_delete", target: "subject", id: ids.math }]);
    const other = await propose(users.maxi, ["study_delete", { target: "subject", id: ids.secret }]);
    assert.deepEqual(other.actions, []);
    assert.match(other.message, droppedNote);
    assert.equal((await propose(users.maxi, ["study_delete", { target: "goal", id: ids.exam }])).actions.length, 1);
    assert.equal((await propose(users.maxi, ["study_delete", { target: "part", id: ids.p1 }])).actions.length, 1);
});

test("study_replan comes back as { type: 'study_replan' }", { skip: NO_DB }, async () => {
    const r = await propose(users.maxi, ["study_replan", {}]);
    assert.deepEqual(r.actions, [{ type: "study_replan" }]);
});

test("a study_update with empty changes (all null) is dropped", { skip: NO_DB }, async () => {
    const empty = { name: null, done: null, estimateMinutes: null };
    const r = await propose(users.maxi, ["study_update", { target: "part", id: ids.p2, changes: empty }]);
    assert.deepEqual(r.actions, []);
    assert.match(r.message, droppedNote);
});

test("the study write tools are strict, and the prompt names them", { skip: NO_DB }, async () => {
    await propose(users.maxi, ["study_replan", {}]);
    const names = calls[0].tools.map(t => t.name);
    for (const n of ["study_create", "study_update", "study_delete", "study_replan"]) {
        assert.ok(names.includes(n));
        assert.ok(calls[0].system.includes(n));
    }
    assert.ok(calls[0].tools.filter(t => t.name.startsWith("study_")).every(t => t.strict === true));
});

test("a study action with no text from the model is listed by its name", { skip: NO_DB }, async () => {
    const r = await propose(users.maxi, ["study_create", { target: "subject", name: "Chemie" }]);
    assert.equal(r.message, "Chemie");
});
