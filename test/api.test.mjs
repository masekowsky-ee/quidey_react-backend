// End-to-end tests of the API against a real PostgreSQL: `npm test`.
// Creates a throwaway database from schema.sql (connection from .env, DB_NAME is ignored),
// starts the server on a free port with mails only logged (SMTP_HOST empty), runs everything
// and drops the database again. Nothing touches the development database.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import pg from "pg";
import dotenv from "dotenv";
import { io } from "socket.io-client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const DB = `quidey_test_${process.pid}`;
const PW = "Sup3r-secret-pass!";
const conn = (database) => ({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
});

let server;
let log = "";
let API;
let db;

const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = async (text, params) => (await db.query(text, params)).rows;

async function call(method, path, body, token) {
    const res = await fetch(API + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
}

// the newest verification link the server logged for an address
async function linkFor(email) {
    for (let i = 0; i < 20; i++) {
        const match = [...log.matchAll(new RegExp(`Verification link for ${email.replace(/[.]/g, "\\.")}: \\S*token=([0-9a-f]{64})`, "g"))].at(-1);
        if (match) return match[1];
        await sleep(50);
    }
    return null;
}

const register = (username, email, extra = {}) => call("POST", "/api/register", {
    username, display_name: username[0].toUpperCase() + username.slice(1), email, password: PW,
    birth_date: "1995-05-05", accept_terms: true, accept_privacy: true, confirm_age: true, ...extra,
});

// a verified account with beta access, signed in: { id, token }
async function member(username, { admin = false, pro = true } = {}) {
    const r = await register(username, `${username}@example.com`);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await sql("UPDATE users SET email_verified = true, is_pro = $2, is_admin = $3 WHERE username = $1", [username, pro, admin]);
    const login = await call("POST", "/api/login", { username, password: PW });
    return { id: r.data.id, token: login.data.token };
}

async function befriend(a, b, bName) {
    const req = await call("POST", "/api/friends/requests", { username: bName }, a.token);
    await call("POST", `/api/friends/requests/${req.data.request.id}/accept`, null, b.token);
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysFromToday = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

before(async () => {
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    db = new pg.Client(conn(DB));
    await db.connect();
    await db.query(readFileSync(join(ROOT, "schema.sql"), "utf8"));
    await db.query("SET search_path = public");

    const port = await freePort();
    API = `http://localhost:${port}`;
    server = spawn(process.execPath, ["index.js"], {
        cwd: ROOT,
        env: {
            ...process.env, DB_NAME: DB, PORT: String(port), SMTP_HOST: "", CONTACT_TO: "owner@example.com",
            RATE_LIMIT_REGISTER: "1000", RATE_LIMIT_AUTH: "1000", RATE_LIMIT_VERIFICATION_MAIL: "1000", RATE_LIMIT_API: "10000", REMINDER_CHECK_MS: "200", EVENT_CHECK_MS: "200",
        },
    });
    server.stdout.on("data", (chunk) => { log += chunk; });
    server.stderr.on("data", (chunk) => { log += chunk; });
    for (let i = 0; i < 100 && !log.includes("Server running"); i++) await sleep(100);
    assert.ok(log.includes("Server running"), `server did not start:\n${log}`);
});

after(async () => {
    server?.kill();
    await db?.end();
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
});

describe("registration, consent and email verification", () => {
    test("all three consents are required and stored", async () => {
        for (const [missing, code] of [["accept_terms", "TERMS_REQUIRED"], ["accept_privacy", "PRIVACY_REQUIRED"], ["confirm_age", "AGE_CONFIRMATION_REQUIRED"]]) {
            const r = await register("ann", "ann@example.com", { [missing]: undefined });
            assert.equal(r.status, 400);
            assert.equal(r.data.code, code);
        }
        const r = await register("ann", "ann@example.com");
        assert.equal(r.status, 201);
        const [row] = await sql("SELECT terms_accepted_at IS NOT NULL AND privacy_accepted_at IS NOT NULL AS ok FROM users WHERE username = 'ann'");
        assert.ok(row.ok);
    });

    test("names and addresses are unique regardless of case, and under 14 is refused", async () => {
        assert.equal((await register("ANN", "x@example.com")).data.code, "USERNAME_TAKEN");
        assert.equal((await register("bob", "ANN@example.com")).data.code, "EMAIL_TAKEN");
        assert.equal((await register("kid", "kid@example.com", { birth_date: "2020-01-01" })).data.code, "TOO_YOUNG");
    });

    test("signing in waits for the confirmation; a new link replaces the old", async () => {
        assert.equal((await call("POST", "/api/login", { username: "ann", password: PW })).data.code, "EMAIL_NOT_VERIFIED");
        const first = await linkFor("ann@example.com");
        assert.ok(first);
        assert.equal((await call("POST", "/api/resend-verification", { email: "ann@example.com" })).status, 200);
        assert.equal((await call("POST", "/api/resend-verification", { email: "nobody@example.com" })).status, 200, "same answer for unknown addresses");
        await sleep(100);
        const second = await linkFor("ann@example.com");
        assert.notEqual(second, first);
        assert.equal((await call("POST", "/api/verify-email", { token: first })).status, 400);
        assert.equal((await call("POST", "/api/verify-email", { token: second })).data.verified, true);
        assert.equal((await call("POST", "/api/verify-email", { token: second })).status, 400, "a link works once");
    });

    test("sign in with username or email, any case", async () => {
        const byMail = await call("POST", "/api/login", { username: " ANN@example.com ", password: PW });
        assert.equal(byMail.data.username, "ann");
        const byName = await call("POST", "/api/login", { username: "Ann", password: PW });
        assert.equal(byName.data.username, "ann");
        assert.equal((await call("POST", "/api/login", { username: "ann@example.com", password: "wrong-pass" })).status, 401);
    });
});

describe("contact form and feedback", () => {
    test("contact form: validated, bots get an answer but no mail, header injection is flattened", async () => {
        assert.equal((await call("POST", "/api/contact", { name: "Ann", email: "nope", message: "Hallo, eine Frage." })).status, 400);
        assert.equal((await call("POST", "/api/contact", { name: "Ann", email: "ann@example.com", message: "Hi" })).status, 400);
        assert.equal((await call("POST", "/api/contact", { name: "Bot", email: "b@example.com", message: "Cheap stuff now!!", website: "spam" })).status, 200);
        assert.equal((await call("POST", "/api/contact", { name: "Ann\nBcc: x@y.de", email: "ann@example.com", message: "Hallo, eine Frage." })).status, 200);
        await sleep(100);
        assert.match(log, /Name: Ann Bcc: x@y\.de\n/);
        assert.doesNotMatch(log, /Name: Bot/);
    });

    test("feedback needs a login and names the sender", async () => {
        const bob = await member("fbuser");
        assert.ok([401, 403].includes((await call("POST", "/api/feedback", { category: "bug", message: "Der Kalender springt." })).status));
        assert.equal((await call("POST", "/api/feedback", { category: "nope", message: "Der Kalender springt." }, bob.token)).status, 400);
        assert.equal((await call("POST", "/api/feedback", { category: "bug", message: "Der Kalender springt." }, bob.token)).status, 200);
        await sleep(100);
        assert.match(log, /Feedback aus Quidey: Fehler[\s\S]*@fbuser[\s\S]*fbuser@example\.com[\s\S]*Der Kalender springt\./);
    });
});

describe("repeating tasks and completion time", () => {
    let me;
    before(async () => { me = await member("runner"); });

    test("repeating needs a day and a known rhythm", async () => {
        assert.equal((await call("POST", "/api/tasks", { name: "X", prio: 50, due: null, description: "", repeat: "weekly" }, me.token)).data.field, "repeat");
        assert.equal((await call("POST", "/api/tasks", { name: "X", prio: 50, due: daysFromToday(0), description: "", repeat: "hourly" }, me.token)).status, 400);
    });

    test("done creates the next one once, on the first day not in the past, with fields and groups", async () => {
        const group = (await call("POST", "/api/groups", { name: "Sport", description: "" }, me.token)).data;
        const task = (await call("POST", "/api/tasks", { name: "Laufen", prio: 60, due: daysFromToday(-10), description: "Park", repeat: "weekly", due_time: "07:30", reminder_minutes: 15 }, me.token)).data;
        await call("POST", `/api/tasks/${task.id}/groups/${group.id}`, null, me.token);

        const done = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: daysFromToday(-10), done: true }, me.token)).data;
        assert.ok(done.completed_at);
        const next = done.nextTask;
        assert.ok(next && !next.done);
        const [{ due }] = await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1", [next.id]);
        assert.equal(due, daysFromToday(4), "two weekly steps: the first one not in the past");
        assert.equal(next.description, "Park");
        assert.equal(next.due_time, "07:30");
        assert.equal(next.reminder_minutes, 15);
        assert.deepEqual(next.group_ids, [group.id]);

        const reopened = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: daysFromToday(-10), done: false }, me.token)).data;
        assert.equal(reopened.completed_at, null);
        const again = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: daysFromToday(-10), done: true }, me.token)).data;
        assert.equal(again.nextTask, undefined);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE repeat_from_id = $1", [task.id]))[0].n, 1);

        const noDay = (await call("PUT", `/api/tasks/${next.id}`, { name: "Laufen", due: null, description: "Park", prio: 60, done: false, due_time: null }, me.token)).data;
        assert.equal(noDay.repeat, null, "without a day it stops repeating");
    });

    test("monthly from the 31st stays on the 31st where the month has one", async () => {
        const task = (await call("POST", "/api/tasks", { name: "Monatsende", prio: 50, due: "2026-01-31", description: "", repeat: "monthly" }, me.token)).data;
        const { nextTask } = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: "2026-01-31", done: true }, me.token)).data;
        const [{ due }] = await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1", [nextTask.id]);
        assert.ok(due >= daysFromToday(0));
        assert.ok(["30", "31"].includes(due.slice(8)), due);
    });
});

describe("events and event types", () => {
    let me;
    let other;
    before(async () => {
        me = await member("eventer");
        other = await member("eventother");
    });
    const newEvent = (fields, token = me.token) =>
        call("POST", "/api/tasks", { name: "Schicht", prio: null, description: "", kind: "event", ...fields }, token);

    test("event types: my own list, unique names, colour checked, others can't touch it", async () => {
        const work = await call("POST", "/api/event-types", { name: "Arbeit", color: "blue" }, me.token);
        assert.equal(work.status, 201);
        assert.deepEqual([work.data.name, work.data.color, work.data.position], ["Arbeit", "blue", 0]);
        assert.equal((await call("POST", "/api/event-types", { name: "arbeit" }, me.token)).data.code, "EVENT_TYPE_EXISTS");
        assert.equal((await call("POST", "/api/event-types", { name: "Sport", color: "plaid" }, me.token)).data.field, "color");
        assert.equal((await call("POST", "/api/event-types", { name: " " }, me.token)).data.field, "name");
        const sport = (await call("POST", "/api/event-types", { name: "Sport" }, me.token)).data;
        assert.equal(sport.position, 1);
        assert.equal((await call("POST", "/api/event-types", { name: "Arbeit" }, other.token)).status, 201, "names are per account");

        const renamed = await call("PUT", `/api/event-types/${sport.id}`, { name: "Training", color: "green" }, me.token);
        assert.deepEqual([renamed.data.name, renamed.data.color], ["Training", "green"]);
        assert.equal((await call("PUT", `/api/event-types/${sport.id}`, { name: "Arbeit" }, me.token)).data.code, "EVENT_TYPE_EXISTS");
        assert.equal((await call("PUT", `/api/event-types/${sport.id}`, { name: "Mine" }, other.token)).status, 404);
        assert.equal((await call("DELETE", `/api/event-types/${sport.id}`, null, other.token)).status, 404);
        assert.deepEqual((await call("GET", "/api/event-types", null, me.token)).data.map(t => t.name), ["Arbeit", "Training"]);
    });

    test("an event needs a day and one of my own types; tasks have no type", async () => {
        assert.equal((await newEvent({ due: null })).data.field, "due");
        assert.equal((await newEvent({ due: daysFromToday(1), kind: "meeting" })).data.field, "kind");
        const theirs = (await call("GET", "/api/event-types", null, other.token)).data[0];
        assert.equal((await newEvent({ due: daysFromToday(1), event_type_id: theirs.id })).data.field, "event_type_id");
        const mine = (await call("GET", "/api/event-types", null, me.token)).data[0];
        const task = (await call("POST", "/api/tasks", { name: "Bericht", prio: 50, due: null, description: "", event_type_id: mine.id }, me.token)).data;
        assert.deepEqual([task.kind, task.event_type_id], ["task", null]);
    });

    test("a past event is done right away, a coming one stays open and can't be ticked off by hand", async () => {
        const work = (await call("GET", "/api/event-types", null, me.token)).data[0];
        const past = (await newEvent({ due: daysFromToday(-2), due_time: "09:00", duration_minutes: 480, event_type_id: work.id })).data;
        assert.equal(past.kind, "event");
        assert.equal(past.done, true);
        assert.deepEqual(past.event_type, { id: work.id, name: "Arbeit", color: "blue" });
        const [{ ended }] = await sql(
            "SELECT completed_at = ((due + due_time) AT TIME ZONE 'Europe/Berlin') + interval '8 hours' AS ended FROM tasks WHERE id = $1", [past.id]);
        assert.ok(ended, "completed when it ended");

        const coming = (await newEvent({ due: daysFromToday(2), due_time: "09:00", duration_minutes: 60 })).data;
        assert.equal(coming.done, false);
        const ticked = (await call("PUT", `/api/tasks/${coming.id}`, { ...coming, due: daysFromToday(2), done: true }, me.token)).data;
        assert.equal(ticked.done, false);

        // a whole-day event is over only when the day is
        assert.equal((await newEvent({ due: daysFromToday(0) })).data.done, false);

        // moved into the future it opens again; moved back it's done again
        const moved = (await call("PUT", `/api/tasks/${past.id}`, { ...past, due: daysFromToday(3), done: true }, me.token)).data;
        assert.deepEqual([moved.done, moved.completed_at], [false, null]);
        const back = (await call("PUT", `/api/tasks/${past.id}`, { ...past, due: daysFromToday(-2), done: false }, me.token)).data;
        assert.equal(back.done, true);
    });

    test("a repeating event that is over comes back with its next one, type and all", async () => {
        const work = (await call("GET", "/api/event-types", null, me.token)).data[0];
        const res = (await newEvent({ due: daysFromToday(-3), due_time: "08:00", duration_minutes: 240, repeat: "weekly", event_type_id: work.id })).data;
        assert.equal(res.done, true);
        const next = res.nextTask;
        assert.ok(next);
        assert.deepEqual([next.kind, next.event_type_id, next.done, next.duration_minutes], ["event", work.id, false, 240]);
        const [{ due }] = await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1", [next.id]);
        assert.equal(due, daysFromToday(4));
    });

    test("the server ticks off events that end while nobody looks", async () => {
        const [{ id }] = await sql(
            `INSERT INTO tasks (name, user_id, kind, due, due_time, duration_minutes, done)
            VALUES ('Vorbei', $1, 'event', $2, '06:00', 30, false) RETURNING id`, [me.id, daysFromToday(-1)]);
        for (let i = 0; i < 50 && !(await sql("SELECT done FROM tasks WHERE id = $1", [id]))[0].done; i++) await sleep(100);
        assert.equal((await sql("SELECT done FROM tasks WHERE id = $1", [id]))[0].done, true);
    });

    test("statistics for a period: event time per type, focus and ticked-off tasks", async () => {
        const kim = await member("statkim");
        const work = (await call("POST", "/api/event-types", { name: "Arbeit", color: "teal" }, kim.token)).data;
        for (const n of [-1, -2, -3, -4]) {
            await newEvent({ due: daysFromToday(n), due_time: "08:00", duration_minutes: 480, event_type_id: work.id }, kim.token);
        }
        await newEvent({ due: daysFromToday(-40), due_time: "08:00", duration_minutes: 480, event_type_id: work.id }, kim.token);
        await newEvent({ due: daysFromToday(-2), due_time: "18:00", duration_minutes: 90 }, kim.token);
        await newEvent({ due: daysFromToday(5), due_time: "08:00", duration_minutes: 480, event_type_id: work.id }, kim.token);
        await sql("INSERT INTO sessions (user_id, time_ms, date) VALUES ($1, 1800000, now() - interval '1 day')", [kim.id]);
        await sql("INSERT INTO tasks (name, user_id, done, completed_at) VALUES ('Blatt', $1, true, now() - interval '1 day')", [kim.id]);

        const week = (await call("GET", `/api/stats?from=${daysFromToday(-6)}&to=${daysFromToday(0)}`, null, kim.token)).data;
        assert.equal(week.events.ms, 32 * 3_600_000 + 90 * 60_000);
        assert.equal(week.events.count, 5);
        assert.deepEqual(week.events.types.map(t => [t.name, t.ms, t.count]), [["Arbeit", 32 * 3_600_000, 4], [null, 90 * 60_000, 1]]);
        assert.equal(week.events.days.length, 4);
        assert.deepEqual([week.focus.ms, week.focus.sessions], [1_800_000, 1]);
        assert.equal(week.tasksDone, 1, "events don't count as ticked-off tasks");
        assert.equal((await call("GET", "/api/profile", null, kim.token)).data.stats.tasksDone, 1, "not in the all-time numbers either");
        assert.equal(week.firstDay, daysFromToday(-40));

        const all = (await call("GET", "/api/stats", null, kim.token)).data;
        assert.equal(all.events.types[0].ms, 40 * 3_600_000);
        assert.equal((await call("GET", `/api/stats?from=${daysFromToday(0)}&to=${daysFromToday(-1)}`, null, kim.token)).status, 400);
        assert.equal((await call("GET", "/api/stats?from=yesterday", null, kim.token)).data.field, "from");
        assert.equal((await call("GET", "/api/stats")).status, 401);
    });

    test("deleting a type keeps its events, without a type", async () => {
        const type = (await call("POST", "/api/event-types", { name: "Kurz" }, me.token)).data;
        const event = (await newEvent({ due: daysFromToday(1), event_type_id: type.id })).data;
        assert.equal((await call("DELETE", `/api/event-types/${type.id}`, null, me.token)).status, 200);
        const tasks = (await call("GET", "/api/tasks", null, me.token)).data;
        const kept = tasks.find(t => t.id === event.id);
        assert.deepEqual([kept.kind, kept.event_type_id, kept.event_type], ["event", null, null]);
    });
});

describe("task colours and reminders by mail", () => {
    let ann, ben;
    before(async () => {
        ann = await member("mailann");
        ben = await member("mailben");
        await befriend(ann, ben, "mailben");
    });

    // "YYYY-MM-DD" and "HH:MM" in UTC, `minutes` from now
    const utcIn = (minutes) => {
        const d = new Date(Date.now() + minutes * 60000);
        return { due: d.toISOString().slice(0, 10), due_time: d.toISOString().slice(11, 16) };
    };
    const mailsFor = (email, name) => log.split("\n").filter(line => line.includes(`[DEV] Reminder for ${email}: ${name} (`)).length;
    async function waitForMails(email, name, count) {
        for (let i = 0; i < 40 && mailsFor(email, name) < count; i++) await sleep(100);
        return mailsFor(email, name);
    }

    test("a task's colour is one of the app's colours, can be cleared and goes along when it repeats", async () => {
        assert.equal((await call("POST", "/api/tasks", { name: "Bunt", color: "chartreuse" }, ann.token)).data.field, "color");
        const task = (await call("POST", "/api/tasks", { name: "Bunt", prio: 50, due: daysFromToday(-1), description: "", color: "teal", repeat: "daily" }, ann.token)).data;
        assert.equal(task.color, "teal");
        assert.equal(task.reminder_email, false);
        const done = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: daysFromToday(-1), done: true }, ann.token)).data;
        assert.equal(done.nextTask.color, "teal");
        const cleared = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: daysFromToday(-1), color: null }, ann.token)).data;
        assert.equal(cleared.color, null);
    });

    test("a group's colour: same colours, kept when a change leaves it out, can be cleared", async () => {
        assert.equal((await call("POST", "/api/groups", { name: "Bunt", description: "", color: "chartreuse" }, ann.token)).status, 400);
        assert.equal((await call("POST", "/api/groups", { name: "Grau", description: "" }, ann.token)).data.color, null);
        const group = (await call("POST", "/api/groups", { name: "Bunt", description: "", color: "violet" }, ann.token)).data;
        assert.equal(group.color, "violet");
        assert.equal((await call("PUT", `/api/groups/${group.id}`, { name: "Bunt", description: "neu" }, ann.token)).data.color, "violet");
        assert.equal((await call("PUT", `/api/groups/${group.id}`, { name: "Bunt", description: "", color: "pink" }, ann.token)).data.color, "pink");
        assert.equal((await call("PUT", `/api/groups/${group.id}`, { name: "Bunt", description: "", color: "beige" }, ann.token)).status, 400);
        assert.equal((await call("PUT", `/api/groups/${group.id}`, { name: "Bunt", description: "", color: null }, ann.token)).data.color, null);
        assert.equal((await call("PUT", `/api/groups/${group.id}`, { name: "Bunt", description: "", color: "teal" }, ben.token)).status, 404, "not someone else's");
    });

    test("the app's time zone and language are checked and stored", async () => {
        assert.equal((await call("PUT", "/api/users/locale", { timezone: "Mars/Olympus" }, ann.token)).status, 400);
        assert.equal((await call("PUT", "/api/users/locale", { timezone: "'; DROP TABLE users; --" }, ann.token)).status, 400);
        assert.equal((await call("PUT", "/api/users/locale", { language: "fr" }, ann.token)).status, 400);
        assert.equal((await call("PUT", "/api/users/locale", { timezone: "UTC", language: "en" }, ann.token)).status, 200);
        assert.equal((await call("PUT", "/api/users/locale", { timezone: "UTC" }, ben.token)).status, 200);
        const [row] = await sql("SELECT timezone, language FROM users WHERE id = $1", [ann.id]);
        assert.deepEqual(row, { timezone: "UTC", language: "en" });
    });

    test("a reminder is mailed once when it's due, and again after the task moved", async () => {
        const start = utcIn(3);
        const task = (await call("POST", "/api/tasks", { name: "Mathe lernen", prio: 50, description: "", ...start, reminder_minutes: 5, reminder_email: true }, ann.token)).data;
        assert.equal(task.reminder_email, true);
        // the same without "by mail", and one whose reminder is still ahead
        await call("POST", "/api/tasks", { name: "Nur in der App", prio: 50, description: "", ...start, reminder_minutes: 5 }, ann.token);
        await call("POST", "/api/tasks", { name: "Später", prio: 50, description: "", ...utcIn(120), reminder_minutes: 5, reminder_email: true }, ann.token);

        assert.equal(await waitForMails("mailann@example.com", "Mathe lernen", 1), 1);
        await sleep(800);
        assert.equal(mailsFor("mailann@example.com", "Mathe lernen"), 1, "only once");
        assert.equal(mailsFor("mailann@example.com", "Nur in der App"), 0);
        assert.equal(mailsFor("mailann@example.com", "Später"), 0);

        const moved = utcIn(4);
        await call("PUT", `/api/tasks/${task.id}`, { ...task, ...moved }, ann.token);
        assert.equal(await waitForMails("mailann@example.com", "Mathe lernen", 2), 2, "a new time reminds again");

        // done tasks are quiet
        const done = (await call("POST", "/api/tasks", { name: "Schon erledigt", prio: 50, description: "", ...utcIn(3), reminder_minutes: 10 }, ann.token)).data;
        await call("PUT", `/api/tasks/${done.id}`, { ...done, ...utcIn(3), done: true, reminder_email: true }, ann.token);
        await sleep(800);
        assert.equal(mailsFor("mailann@example.com", "Schon erledigt"), 0);
    });

    test("only the owner turns mails on or off; they reach only the owner", async () => {
        const start = utcIn(3);
        const task = (await call("POST", "/api/tasks", { name: "Gruppenarbeit", prio: 50, description: "", ...start, reminder_minutes: 30 }, ann.token)).data;
        await call("POST", `/api/tasks/${task.id}/shares`, { userIds: [ben.id] }, ann.token);
        const [share] = (await call("GET", "/api/task-shares", null, ben.token)).data;
        await call("POST", `/api/task-shares/${share.id}/accept`, null, ben.token);

        const byBen = (await call("PUT", `/api/tasks/${task.id}`, { ...task, ...start, color: "pink", reminder_email: true }, ben.token)).data;
        assert.equal(byBen.color, "pink", "the colour is shared");
        assert.equal(byBen.reminder_email, false, "ben can't turn on mails to ann");

        await call("PUT", `/api/tasks/${task.id}`, { ...task, ...start, reminder_email: true }, ann.token);
        assert.equal(await waitForMails("mailann@example.com", "Gruppenarbeit", 1), 1);
        assert.equal(mailsFor("mailben@example.com", "Gruppenarbeit"), 0);
    });
});

describe("details of tasks in a shared session", () => {
    let ann, bob, sessionId;
    before(async () => {
        ann = await member("detailann");
        bob = await member("detailbob");
        await befriend(ann, bob, "detailbob");
        sessionId = (await call("POST", "/api/shared-sessions", { name: "Details", friendIds: [bob.id] }, ann.token)).data.id;
        await call("POST", `/api/shared-sessions/${sessionId}/join`, null, bob.token);
    });
    const tasksPath = () => `/api/shared-sessions/${sessionId}/tasks`;
    const find = (session, name) => session.tasks.find(task => task.name === name);

    test("a name is enough; every other field is optional and checked like on own tasks", async () => {
        const plain = find((await call("POST", tasksPath(), { name: "Nur Name" }, ann.token)).data, "Nur Name");
        for (const field of ["description", "due", "due_time", "prio", "duration_minutes", "location", "link", "details", "color"]) {
            assert.equal(plain[field], null, field);
        }

        const day = daysFromToday(2);
        const full = find((await call("POST", tasksPath(), {
            name: "Alles", description: "Kurz", due: day, due_time: "09:30", prio: 70, duration_minutes: 90,
            location: "Bib", link: "https://example.com/folien", details: "Mehr", color: "teal",
        }, ann.token)).data, "Alles");
        assert.equal(iso(new Date(full.due)), day);
        assert.deepEqual(
            [full.description, full.due_time, full.prio, full.duration_minutes, full.location, full.link, full.details, full.color],
            ["Kurz", "09:30", 70, 90, "Bib", "https://example.com/folien", "Mehr", "teal"]
        );

        for (const [field, value] of [["color", "chartreuse"], ["link", "javascript:alert(1)"], ["duration_minutes", 0], ["due", "kein Tag"], ["prio", 5000]]) {
            assert.equal((await call("POST", tasksPath(), { name: "Falsch", [field]: value }, ann.token)).data.field, field);
        }
        assert.equal((await call("POST", tasksPath(), { name: "Ohne Tag", due_time: "10:00" }, ann.token)).data.field, "due_time");
    });

    test("every member changes them; what isn't sent stays, null clears, no day takes the time along", async () => {
        const taskId = find((await call("POST", tasksPath(), { name: "Ändern", due: daysFromToday(1), due_time: "08:00", location: "Raum 1" }, ann.token)).data, "Ändern").id;

        let task = find((await call("PATCH", `${tasksPath()}/${taskId}`, { name: "Geändert", color: "pink", prio: 10 }, bob.token)).data, "Geändert");
        assert.deepEqual([task.color, task.prio, task.location, task.due_time], ["pink", 10, "Raum 1", "08:00"]);

        task = find((await call("PATCH", `${tasksPath()}/${taskId}`, { due: null, location: null }, bob.token)).data, "Geändert");
        assert.deepEqual([task.due, task.due_time, task.location, task.color], [null, null, null, "pink"]);

        assert.equal((await call("PATCH", `${tasksPath()}/${taskId}`, { due_time: "07:00" }, bob.token)).data.field, "due_time");
        assert.equal((await call("PATCH", `${tasksPath()}/${taskId}`, { name: "  " }, bob.token)).data.field, "name");
        assert.equal((await call("PATCH", `${tasksPath()}/${taskId}`, {}, bob.token)).data.code, "NOTHING_TO_CHANGE");
    });

    test("one of my own tasks brings its details along", async () => {
        const own = (await call("POST", "/api/tasks", {
            name: "Eigene", prio: 40, due: daysFromToday(3), description: "Von mir", due_time: "14:00",
            location: "Zuhause", color: "blue", reminder_minutes: 15, repeat: "weekly",
        }, ann.token)).data;
        const shared = find((await call("POST", tasksPath(), { taskId: own.id }, ann.token)).data, "Eigene");
        assert.deepEqual(
            [shared.description, shared.prio, shared.due_time, shared.location, shared.color, shared.sourceTaskId],
            ["Von mir", 40, "14:00", "Zuhause", "blue", own.id]
        );
        assert.equal(iso(new Date(shared.due)), daysFromToday(3));
        // reminders and repeating stay personal
        assert.equal(shared.reminder_minutes, undefined);
        assert.equal(shared.repeat, undefined);
    });
});

describe("inbox: messages and notices", () => {
    let ann, bob, cleo, dan;
    before(async () => {
        ann = await member("inboxann", { admin: true });
        bob = await member("inboxbob");
        cleo = await member("inboxcleo");
        dan = await member("inboxdan", { pro: false });
    });

    test("messages only between friends", async () => {
        const r = await call("POST", `/api/messages/${bob.id}`, { body: "Hallo" }, ann.token);
        assert.equal(r.status, 403);
        assert.equal(r.data.code, "NOT_FRIENDS");
        await befriend(ann, bob, "inboxbob");
        assert.equal((await call("POST", `/api/messages/${bob.id}`, { body: "Hallo Bob" }, ann.token)).status, 201);
        assert.equal((await call("POST", `/api/messages/${bob.id}`, { body: "   " }, ann.token)).status, 400);
        await call("POST", `/api/messages/${bob.id}`, { body: "Kommst du morgen?" }, ann.token);
    });

    test("unread counts, conversation list, reading marks read", async () => {
        assert.equal((await call("GET", "/api/inbox/unread", null, bob.token)).data.messages, 2);
        const list = (await call("GET", "/api/messages", null, bob.token)).data;
        assert.equal(list.length, 1);
        assert.equal(list[0].user.id, ann.id);
        assert.equal(list[0].unread, 2);
        assert.equal(list[0].lastMessage.body, "Kommst du morgen?");
        const thread = (await call("GET", `/api/messages/${ann.id}`, null, bob.token)).data;
        assert.deepEqual(thread.messages.map((m) => m.body), ["Hallo Bob", "Kommst du morgen?"]);
        assert.equal(thread.canWrite, true);
        assert.equal((await call("GET", "/api/inbox/unread", null, bob.token)).data.messages, 0);
    });

    test("strangers see nothing; the inbox is for beta members", async () => {
        const view = (await call("GET", `/api/messages/${bob.id}`, null, cleo.token)).data;
        assert.equal(view.canWrite, false);
        assert.equal(view.messages.length, 0);
        assert.equal((await call("GET", "/api/messages", null, dan.token)).status, 403);
    });

    test("admins broadcast to every account; notices can be read and deleted", async () => {
        assert.equal((await call("POST", "/api/admin/broadcasts", { title: "Hi", body: "Test" }, bob.token)).status, 403);
        assert.equal((await call("POST", "/api/admin/broadcasts", { title: "", body: "Test" }, ann.token)).status, 400);
        const accounts = (await sql("SELECT count(*)::int AS n FROM users"))[0].n;
        const sent = (await call("POST", "/api/admin/broadcasts", { title: "Neue Version", body: "Jetzt mit Wiederholungen." }, ann.token)).data;
        assert.equal(sent.recipientCount, accounts);
        assert.equal((await call("GET", "/api/admin/broadcasts", null, ann.token)).data[0].admin, "inboxann");

        const notices = (await call("GET", "/api/notifications", null, cleo.token)).data;
        assert.equal(notices[0].title, "Neue Version");
        assert.equal((await call("GET", "/api/inbox/unread", null, cleo.token)).data.notifications, 1);
        await call("POST", "/api/notifications/read", null, cleo.token);
        assert.equal((await call("GET", "/api/inbox/unread", null, cleo.token)).data.notifications, 0);
        assert.equal((await call("DELETE", `/api/notifications/${notices[0].id}`, null, bob.token)).status, 404, "not someone else's");
        assert.equal((await call("DELETE", `/api/notifications/${notices[0].id}`, null, cleo.token)).status, 200);
    });
});

describe("real time (Socket.IO)", () => {
    let ann, bob, cleo, dan;
    const sockets = [];

    // a signed-in socket; rejects with the server's reason when it isn't let in
    const connect = (token) => new Promise((resolve, reject) => {
        const socket = io(API, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
        sockets.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (err) => reject(err));
    });
    // the next `event` on the socket, or a failure after a while
    const next = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
        socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
    });
    // nothing arrives (for the things that must not be sent)
    const silent = (socket, event, ms = 300) => new Promise((resolve, reject) => {
        const handler = () => reject(new Error(`unexpected ${event}`));
        socket.once(event, handler);
        setTimeout(() => { socket.off(event, handler); resolve(); }, ms);
    });
    const join = (socket, sessionId) => new Promise((resolve) => socket.emit("session:join", sessionId, resolve));

    before(async () => {
        ann = await member("liveann", { admin: true });
        bob = await member("livebob");
        cleo = await member("livecleo");
        dan = await member("livedan", { pro: false });
        await befriend(ann, bob, "livebob");
    });
    after(() => { for (const socket of sockets) socket.disconnect(); });

    test("only signed-in beta members get a connection", async () => {
        await assert.rejects(connect(""), { message: "UNAUTHORIZED" });
        await assert.rejects(connect("not-a-token"), { message: "UNAUTHORIZED" });
        await assert.rejects(connect(dan.token), { message: "UNAUTHORIZED" }, "no pro, no live data");
        assert.ok((await connect(bob.token)).connected);
    });

    test("a direct message reaches the friend and my other tabs right away", async () => {
        const bobLive = await connect(bob.token);
        const annOtherTab = await connect(ann.token);
        const cleoLive = await connect(cleo.token);

        const [toBob, toAnn] = await Promise.all([
            next(bobLive, "message:new"),
            next(annOtherTab, "message:new"),
            silent(cleoLive, "message:new"),
            call("POST", `/api/messages/${bob.id}`, { body: "Live?" }, ann.token),
        ]);
        assert.equal(toBob.user.id, ann.id);
        assert.equal(toBob.message.body, "Live?");
        assert.equal(toBob.message.fromMe, false);
        assert.equal(toAnn.user.id, bob.id);
        assert.equal(toAnn.message.fromMe, true);
        assert.equal(toAnn.message.id, toBob.message.id);

        // reading it in the open conversation updates my other tabs' badges
        const bobOtherTab = await connect(bob.token);
        const [read] = await Promise.all([
            next(bobOtherTab, "inbox:read"),
            call("POST", `/api/messages/${ann.id}/read`, null, bob.token),
        ]);
        assert.equal(read.userId, ann.id);
        assert.equal((await call("GET", "/api/inbox/unread", null, bob.token)).data.messages, 0);
    });

    test("a broadcast reaches everybody online with their own notice", async () => {
        const cleoLive = await connect(cleo.token);
        const [notice] = await Promise.all([
            next(cleoLive, "notification:new"),
            call("POST", "/api/admin/broadcasts", { title: "Live", body: "Sofort da." }, ann.token),
        ]);
        assert.equal(notice.title, "Live");
        assert.equal(notice.readAt, null);
        const stored = (await call("GET", "/api/notifications", null, cleo.token)).data;
        assert.equal(stored[0].id, notice.id, "the id cleo can delete");
    });

    test("a shared session's chat only reaches its members", async () => {
        const session = (await call("POST", "/api/shared-sessions", { name: "Live lernen", friendIds: [bob.id] }, ann.token)).data;
        const bobLive = await connect(bob.token);
        const cleoLive = await connect(cleo.token);

        assert.deepEqual(await join(bobLive, session.id), { ok: false }, "only invited, not joined yet");
        assert.deepEqual(await join(cleoLive, session.id), { ok: false });
        await call("POST", `/api/shared-sessions/${session.id}/join`, null, bob.token);
        assert.deepEqual(await join(bobLive, session.id), { ok: true });

        const [live] = await Promise.all([
            next(bobLive, "session:event"),
            silent(cleoLive, "session:event"),
            call("POST", `/api/shared-sessions/${session.id}/messages`, { text: "Los geht's" }, ann.token),
        ]);
        assert.equal(live.sessionId, session.id);
        assert.equal(live.event.type, "message");
        assert.equal(live.event.text, "Los geht's");
        assert.equal(live.event.user.id, ann.id);

        // once bob left, the chat stops reaching him
        await call("DELETE", `/api/shared-sessions/${session.id}/members/me`, null, bob.token);
        await Promise.all([
            silent(bobLive, "session:event"),
            call("POST", `/api/shared-sessions/${session.id}/messages`, { text: "Noch da?" }, ann.token),
        ]);
    });

    test("changes reach the people concerned; plain time reports don't", async () => {
        const annLive = await connect(ann.token);
        const bobLive = await connect(bob.token);
        const cleoLive = await connect(cleo.token);

        // an invite reaches the invitee's list
        const [, created] = await Promise.all([
            next(bobLive, "invites:changed"),
            call("POST", "/api/shared-sessions", { name: "Signale", friendIds: [bob.id] }, ann.token),
        ]);
        const sessionId = created.data.id;

        // joining tells the members
        const [joined] = await Promise.all([
            next(annLive, "session:changed"),
            call("POST", `/api/shared-sessions/${sessionId}/join`, null, bob.token),
        ]);
        assert.equal(joined.sessionId, sessionId);

        // a new task: every member, nobody else
        const [, , added] = await Promise.all([
            next(bobLive, "session:changed"),
            silent(cleoLive, "session:changed"),
            call("POST", `/api/shared-sessions/${sessionId}/tasks`, { name: "Folien" }, ann.token),
        ]);
        const taskId = added.data.tasks[0].id;

        // starting work is news for the others, the time reports while working are not
        await Promise.all([
            next(annLive, "session:changed"),
            call("POST", `/api/shared-sessions/${sessionId}/activity`, { currentTaskId: taskId }, bob.token),
        ]);
        await sleep(1100);
        await Promise.all([
            silent(annLive, "session:changed", 500),
            call("POST", `/api/shared-sessions/${sessionId}/activity`, { currentTaskId: taskId, time: { taskId, ms: 1000 } }, bob.token),
        ]);
        // stopping is news again
        await Promise.all([
            next(annLive, "session:changed"),
            call("POST", `/api/shared-sessions/${sessionId}/activity`, { currentTaskId: null }, bob.token),
        ]);

        // the one who leaves hears it too (their page notices it's gone)
        await Promise.all([
            next(bobLive, "session:changed"),
            next(annLive, "session:changed"),
            call("DELETE", `/api/shared-sessions/${sessionId}/members/me`, null, bob.token),
        ]);
    });

    test("a task given to me in a session lands in my inbox", async () => {
        const created = (await call("POST", "/api/shared-sessions", { name: "Zuweisen", friendIds: [bob.id] }, ann.token)).data;
        await call("POST", `/api/shared-sessions/${created.id}/join`, null, bob.token);
        const taskId = (await call("POST", `/api/shared-sessions/${created.id}/tasks`, { name: "Folien" }, ann.token)).data.tasks[0].id;
        const bobLive = await connect(bob.token);
        const annLive = await connect(ann.token);
        const unreadBefore = (await call("GET", "/api/inbox/unread", null, bob.token)).data.notifications;

        const [notice] = await Promise.all([
            next(bobLive, "notification:new"),
            call("PATCH", `/api/shared-sessions/${created.id}/tasks/${taskId}`, { assigneeId: bob.id }, ann.token),
        ]);
        assert.equal(notice.kind, "task_assigned");
        assert.equal(notice.title, "Folien");
        assert.equal(notice.body, "Zuweisen");
        assert.equal(notice.data.sessionId, created.id);
        assert.equal(notice.data.taskId, taskId);
        assert.equal(notice.data.by.id, ann.id);
        const stored = (await call("GET", "/api/notifications", null, bob.token)).data;
        assert.equal(stored[0].id, notice.id);
        assert.deepEqual(stored[0].data, notice.data);
        assert.equal((await call("GET", "/api/inbox/unread", null, bob.token)).data.notifications, unreadBefore + 1);

        // taking a task myself, or the same person again, is no news
        await Promise.all([
            silent(bobLive, "notification:new", 500),
            call("PATCH", `/api/shared-sessions/${created.id}/tasks/${taskId}`, { assigneeId: bob.id }, ann.token),
        ]);
        await Promise.all([
            silent(annLive, "notification:new", 500),
            call("PATCH", `/api/shared-sessions/${created.id}/tasks/${taskId}`, { assigneeId: ann.id }, ann.token),
        ]);
    });

    test("friend requests and shared tasks reach the other side", async () => {
        const bobLive = await connect(bob.token);
        const cleoLive = await connect(cleo.token);

        const [, request] = await Promise.all([
            next(cleoLive, "friends:changed"),
            call("POST", "/api/friends/requests", { username: "livecleo" }, bob.token),
        ]);
        await Promise.all([
            next(bobLive, "friends:changed"),
            call("POST", `/api/friends/requests/${request.data.request.id}/accept`, null, cleo.token),
        ]);

        const task = (await call("POST", "/api/tasks", { name: "Zusammen lernen" }, bob.token)).data;
        const taskId = task.id;
        const [changed] = await Promise.all([
            next(cleoLive, "tasks:changed"),
            call("POST", `/api/tasks/${taskId}/shares`, { userIds: [cleo.id] }, bob.token),
        ]);
        assert.equal(changed.taskId, taskId);
        // my own tasks that nobody else has stay quiet
        const own = (await call("POST", "/api/tasks", { name: "Nur meins" }, bob.token)).data;
        await Promise.all([
            silent(cleoLive, "tasks:changed"),
            call("DELETE", `/api/tasks/${own.id}`, null, bob.token),
        ]);
    });

    test("signing out everywhere closes the open connections", async () => {
        const cleoLive = await connect(cleo.token);
        const [reason] = await Promise.all([
            next(cleoLive, "disconnect"),
            call("POST", "/api/users/logout-all", null, cleo.token),
        ]);
        assert.equal(reason, "io server disconnect");
        await assert.rejects(connect(cleo.token), { message: "UNAUTHORIZED" }, "the old token doesn't work any more");
    });
});

describe("the account check is cached, but changes still count at once", () => {
    test("taking pro away, signing out everywhere and a new password work on the very next request", async () => {
        const boss = await member("cacheboss", { admin: true });
        const eve = await member("cacheeve");
        // warm the cache
        assert.equal((await call("GET", "/api/tasks", null, eve.token)).status, 200);

        await call("PATCH", `/api/admin/users/${eve.id}`, { isPro: false }, boss.token);
        assert.equal((await call("GET", "/api/tasks", null, eve.token)).data.code, "PRO_REQUIRED");
        await call("PATCH", `/api/admin/users/${eve.id}`, { isPro: true }, boss.token);
        assert.equal((await call("GET", "/api/tasks", null, eve.token)).status, 200);

        const changed = await call("PUT", "/api/users/password", { currentPassword: PW, newPassword: "An0ther-secret!" }, eve.token);
        assert.equal((await call("GET", "/api/tasks", null, eve.token)).data.code, "TOKEN_REVOKED", "the old token");
        const fresh = changed.data.token;
        assert.equal((await call("GET", "/api/tasks", null, fresh)).status, 200);

        await call("POST", "/api/users/logout-all", null, fresh);
        assert.equal((await call("GET", "/api/tasks", null, fresh)).data.code, "TOKEN_REVOKED");
    });

    test("the indexes for the frequent queries exist", async () => {
        const names = (await sql("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).map(row => row.indexname);
        for (const index of ["tasks_user_idx", "groups_user_idx", "task_groups_group_idx", "messages_unread_idx", "notifications_unread_idx"]) {
            assert.ok(names.includes(index), index);
        }
    });
});

describe("testers", () => {
    test("admins make testers; a broadcast can go only to testers and admins", async () => {
        const boss = await member("testboss", { admin: true });
        const tina = await member("testtina");
        const paul = await member("testpaul");

        assert.equal((await call("GET", "/api/me", null, tina.token)).data.isTester, false);
        assert.equal((await call("GET", "/api/me", null, boss.token)).data.isTester, true, "admins always count as testers");
        assert.equal((await call("PATCH", `/api/admin/users/${tina.id}`, { isTester: true }, paul.token)).status, 403);
        assert.equal((await call("PATCH", `/api/admin/users/${tina.id}`, { isTester: "yes" }, boss.token)).status, 400);

        const made = await call("PATCH", `/api/admin/users/${tina.id}`, { isTester: true }, boss.token);
        assert.equal(made.status, 200);
        assert.equal(made.data.isTester, true);
        assert.equal((await call("GET", "/api/me", null, tina.token)).data.isTester, true);
        const overview = (await call("GET", "/api/admin/overview", null, boss.token)).data;
        assert.ok(overview.testers >= 1);
        assert.equal(overview.actions[0].action, "grant_tester");

        assert.equal((await call("POST", "/api/admin/broadcasts", { title: "Beta", body: "Neu", audience: "friends" }, boss.token)).status, 400);
        const expected = (await sql("SELECT count(*)::int AS n FROM users WHERE is_tester OR is_admin"))[0].n;
        const sent = (await call("POST", "/api/admin/broadcasts", { title: "Nur Tester", body: "Probier das aus.", audience: "testers" }, boss.token)).data;
        assert.equal(sent.audience, "testers");
        assert.equal(sent.recipientCount, expected);
        assert.equal((await call("GET", "/api/admin/broadcasts", null, boss.token)).data[0].audience, "testers");
        assert.ok((await call("GET", "/api/notifications", null, tina.token)).data.some(n => n.title === "Nur Tester"));
        assert.ok(!(await call("GET", "/api/notifications", null, paul.token)).data.some(n => n.title === "Nur Tester"));

        await call("PATCH", `/api/admin/users/${tina.id}`, { isTester: false }, boss.token);
        assert.equal((await call("GET", "/api/me", null, tina.token)).data.isTester, false);
    });

    test("being a tester is enough to use the app, without pro", async () => {
        const boss = await member("accessboss", { admin: true });
        const tom = await member("accesstom", { pro: false });
        assert.equal((await call("GET", "/api/tasks", null, tom.token)).data.code, "PRO_REQUIRED");
        assert.equal((await call("POST", "/api/beta-requests", { reason: "Ich möchte gern mittesten." }, tom.token)).status, 201);

        const made = (await call("PATCH", `/api/admin/users/${tom.id}`, { isTester: true }, boss.token)).data;
        assert.equal(made.request.status, "approved", "an open request is answered");
        assert.equal((await call("GET", "/api/tasks", null, tom.token)).status, 200);
        const me = (await call("GET", "/api/me", null, tom.token)).data;
        assert.equal(me.isPro, true, "may use the app");
        assert.equal(me.isTester, true);
        assert.equal((await call("GET", "/api/admin/users", null, tom.token)).status, 403, "still no admin");

        await call("PATCH", `/api/admin/users/${tom.id}`, { isTester: false }, boss.token);
        assert.equal((await call("GET", "/api/tasks", null, tom.token)).data.code, "PRO_REQUIRED");
        assert.equal((await call("GET", "/api/me", null, tom.token)).data.isPro, false);
    });

    test("routes under /api/tester are only for testers and admins", async () => {
        const boss = await member("routeboss", { admin: true });
        const rita = await member("routerita", { pro: false });
        const pia = await member("routepia");
        await sql("UPDATE users SET is_tester = true WHERE username = 'routerita'");

        assert.equal((await call("GET", "/api/tester/anything")).status, 401);
        const refused = await call("GET", "/api/tester/anything", null, pia.token);
        assert.equal(refused.status, 403, "pro alone isn't enough");
        assert.equal(refused.data.code, "TESTER_REQUIRED");
        // past the check (there is no such route yet)
        assert.equal((await call("GET", "/api/tester/anything", null, rita.token)).status, 404);
        assert.equal((await call("GET", "/api/tester/anything", null, boss.token)).status, 404);
    });
});

describe("owners", () => {
    test("stay admin, can't be demoted, and is_owner never leaves the server", async () => {
        const boss = await member("ownerboss", { admin: true });
        const other = await member("owneradmin", { admin: true });
        await sql("UPDATE users SET is_owner = true WHERE username = 'ownerboss'");

        const demote = await call("PATCH", `/api/admin/users/${boss.id}`, { isAdmin: false }, other.token);
        assert.equal(demote.status, 403);
        assert.equal(demote.data.code, "OWNER");
        // the database keeps it on even when written directly
        await sql("UPDATE users SET is_admin = false WHERE username = 'ownerboss'");
        const me = (await call("GET", "/api/me", null, boss.token)).data;
        assert.equal(me.isAdmin, true);

        const responses = JSON.stringify([
            me,
            (await call("GET", "/api/admin/users", null, other.token)).data,
            (await call("GET", "/api/users", null, boss.token)).data,
        ]);
        assert.ok(!/is_owner|isOwner/.test(responses));

        await sql("UPDATE users SET is_owner = false WHERE username = 'ownerboss'");
    });

    test("every account has an email address", async () => {
        await member("mailless");
        await assert.rejects(sql("UPDATE users SET email = NULL WHERE username = 'mailless'"));
    });
});

describe("profiles and statistics", () => {
    // a session on a day relative to today, at noon in Berlin (stored like the app stores them)
    const sessionOn = (userId, daysAgo, ms) => sql(
        `INSERT INTO sessions (user_id, time_ms, date)
        VALUES ($1, $2, (((now() AT TIME ZONE 'Europe/Berlin')::date - $3::int) + time '12:00') AT TIME ZONE 'Europe/Berlin')`,
        [userId, ms, daysAgo]
    );

    test("I set up my profile; wrong values are refused", async () => {
        const pam = await member("profpam");
        const saved = await call("PUT", "/api/profile", {
            bio: "  Ich lerne gern früh.  ", status: "Mathe-Klausur am Freitag", study: "Informatik, 3. Semester",
            interests: ["Mathe", "mathe", " Physik ", ""], color: "teal", banner: "aurora", emoji: "📚", showStats: true,
        }, pam.token);
        assert.equal(saved.status, 200, JSON.stringify(saved.data));
        assert.equal(saved.data.relation, "self");
        assert.equal(saved.data.bio, "Ich lerne gern früh.");
        assert.deepEqual(saved.data.interests, ["Mathe", "Physik"], "trimmed, empty and doubled tags dropped");
        assert.equal(saved.data.color, "teal");
        assert.equal(saved.data.banner, "aurora");
        assert.equal(saved.data.emoji, "📚");
        assert.equal(saved.data.showStats, true);
        assert.ok(saved.data.stats, "I always see my own numbers");

        for (const [body, field] of [
            [{ color: "black" }, "color"], [{ banner: "photo" }, "banner"], [{ emoji: "X" }, "emoji"],
            [{ bio: "x".repeat(281) }, "bio"], [{ status: 5 }, "status"],
            [{ interests: ["a", "b", "c", "d", "e", "f", "g"] }, "interests"], [{ interests: "Mathe" }, "interests"],
            [{ interests: ["x".repeat(25)] }, "interests"], [{ showStats: "yes" }, "showStats"],
        ]) {
            const r = await call("PUT", "/api/profile", body, pam.token);
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal(r.data.field, field);
        }

        // only what is sent changes; null and "" clear
        const partial = (await call("PUT", "/api/profile", { study: "", color: null }, pam.token)).data;
        assert.equal(partial.study, null);
        assert.equal(partial.color, null);
        assert.equal(partial.bio, "Ich lerne gern früh.");
        assert.equal((await call("GET", "/api/profile", null, pam.token)).data.banner, "aurora");
    });

    test("strangers only see the names, friends see the profile, mutual friends and statistics", async () => {
        const pia = await member("profpia");
        const quinn = await member("profquinn");
        const viktor = await member("profviktor");
        const rex = await member("profrex");
        await befriend(pia, quinn, "profquinn");
        await befriend(pia, viktor, "profviktor");
        await befriend(quinn, viktor, "profviktor");
        await call("PUT", "/api/profile", { bio: "Hallo!", status: "Lernt Bio", emoji: "🦊", color: "violet", banner: "dots" }, pia.token);

        const stranger = await call("GET", "/api/profiles/PROFPIA", null, rex.token);
        assert.equal(stranger.status, 200, "the username is found in any case");
        assert.deepEqual(Object.keys(stranger.data).sort(), ["displayName", "id", "relation", "username"]);
        assert.equal(stranger.data.relation, "none");

        const friend = (await call("GET", "/api/profiles/@profpia", null, quinn.token)).data;
        assert.equal(friend.relation, "friend");
        assert.equal(friend.bio, "Hallo!");
        assert.equal(friend.emoji, "🦊");
        assert.ok(friend.friendsSince);
        assert.ok(friend.stats);
        assert.equal(friend.showStats, undefined, "the switch itself stays mine");
        assert.equal(friend.mutualFriendCount, 1);
        assert.deepEqual(friend.mutualFriends.map(m => m.username), ["profviktor"]);
        for (const data of [stranger.data, friend]) {
            const text = JSON.stringify(data);
            assert.ok(!text.includes("@example.com") && !text.includes("1995"), "never email or birth date");
        }

        // the friends list carries the avatar and status, for the rows on the Social page
        const listed = (await call("GET", "/api/friends", null, quinn.token)).data.find(f => f.username === "profpia");
        assert.deepEqual([listed.emoji, listed.color, listed.status], ["🦊", "violet", "Lernt Bio"]);

        // an open request shows from both sides, with its id
        const sent = await call("POST", "/api/friends/requests", { username: "profpia" }, rex.token);
        const out = (await call("GET", "/api/profiles/profpia", null, rex.token)).data;
        assert.deepEqual([out.relation, out.requestId, out.bio], ["outgoing", sent.data.request.id, undefined]);
        const incoming = (await call("GET", "/api/profiles/profrex", null, pia.token)).data;
        assert.deepEqual([incoming.relation, incoming.requestId, incoming.stats], ["incoming", sent.data.request.id, undefined]);

        // statistics can be hidden from friends
        await call("PUT", "/api/profile", { showStats: false }, pia.token);
        assert.equal((await call("GET", "/api/profiles/profpia", null, quinn.token)).data.stats, null);
        const own = (await call("GET", "/api/profile", null, pia.token)).data;
        assert.equal(own.showStats, false);
        assert.ok(own.stats);
    });

    test("statistics count days in the user's timezone: streaks, best day, groups", async () => {
        const sam = await member("profsam");
        await sql("UPDATE users SET timezone = 'Europe/Berlin' WHERE id = $1", [sam.id]);
        await sessionOn(sam.id, 0, 1_500_000);
        await sessionOn(sam.id, 1, 900_000);
        await sessionOn(sam.id, 3, 1_200_000);
        await sessionOn(sam.id, 3, 1_800_000);
        await call("POST", "/api/groups", { name: "Mathe", description: "" }, sam.token);
        assert.equal((await call("POST", "/api/sessions", { totalTime: 600, workedTasks: [], group: "Mathe" }, sam.token)).status, 201);
        await sql("INSERT INTO tasks (name, user_id, done, completed_at) VALUES ('Blatt 3', $1, true, now())", [sam.id]);

        const stats = (await call("GET", "/api/profile", null, sam.token)).data.stats;
        assert.equal(stats.totalMs, 6_000_000);
        assert.equal(stats.sessions, 5);
        assert.equal(stats.activeDays, 3);
        assert.equal(stats.currentStreak, 2);
        assert.equal(stats.longestStreak, 2);
        assert.equal(stats.longestSessionMs, 1_800_000);
        assert.equal(stats.avgSessionMs, 1_200_000);
        assert.equal(stats.todayMs, 2_100_000);
        assert.equal(stats.weekMs, 6_000_000);
        assert.equal(stats.lastWeekMs, 0);
        assert.equal(stats.daily.length, 182);
        assert.equal(stats.daily.at(-1), 2_100_000);
        assert.equal(stats.daily.at(-4), 3_000_000);
        assert.equal(stats.bestDay.ms, 3_000_000);
        assert.equal(stats.weekdays.reduce((a, b) => a + b, 0), 6_000_000);
        assert.notEqual(stats.favoriteTime, null);
        assert.deepEqual(stats.topGroups.map(g => [g.name, g.ms]), [["Mathe", 600_000]]);
        assert.equal(stats.tasksDone, 1);
        assert.equal(stats.tasksDoneWeek, 1);

        // a streak that ended yesterday still counts today; after a gap it's gone
        const tim = await member("proftim");
        await sessionOn(tim.id, 1, 60_000);
        await sessionOn(tim.id, 2, 60_000);
        assert.equal((await call("GET", "/api/profile", null, tim.token)).data.stats.currentStreak, 2);
        await sql("DELETE FROM sessions WHERE user_id = $1", [tim.id]);
        await sessionOn(tim.id, 2, 60_000);
        const later = (await call("GET", "/api/profile", null, tim.token)).data.stats;
        assert.deepEqual([later.currentStreak, later.longestStreak], [0, 1]);
    });

    test("needs a login and app access; unknown names are 404", async () => {
        const una = await member("profuna");
        const out = await member("profout", { pro: false });
        assert.equal((await call("GET", "/api/profiles/profuna")).status, 401);
        assert.equal((await call("GET", "/api/profiles/profuna", null, out.token)).data.code, "PRO_REQUIRED");
        assert.equal((await call("PUT", "/api/profile", { bio: "x" }, out.token)).data.code, "PRO_REQUIRED");
        const missing = await call("GET", "/api/profiles/nobody_here", null, una.token);
        assert.deepEqual([missing.status, missing.data.code], [404, "USER_NOT_FOUND"]);
    });
});

describe("Quidey Family (testers only)", () => {
    let mia, leo, ida, kai;
    const F = "/api/tester/families";
    const sockets = [];
    const connect = (token) => new Promise((resolve, reject) => {
        const socket = io(API, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
        sockets.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (err) => reject(err));
    });
    const next = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
        socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
    });
    const silent = (socket, event, ms = 300) => new Promise((resolve, reject) => {
        const handler = () => reject(new Error(`unexpected ${event}`));
        socket.once(event, handler);
        setTimeout(() => { socket.off(event, handler); resolve(); }, ms);
    });

    before(async () => {
        mia = await member("fammia");
        leo = await member("famleo");
        ida = await member("famida");
        kai = await member("famkai");
        await sql("UPDATE users SET is_tester = true WHERE username IN ('fammia', 'famleo', 'famida')");
        await befriend(mia, leo, "famleo");
        await befriend(mia, ida, "famida");
    });
    after(() => { for (const socket of sockets) socket.disconnect(); });

    test("only testers get in", async () => {
        assert.equal((await call("GET", F, null, kai.token)).data.code, "TESTER_REQUIRED");
        assert.equal((await call("POST", F, { name: "Nope" }, kai.token)).status, 403);
    });

    test("a family invites friends only; invites are joined or declined", async () => {
        assert.equal((await call("POST", F, { name: "  " }, mia.token)).data.code, "NAME_REQUIRED");
        const created = await call("POST", F, { name: "Familie Berg", friendIds: [leo.id, kai.id] }, mia.token);
        assert.equal(created.status, 201);
        const family = created.data;
        assert.equal(family.isOwner, true);
        assert.deepEqual(family.people.map(p => [p.user.id, p.status]), [[mia.id, "joined"], [leo.id, "invited"]], "kai is no friend");

        assert.equal((await call("GET", `${F}/${family.id}`, null, leo.token)).status, 404, "not joined yet");
        assert.equal((await call("GET", F, null, leo.token)).data.invites[0].invitedBy.id, mia.id);
        const joined = await call("POST", `${F}/${family.id}/join`, null, leo.token);
        assert.equal(joined.status, 200);
        assert.equal(joined.data.isOwner, false);
        assert.equal((await call("GET", F, null, leo.token)).data.families[0].memberCount, 2);

        // ida declines
        assert.equal((await call("POST", `${F}/${family.id}/invites`, { userIds: [ida.id] }, mia.token)).status, 200);
        assert.equal((await call("POST", `${F}/${family.id}/invites`, { userIds: [ida.id] }, mia.token)).data.code, "NOTHING_TO_INVITE");
        assert.equal((await call("DELETE", `${F}/${family.id}/members/me`, null, ida.token)).status, 200);
        assert.equal((await call("GET", F, null, ida.token)).data.invites.length, 0);
        assert.equal((await call("POST", `${F}/${family.id}/join`, null, ida.token)).status, 404);
    });

    test("the shared calendar: everybody adds and changes, only the adder or owner removes", async () => {
        const family = (await call("GET", F, null, mia.token)).data.families.find(f => f.name === "Familie Berg");
        const day = daysFromToday(3);
        assert.equal((await call("POST", `${F}/${family.id}/tasks`, { name: "Arzt", due_time: "10:00" }, leo.token)).data.field, "due_time");
        assert.equal((await call("POST", `${F}/${family.id}/tasks`, { name: "Arzt", color: "plaid" }, leo.token)).data.field, "color");
        const added = await call("POST", `${F}/${family.id}/tasks`, { name: "Arzt", due: day, due_time: "10:00", location: "Praxis" }, leo.token);
        assert.equal(added.status, 201);
        const entry = added.data.tasks[0];
        assert.equal(entry.due_time, "10:00");
        assert.equal(entry.addedBy.id, leo.id);

        const moved = await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, { due: daysFromToday(4), done: true }, mia.token);
        assert.equal(moved.data.tasks[0].done, true);
        assert.equal(moved.data.tasks[0].due_time, "10:00", "the time stays with a new day");
        const undated = await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, { due: null }, mia.token);
        assert.equal(undated.data.tasks[0].due_time, null, "no day, no time");
        assert.equal((await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, {}, mia.token)).data.code, "NOTHING_TO_CHANGE");
        assert.equal((await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, { done: true }, kai.token)).status, 403);

        const mine = (await call("POST", `${F}/${family.id}/tasks`, { name: "Einkaufen", due: day }, mia.token)).data.tasks.find(t => t.name === "Einkaufen");
        assert.equal((await call("DELETE", `${F}/${family.id}/tasks/${mine.id}`, null, leo.token)).data.code, "NOT_ALLOWED");
        assert.equal((await call("DELETE", `${F}/${family.id}/tasks/${entry.id}`, null, mia.token)).status, 200, "the owner may");
        assert.equal((await call("DELETE", `${F}/${family.id}/tasks/${mine.id}`, null, mia.token)).data.tasks.length, 0);
    });

    test("the chat and changes reach the members live, nobody else", async () => {
        const family = (await call("GET", F, null, mia.token)).data.families.find(f => f.name === "Familie Berg");
        const leoLive = await connect(leo.token);
        const kaiLive = await connect(kai.token);
        assert.equal((await call("POST", `${F}/${family.id}/messages`, { text: "  " }, mia.token)).data.code, "TEXT_REQUIRED");
        const [live, sent] = await Promise.all([
            next(leoLive, "family:message"),
            call("POST", `${F}/${family.id}/messages`, { text: "Essen um 7?" }, mia.token),
            silent(kaiLive, "family:message"),
        ]);
        assert.equal(sent.status, 201);
        assert.equal(live.familyId, family.id);
        assert.equal(live.message.text, "Essen um 7?");
        assert.equal(live.message.user.id, mia.id);
        const [changed] = await Promise.all([
            next(leoLive, "family:changed"),
            call("POST", `${F}/${family.id}/tasks`, { name: "Kino" }, mia.token),
        ]);
        assert.equal(changed.familyId, family.id);

        const chat = (await call("GET", `${F}/${family.id}/messages`, null, leo.token)).data;
        assert.equal(chat.messages.at(-1).text, "Essen um 7?");
        assert.equal(chat.hasMore, false);
        assert.equal((await call("GET", `${F}/${family.id}/messages?before=x`, null, leo.token)).status, 400);
        assert.equal((await call("GET", `${F}/${family.id}/messages`, null, ida.token)).status, 404, "not a member");
    });

    test("only the owner renames, removes and deletes; the owner can't leave", async () => {
        const family = (await call("GET", F, null, mia.token)).data.families.find(f => f.name === "Familie Berg");
        assert.equal((await call("PATCH", `${F}/${family.id}`, { name: "Bergs" }, leo.token)).data.code, "NOT_OWNER");
        assert.equal((await call("PATCH", `${F}/${family.id}`, { name: "Bergs" }, mia.token)).data.name, "Bergs");
        assert.equal((await call("DELETE", `${F}/${family.id}/members/me`, null, mia.token)).data.code, "OWNER_CANNOT_LEAVE");
        assert.equal((await call("DELETE", `${F}/${family.id}/members/${mia.id}`, null, leo.token)).data.code, "NOT_OWNER");
        assert.equal((await call("DELETE", `${F}/${family.id}`, null, leo.token)).data.code, "NOT_OWNER");
        assert.equal((await call("DELETE", `${F}/${family.id}/members/${leo.id}`, null, mia.token)).status, 200);
        assert.equal((await call("GET", `${F}/${family.id}`, null, leo.token)).status, 404);
        assert.equal((await call("DELETE", `${F}/${family.id}`, null, mia.token)).status, 200);
        assert.equal((await sql("SELECT count(*)::int AS n FROM family_tasks WHERE family_id = $1", [family.id]))[0].n, 0);
        assert.equal((await sql("SELECT count(*)::int AS n FROM family_messages WHERE family_id = $1", [family.id]))[0].n, 0);
    });

    test("a deleted owner hands the family on and takes their messages along", async () => {
        const owner = await member("famowner");
        await sql("UPDATE users SET is_tester = true WHERE username = 'famowner'");
        await befriend(owner, leo, "famleo");
        const family = (await call("POST", F, { name: "Erbe", friendIds: [leo.id] }, owner.token)).data;
        await call("POST", `${F}/${family.id}/join`, null, leo.token);
        await call("POST", `${F}/${family.id}/messages`, { text: "Hallo" }, owner.token);
        const alone = (await call("POST", F, { name: "Allein" }, owner.token)).data;

        assert.equal((await call("DELETE", "/api/users", { password: PW }, owner.token)).status, 200);
        const kept = (await call("GET", `${F}/${family.id}`, null, leo.token)).data;
        assert.equal(kept.owner.id, leo.id);
        assert.equal(kept.isOwner, true);
        assert.equal((await call("GET", `${F}/${family.id}/messages`, null, leo.token)).data.messages.length, 0);
        assert.equal((await sql("SELECT count(*)::int AS n FROM families WHERE id = $1", [alone.id]))[0].n, 0);
    });
});

describe("deleting an account", () => {
    test("needs the password; the last admin can't leave", async () => {
        const solo = await member("lastadmin", { admin: true });
        await sql("UPDATE users SET is_admin = false WHERE username <> 'lastadmin'");
        assert.equal((await call("DELETE", "/api/users", { password: "wrong-pass" }, solo.token)).data.code, "WRONG_PASSWORD");
        assert.equal((await call("DELETE", "/api/users", {}, solo.token)).status, 400);
        assert.equal((await call("DELETE", "/api/users", { password: PW }, solo.token)).data.code, "LAST_ADMIN");
    });

    test("takes tasks, groups, sessions, friendships, shared sessions, messages and notices along", async () => {
        const gone = await member("goner");
        const friend = await member("stayer");
        await befriend(gone, friend, "stayer");
        await call("POST", "/api/tasks", { name: "Steuer", prio: 50, due: daysFromToday(1), description: "" }, gone.token);
        await call("POST", "/api/groups", { name: "Arbeit", description: "" }, gone.token);
        await call("POST", "/api/event-types", { name: "Arbeit" }, gone.token);
        await call("POST", "/api/sessions", { totalTime: 1500, workedTasks: [], group: "Arbeit" }, gone.token);
        await call("POST", "/api/shared-sessions", { name: "Lerngruppe" }, gone.token);
        await call("POST", `/api/messages/${friend.id}`, { body: "Tschüss" }, gone.token);
        await call("POST", `/api/messages/${gone.id}`, { body: "Schade" }, friend.token);

        assert.equal((await call("DELETE", "/api/users", { password: PW }, gone.token)).status, 200);
        const [left] = await sql(
            `SELECT (SELECT count(*) FROM tasks WHERE user_id = $1) + (SELECT count(*) FROM groups WHERE user_id = $1)
                + (SELECT count(*) FROM sessions WHERE user_id = $1) + (SELECT count(*) FROM friendships WHERE requester_id = $1 OR addressee_id = $1)
                + (SELECT count(*) FROM shared_sessions WHERE owner_id = $1) + (SELECT count(*) FROM messages WHERE sender_id = $1 OR recipient_id = $1)
                + (SELECT count(*) FROM notifications WHERE user_id = $1) + (SELECT count(*) FROM event_types WHERE user_id = $1)
                + (SELECT count(*) FROM users WHERE id = $1) AS n`,
            [gone.id]
        );
        assert.equal(Number(left.n), 0);
        assert.equal((await call("GET", "/api/users", null, gone.token)).status, 401, "the old login stops working");
        assert.equal((await call("GET", "/api/messages", null, friend.token)).data.length, 0, "the friend's side is gone too");
        assert.equal((await register("goner", "goner@example.com")).status, 201, "name and address are free again");
    });
});
