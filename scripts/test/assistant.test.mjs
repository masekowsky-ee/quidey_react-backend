// The Max assistant: POST /api/ai/assistant (ai.js) and its tool loop (utils/assistant.js).
// The model is a scripted fake client (utils/ai.js useTestClient), so the real request building,
// stop_reason handling and error mapping run without the API. The router is mounted in-process
// on a throwaway database built from schema.sql (connection from .env), skipped without DB_USER.
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
const quota = require("../../utils/quota.js");

const NO_DB = !process.env.DB_USER && "no database configured (DB_* in .env)";
const dbName = `quidey_assistant_${process.pid}`;
const conn = (database) => ({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
});

let admin, pool, server, API;
const users = {};
const tasks = {};

// ---------- the scripted model ----------
let calls = [];
let callOptions = [];
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
// answers the model calls in order
const turns = (...list) => (params, n) => {
    const turn = list[Math.min(n, list.length) - 1];
    if (turn instanceof Error) throw turn;
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
const ask = (who, text, extra = {}) => call("POST", "/api/ai/assistant", { messages: [{ role: "user", content: text }], language: "en", ...extra }, who);
const used = async (who) => (await quota.status(pool, who.id)).assistant.used;
const usageRow = async (who) => (await pool.query(
    "SELECT calls, input_tokens::int AS input, output_tokens::int AS output FROM assistant_usage WHERE user_id = $1", [who.id])).rows[0];
// the tool results the model got in a call, by tool name
const toolResults = (params) => params.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter(b => b.type === "tool_result");

const in2days = () => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); };

before(async () => {
    if (NO_DB) return;
    admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool(conn(dbName));
    await pool.query(readFileSync(join(here, "..", "..", "schema.sql"), "utf8"));
    await pool.query("SET search_path = public");

    const add = async (name, flags) => {
        const { rows: [u] } = await pool.query(
            `INSERT INTO users (username, password_hash, email, is_pro, is_max, timezone) VALUES ($1, 'x', $1 || '@example.com', $2, $3, 'Europe/Berlin') RETURNING id`,
            [name, flags.pro ?? false, flags.max ?? false]);
        users[name] = { id: u.id };
    };
    await add("maxi", { max: true });
    await add("otto", { max: true });
    await add("pia", { pro: true });
    await add("fred", {});
    await add("rita", { max: true });
    const day = in2days();
    const task = async (key, owner, name) => {
        const { rows: [t] } = await pool.query(
            "INSERT INTO tasks (name, due, due_time, user_id, kind) VALUES ($1, $2, '10:00', $3, 'task') RETURNING id", [name, day, owner.id]);
        tasks[key] = t.id;
    };
    await pool.query("INSERT INTO event_types (user_id, name, color) VALUES ($1, 'Schule', 'blue')", [users.maxi.id]);
    await task("mine", users.maxi, "Mathe lernen");
    await task("theirs", users.otto, "Otto geheim");

    aiUtil.useTestClient({ messages: { create: async (params, options) => {
        calls.push(structuredClone(params));
        callOptions.push(options);
        return script(params, calls.length, options);
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
    callOptions = [];
    script = () => { throw new Error("no script"); };
    await pool.query("DELETE FROM daily_quota");
    await pool.query("DELETE FROM assistant_usage");
});

test("without Max: 403 MAX_REQUIRED, no allowance taken, no model call", { skip: NO_DB }, async () => {
    for (const who of [users.pia, users.fred]) {
        const r = await ask(who, "Hi");
        assert.equal(r.status, 403);
        assert.equal(r.data.code, "MAX_REQUIRED");
        assert.equal(await used(who), 0);
    }
    assert.equal(calls.length, 0);
});

test("GET /quota includes the assistant allowance", { skip: NO_DB }, async () => {
    const r = await call("GET", "/api/ai/quota", null, users.maxi);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.assistant, { used: 0, max: 20 });
});

test("get_schedule then update_entry: one update action, the schedule read for this user only", { skip: NO_DB }, async () => {
    const day = in2days();
    const first = toolTurn(["get_schedule", { from: day, to: day }]);
    script = turns(
        first,
        (params) => {
            const [result] = toolResults(params);
            const id = JSON.parse(result.content).entries[0].id;
            return toolTurn(["update_entry", { id, changes: { name: null, date: "2099-01-05", time: "14:00", endTime: null }, summary: "Mathe lernen to 5 Jan, 14:00" }]);
        },
    );
    const r = await ask(users.maxi, "Move my maths session to 5 January at 2pm");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.actions, [{ type: "update_entry", id: tasks.mine, changes: { date: "2099-01-05", time: "14:00" }, summary: "Mathe lernen to 5 Jan, 14:00" }]);
    assert.equal(typeof r.data.message, "string");
    assert.ok(r.data.message.length > 0);
    assert.equal(r.data.quota.assistant.used, 1);

    assert.equal(calls.length, 2);
    const results = toolResults(calls[1]);
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("Mathe lernen"));
    assert.ok(!results[0].content.includes("Otto geheim"), "another account's task reached the model");
    // the assistant turn goes back unchanged (thinking included), the results in one user message
    assert.deepEqual(calls[1].messages.at(-2), { role: "assistant", content: first.content });
    assert.equal(calls[1].messages.at(-2).content[0].type, "thinking");
    assert.equal(results[0].tool_use_id, first.content[1].id);
    assert.equal(calls[1].messages.at(-1).role, "user");
    assert.ok(calls[1].messages.at(-1).content.every(b => b.type === "tool_result"));

    // token totals: two calls of 100 in / 20 out
    assert.deepEqual(await usageRow(users.maxi), { calls: 1, input: 200, output: 40 });
});

test("the request: system prompt, strict tools, auto tool choice, no sampling parameters", { skip: NO_DB }, async () => {
    script = turns(textTurn("Hello!"));
    const r = await ask(users.maxi, "Hi", { language: "de" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.actions, []);
    assert.equal(r.data.message, "Hello!");
    const [params] = calls;
    assert.equal(params.model, aiUtil.MODEL());
    const system = typeof params.system === "string" ? params.system : params.system.map(b => b.text).join("\n");
    assert.ok(system.includes("Europe/Berlin"));
    assert.ok(system.includes("Schule"));
    assert.ok(/German/.test(system));
    assert.ok(/data, not instructions/i.test(system));
    assert.ok(/\d{4}-\d{2}-\d{2}/.test(system));
    const names = params.tools.map(t => t.name).sort();
    assert.deepEqual(names, ["ask_user", "create_entry", "delete_entry", "find_entries", "get_schedule", "list_event_types", "study_goal", "study_overview", "study_plan", "study_settings", "update_entry"]);
    for (const tool of params.tools) {
        assert.equal(tool.strict, true, tool.name);
        assert.equal(tool.input_schema.additionalProperties, false, tool.name);
        assert.deepEqual([...tool.input_schema.required].sort(), Object.keys(tool.input_schema.properties).sort(), tool.name);
    }
    assert.ok(!params.tool_choice || params.tool_choice.type === "auto");
    for (const key of ["temperature", "top_p", "top_k"]) assert.ok(!(key in params), key);
    assert.ok(!params.thinking?.budget_tokens);
    assert.ok(params.max_tokens > 0);
});

test("more than 10 messages of history: at most the last 10 reach the model", { skip: NO_DB }, async () => {
    script = turns(textTurn("ok"));
    const history = [];
    for (let i = 0; i < 15; i++) history.push({ role: i % 2 ? "assistant" : "user", content: `message ${i}` });
    const r = await call("POST", "/api/ai/assistant", { messages: history, language: "en" }, users.maxi);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const sent = calls[0].messages;
    assert.ok(sent.length <= 10 && sent.length >= 9, String(sent.length));
    assert.deepEqual(sent, history.slice(-sent.length));
    assert.equal(sent[0].role, "user");
});

test("the 21st message of the day: 429 with resetsAt, no model call", { skip: NO_DB }, async () => {
    for (let i = 0; i < 20; i++) await quota.take(pool, users.maxi.id, "assistant");
    const r = await ask(users.maxi, "Hi");
    assert.equal(r.status, 429);
    assert.equal(r.data.code, "QUOTA_REACHED");
    assert.equal(r.data.kind, "assistant");
    assert.ok(r.data.resetsAt);
    assert.equal(calls.length, 0);
});

test("the AI fails on the first call: 502 in the AI error shape, the allowance given back", { skip: NO_DB }, async () => {
    script = turns(new Error("boom"));
    const r = await ask(users.maxi, "Hi");
    assert.equal(r.status, 502);
    assert.equal(r.data.code, "AI_FAILED");
    assert.equal(await used(users.maxi), 0);
    assert.equal(await usageRow(users.maxi), undefined);
});

test("the AI fails after a call that answered: 502, the allowance stays used, the tokens counted", { skip: NO_DB }, async () => {
    script = turns(toolTurn(["list_event_types", {}]), new Error("boom"));
    const r = await ask(users.maxi, "Hi");
    assert.equal(r.status, 502);
    assert.equal(r.data.code, "AI_FAILED");
    assert.equal(await used(users.maxi), 1);
    assert.deepEqual(await usageRow(users.maxi), { calls: 1, input: 100, output: 20 });
});

test("max_tokens after a call that answered: a failure, the allowance stays used", { skip: NO_DB }, async () => {
    script = turns(toolTurn(["list_event_types", {}]), { stop_reason: "max_tokens", content: [{ type: "text", text: "half" }], usage: usage(10, 10) });
    const r = await ask(users.maxi, "Hi");
    assert.equal(r.status, 502);
    assert.equal(await used(users.maxi), 1);
    assert.deepEqual(await usageRow(users.maxi), { calls: 1, input: 110, output: 30 });
});

test("the loop stops after 6 model calls, the allowance stays used", { skip: NO_DB }, async () => {
    script = () => toolTurn(["list_event_types", {}]);
    const r = await ask(users.maxi, "Hi");
    assert.equal(calls.length, 6);
    assert.equal(r.status, 502);
    assert.equal(r.data.code, "AI_TOO_LONG");
    assert.equal(await used(users.maxi), 1);
});

test("at most 3 lookups per step: the others get an error result in the same message", { skip: NO_DB }, async () => {
    const day = in2days();
    const first = toolTurn(
        ["get_schedule", { from: day, to: day }], ["find_entries", { query: "Mathe" }], ["list_event_types", {}],
        ["get_schedule", { from: day, to: day }], ["find_entries", { query: "x" }]);
    script = turns(first, textTurn("ok"));
    const r = await ask(users.maxi, "Everything please");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.message, "ok");
    const results = toolResults(calls[1]);
    // every tool_use answered, in its order, in the one user message after the assistant turn
    assert.deepEqual(results.map(x => x.tool_use_id), first.content.filter(b => b.type === "tool_use").map(b => b.id));
    assert.ok(calls[1].messages.at(-1).content.every(b => b.type === "tool_result"));
    assert.deepEqual(results.map(x => Boolean(x.is_error)), [false, false, false, true, true]);
    for (const refused of results.slice(3)) assert.match(refused.content, /too many lookups/i);
    assert.ok(results[0].content.includes("Mathe lernen"));
});

test("the loop stops once the input tokens pass the budget; the allowance stays used", { skip: NO_DB }, async () => {
    script = () => ({ ...toolTurn(["list_event_types", {}]), usage: usage(25000, 10) });
    const r = await ask(users.maxi, "Hi");
    // 25k, 50k, 75k: no fourth call after passing 60k
    assert.equal(calls.length, 3);
    assert.equal(r.status, 502);
    assert.equal(r.data.code, "AI_TOO_LONG");
    assert.equal(await used(users.maxi), 1);
    assert.deepEqual(await usageRow(users.maxi), { calls: 1, input: 75000, output: 30 });
});

test("a turn that answers past the token budget still returns its answer", { skip: NO_DB }, async () => {
    script = turns({ ...toolTurn(["list_event_types", {}]), usage: usage(59000, 10) }, { ...textTurn("done"), usage: usage(5000, 10) });
    const r = await ask(users.maxi, "Hi");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.message, "done");
});

test("the whole loop has a deadline: AI_TIMEOUT, the allowance kept once a call answered", { skip: NO_DB }, async () => {
    const before = process.env.ASSISTANT_DEADLINE_MS;
    process.env.ASSISTANT_DEADLINE_MS = "1500";
    // each call takes 900 ms unless its signal aborts it first
    script = (params, n, options) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(toolTurn(["list_event_types", {}])), 900);
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
    });
    try {
        const started = Date.now();
        const r = await ask(users.maxi, "Hi");
        assert.ok(Date.now() - started < 2500, "the deadline ended it");
        assert.equal(r.status, 502);
        assert.equal(r.data.code, "AI_TIMEOUT");
        assert.equal(calls.length, 2);
        assert.equal(await used(users.maxi), 1, "the first call answered: the message counts");
        // each call gets the time that is left, never more
        assert.ok(callOptions[0].timeout <= 1500, String(callOptions[0].timeout));
        assert.ok(callOptions[1].timeout < callOptions[0].timeout, `${callOptions[1].timeout} < ${callOptions[0].timeout}`);
        assert.ok(callOptions[1].signal, "an abort signal bounds the retries too");
    } finally {
        if (before === undefined) delete process.env.ASSISTANT_DEADLINE_MS; else process.env.ASSISTANT_DEADLINE_MS = before;
    }
});

test("the deadline passes before the first call answers: the allowance is given back", { skip: NO_DB }, async () => {
    const before = process.env.ASSISTANT_DEADLINE_MS;
    process.env.ASSISTANT_DEADLINE_MS = "100";
    script = (params, n, options) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(textTurn("late")), 1000);
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
    });
    try {
        const r = await ask(users.maxi, "Hi");
        assert.equal(r.status, 502);
        assert.equal(r.data.code, "AI_TIMEOUT");
        assert.equal(await used(users.maxi), 0);
    } finally {
        if (before === undefined) delete process.env.ASSISTANT_DEADLINE_MS; else process.env.ASSISTANT_DEADLINE_MS = before;
    }
});

test("get_schedule: done copies of a repeating series are left out, the range comes first", { skip: NO_DB }, async () => {
    const rita = users.rita;
    // a daily series done 105 times: each done copy has a successor (repeat_from_id), the last one is live
    let previous = null;
    const stale = [];
    for (let i = 105; i >= 1; i--) {
        const { rows: [t] } = await pool.query(
            `INSERT INTO tasks (name, due, user_id, repeat, done, repeat_from_id) VALUES ('Vokabeln', current_date - $1::int, $2, 'daily', true, $3) RETURNING id`,
            [i, rita.id, previous]);
        stale.push(t.id);
        previous = t.id;
    }
    const day = in2days();
    const { rows: [live] } = await pool.query(
        "INSERT INTO tasks (name, due, user_id, repeat, repeat_from_id) VALUES ('Vokabeln', $1, $2, 'daily', $3) RETURNING id", [day, rita.id, previous]);
    // a weekly one that is overdue (not done): its rule still reaches into the range
    const { rows: [gym] } = await pool.query(
        "INSERT INTO tasks (name, due, user_id, repeat) VALUES ('Gym', current_date - 10, $1, 'weekly') RETURNING id", [rita.id]);
    const { rows: [inRange] } = await pool.query(
        "INSERT INTO tasks (name, due, user_id) VALUES ('Referat', $1, $2) RETURNING id", [day, rita.id]);

    script = turns(toolTurn(["get_schedule", { from: day, to: day }]), textTurn("ok"));
    const r = await ask(rita, "What's on?");
    assert.equal(r.status, 200);
    const result = JSON.parse(toolResults(calls[1])[0].content);
    const ids = result.entries.map(e => e.id);
    assert.ok(ids.includes(live.id), "the live entry of the series");
    assert.ok(ids.includes(inRange.id), "the entry in the range");
    assert.ok(ids.includes(gym.id), "the overdue repeating entry");
    assert.ok(!stale.some(id => ids.includes(id)), "a done copy of the series");
    assert.equal(result.more, undefined);
    // what is in the range comes before the repeating ones from earlier
    assert.ok(ids.indexOf(inRange.id) < ids.indexOf(gym.id));
});

test("an id of another account's task (or none at all) is dropped and the reply says so", { skip: NO_DB }, async () => {
    script = turns(toolTurn(
        ["update_entry", { id: tasks.theirs, changes: { name: "hacked", date: null, time: null, endTime: null }, summary: "rename" }],
        ["delete_entry", { id: 987654, summary: "delete" }],
        ["delete_entry", { id: 99999999999, summary: "delete" }],
    ));
    const r = await ask(users.maxi, "Rename Otto's task");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.actions, []);
    assert.match(r.data.message, /couldn't|could not/i);
    const { rows } = await pool.query("SELECT name FROM tasks WHERE id = $1", [tasks.theirs]);
    assert.equal(rows[0].name, "Otto geheim");
});

test("create_entry is checked like parse-entry; study_plan and delete pass through checked", { skip: NO_DB }, async () => {
    script = turns({
        stop_reason: "tool_use",
        content: [
            { type: "text", text: "Here you go." },
            { type: "tool_use", id: "t1", name: "create_entry", input: { kind: "event", name: "  Physik  Test ", date: "2099-02-31", time: "25:00", endTime: null, durationMinutes: null, color: "blue", eventType: "schule", remindersMinutesBefore: [15, 99999], priority: "high" } },
            { type: "tool_use", id: "t2", name: "study_plan", input: { subject: "Biologie", examDate: "2099-03-02", topics: ["Zellatmung", "", "Fotosynthese"] } },
            { type: "tool_use", id: "t3", name: "delete_entry", input: { id: tasks.mine, summary: "Delete Mathe lernen" } },
            { type: "tool_use", id: "t4", name: "study_plan", input: { subject: "Chemie", examDate: "not a date", topics: [] } },
        ],
        usage: usage(10, 10),
    });
    const r = await ask(users.maxi, "Plan stuff");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [create, plan, del] = r.data.actions;
    assert.equal(r.data.actions.length, 3);
    assert.equal(create.type, "create_entry");
    const { rows: [type] } = await pool.query("SELECT id FROM event_types WHERE user_id = $1", [users.maxi.id]);
    // an event without a valid day becomes a task (an event needs one)
    assert.deepEqual(create.entry, { kind: "task", name: "Physik Test", due: null, time: null, durationMinutes: null, color: "blue", eventTypeId: type.id, reminders: [15], prio: 80 });
    assert.deepEqual(plan, { type: "study_plan", subject: "Biologie", examDate: "2099-03-02", topics: ["Zellatmung", "Fotosynthese"] });
    assert.deepEqual(del, { type: "delete_entry", id: tasks.mine, summary: "Delete Mathe lernen" });
    assert.match(r.data.message, /Here you go\./);
    assert.match(r.data.message, /couldn't|could not/i);
});

test("a long answer is clipped, and the chat with it as history still works", { skip: NO_DB }, async () => {
    script = turns(textTurn("word ".repeat(1000)), textTurn("ok"));
    const first = await ask(users.maxi, "List everything");
    assert.equal(first.status, 200);
    assert.ok(first.data.message.length <= 2000, String(first.data.message.length));
    const history = [{ role: "user", content: "List everything" }, { role: "assistant", content: first.data.message }, { role: "user", content: "Thanks" }];
    assert.equal((await call("POST", "/api/ai/assistant", { messages: history, language: "en" }, users.maxi)).status, 200);
    // an over-long answer from an older app is shortened rather than refused
    history[1].content = "x".repeat(5000);
    assert.equal((await call("POST", "/api/ai/assistant", { messages: history, language: "en" }, users.maxi)).status, 200);
    assert.ok(calls.at(-1).messages[1].content.length <= 2000);
});

test("a proposal without words: the message names what is proposed", { skip: NO_DB }, async () => {
    script = turns(toolTurn(["delete_entry", { id: tasks.mine, summary: "Delete Mathe lernen" }]));
    const r = await ask(users.maxi, "Delete maths");
    assert.equal(r.status, 200);
    assert.equal(r.data.message, "Delete Mathe lernen");
});

test("ask_user ends the loop with the question", { skip: NO_DB }, async () => {
    script = turns(toolTurn(["ask_user", { question: "Which day?" }]));
    const r = await ask(users.maxi, "Move it");
    assert.equal(r.status, 200);
    assert.equal(r.data.message, "Which day?");
    assert.deepEqual(r.data.actions, []);
    assert.equal(calls.length, 1);
});

test("find_entries searches only my entries; list_event_types lists mine", { skip: NO_DB }, async () => {
    script = turns(toolTurn(["find_entries", { query: "e" }], ["list_event_types", {}]), textTurn("done"));
    const r = await ask(users.maxi, "Find");
    assert.equal(r.status, 200);
    const [found, types] = toolResults(calls[1]);
    assert.ok(found.content.includes("Mathe lernen"));
    assert.ok(!found.content.includes("Otto geheim"));
    assert.ok(types.content.includes("Schule"));
});

test("a refusal: a plain message, no actions, the tokens counted", { skip: NO_DB }, async () => {
    script = turns({ stop_reason: "refusal", content: [], usage: usage(30, 5), stop_details: { type: "refusal", category: null, explanation: null } });
    const r = await ask(users.maxi, "something bad");
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.actions, []);
    assert.ok(r.data.message.length > 0);
    assert.equal(r.data.quota.assistant.used, 1);
    assert.deepEqual(await usageRow(users.maxi), { calls: 1, input: 30, output: 5 });
});

test("bad bodies: 400 INVALID_INPUT, no allowance taken", { skip: NO_DB }, async () => {
    const bad = [
        {},
        { messages: [], language: "en" },
        { messages: [{ role: "user", content: "" }], language: "en" },
        { messages: [{ role: "user", content: "x".repeat(2001) }], language: "en" },
        { messages: [{ role: "system", content: "x" }], language: "en" },
        { messages: [{ role: "user", content: 5 }], language: "en" },
        { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hi" }], language: "en" },
        { messages: [{ role: "user", content: "hi" }], language: "fr" },
        { messages: Array.from({ length: 41 }, () => ({ role: "user", content: "hi" })), language: "en" },
    ];
    for (const body of bad) {
        const r = await call("POST", "/api/ai/assistant", body, users.maxi);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
        assert.equal(r.data.code, "INVALID_INPUT");
    }
    assert.equal(await used(users.maxi), 0);
    assert.equal(calls.length, 0);
});
