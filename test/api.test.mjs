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
            RATE_LIMIT_REGISTER: "1000", RATE_LIMIT_AUTH: "1000", RATE_LIMIT_VERIFICATION_MAIL: "1000", RATE_LIMIT_API: "10000", REMINDER_CHECK_MS: "200", EVENT_CHECK_MS: "200", PRESENCE_GRACE_MS: "200",
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

    test("feedback can name another address to answer to", async () => {
        const bob = await member("fbreply");
        assert.equal((await call("POST", "/api/feedback", { category: "idea", message: "Mehr Farben bitte.", email: "kein-mail" }, bob.token)).data.code, "INVALID_EMAIL");
        assert.equal((await call("POST", "/api/feedback", { category: "idea", message: "Mehr Farben bitte.", email: "privat@example.org" }, bob.token)).status, 200);
        await sleep(100);
        assert.match(log, /@fbreply\)\nE-Mail: privat@example\.org/);
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

describe("repeats that end, and deleting repeating tasks", () => {
    let me;
    before(async () => { me = await member("serieser"); });
    const dueOf = async (id) => (await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1", [id]))[0]?.due;
    // the day as the app sends it (the API answers with a timestamp)
    const finish = (task, extra = {}) => call("PUT", `/api/tasks/${task.id}`, { ...task, due: iso(new Date(task.due)), done: true, ...extra }, me.token);
    const weekly = (extra = {}) => call("POST", "/api/tasks", { name: "Serie", prio: 50, due: daysFromToday(1), description: "", repeat: "weekly", ...extra }, me.token);

    test("an end only for something that repeats; it counts down and stops", async () => {
        assert.equal((await weekly({ repeat_left: -1 })).data.field, "repeat_left");
        const once = (await call("POST", "/api/tasks", { name: "Einmal", prio: 50, due: daysFromToday(1), description: "", repeat_left: 3 }, me.token)).data;
        assert.equal(once.repeat_left, null);

        const task = (await weekly({ repeat_left: 1 })).data;
        assert.equal(task.repeat_left, 1);
        const next = (await finish(task)).data.nextTask;
        assert.equal(next.repeat_left, 0);
        assert.equal(await dueOf(next.id), daysFromToday(8));
        const last = (await finish(next)).data;
        assert.equal(last.nextTask, undefined, "no repeats left");

        const plain = (await finish(task, { repeat: null })).data;
        assert.equal(plain.repeat_left, null, "not repeating takes the end along");
    });

    test("a coming repeat deleted on its own is jumped over and still counts", async () => {
        const task = (await weekly({ repeat_left: 3 })).data;
        const skipped = daysFromToday(8);
        const r = await call("DELETE", `/api/tasks/${task.id}?scope=one&occurrence=${skipped}`, null, me.token);
        assert.equal(r.status, 200);
        assert.deepEqual(r.data.task.repeat_skip, [skipped]);
        assert.equal((await call("DELETE", `/api/tasks/${task.id}?scope=one&occurrence=${daysFromToday(9)}`, null, me.token)).data.field, "occurrence");

        const next = (await finish(task)).data.nextTask;
        assert.equal(await dueOf(next.id), daysFromToday(15));
        assert.equal(next.repeat_left, 1);
        assert.deepEqual(next.repeat_skip, []);
    });

    test("'this and following' on a coming repeat ends the task before it", async () => {
        const task = (await weekly()).data;
        let r = await call("DELETE", `/api/tasks/${task.id}?scope=following&occurrence=${daysFromToday(22)}`, null, me.token);
        assert.equal(r.data.task.repeat_left, 2);
        assert.equal(r.data.task.repeat, "weekly");
        r = await call("DELETE", `/api/tasks/${task.id}?scope=following&occurrence=${daysFromToday(8)}`, null, me.token);
        assert.equal(r.data.task.repeat, null, "nothing left: it doesn't repeat any more");
        assert.ok(await dueOf(task.id), "the task itself stays");
    });

    test("deleting a real one: only this hands over, following and all take the row along", async () => {
        const first = (await call("POST", "/api/tasks", { name: "Kette", prio: 50, due: daysFromToday(-14), description: "", repeat: "weekly" }, me.token)).data;
        const second = (await finish(first)).data.nextTask;
        const third = (await finish(second)).data.nextTask;

        // only this one: the open one goes, its next one takes over
        let r = await call("DELETE", `/api/tasks/${third.id}?scope=one`, null, me.token);
        assert.deepEqual(r.data.deletedIds, [third.id]);
        const fourth = r.data.nextTask;
        assert.ok(fourth && !fourth.done);
        assert.equal(await dueOf(fourth.id), daysFromToday(14), "second today, third in a week, so the fourth in two");

        // this and the following: from the second on, the first stays
        r = await call("DELETE", `/api/tasks/${second.id}?scope=following`, null, me.token);
        assert.deepEqual(r.data.deletedIds, [second.id], "the fourth no longer hangs on the deleted third");
        assert.ok(await dueOf(first.id));

        // all of them
        const a = (await call("POST", "/api/tasks", { name: "Alle", prio: 50, due: daysFromToday(-7), description: "", repeat: "weekly" }, me.token)).data;
        const b = (await finish(a)).data.nextTask;
        const c = (await finish(b)).data.nextTask;
        r = await call("DELETE", `/api/tasks/${b.id}?scope=all`, null, me.token);
        assert.deepEqual(r.data.deletedIds.sort((x, y) => x - y), [a.id, b.id, c.id]);
        assert.equal((await call("DELETE", `/api/tasks/${a.id}?scope=sometimes`, null, me.token)).data?.field, "scope");
    });

    test("without a scope only this one goes, like before", async () => {
        const task = (await weekly()).data;
        const r = await call("DELETE", `/api/tasks/${task.id}`, null, me.token);
        assert.deepEqual(r.data.deletedIds, [task.id]);
        assert.equal(r.data.nextTask, undefined);
    });
});

describe("keywords of event types", () => {
    let me;
    before(async () => { me = await member("keyworder"); });

    test("are stored trimmed and without doubles, and can be changed", async () => {
        const type = (await call("POST", "/api/event-types", { name: "Arbeit", keywords: [" Arbeit ", "arbeit", "Schicht", ""] }, me.token)).data;
        assert.deepEqual(type.keywords, ["Arbeit", "Schicht"]);
        const changed = (await call("PUT", `/api/event-types/${type.id}`, { keywords: ["Job"] }, me.token)).data;
        assert.deepEqual(changed.keywords, ["Job"]);
        assert.deepEqual((await call("GET", "/api/event-types", null, me.token)).data[0].keywords, ["Job"]);
        assert.equal((await call("PUT", `/api/event-types/${type.id}`, { keywords: "Job" }, me.token)).data.field, "keywords");
        assert.equal((await call("POST", "/api/event-types", { name: "Viel", keywords: Array.from({ length: 21 }, (_, i) => `w${i}`) }, me.token)).data.field, "keywords");
        const plain = (await call("POST", "/api/event-types", { name: "Sport" }, me.token)).data;
        assert.deepEqual(plain.keywords, []);
    });
});

describe("events in a shared session", () => {
    let ann, bob, sessionId;
    before(async () => {
        ann = await member("sesevann");
        bob = await member("sesevbob");
        await befriend(ann, bob, "sesevbob");
        sessionId = (await call("POST", "/api/shared-sessions", { name: "Termine", friendIds: [bob.id] }, ann.token)).data.id;
        await call("POST", `/api/shared-sessions/${sessionId}/join`, null, bob.token);
    });
    const tasksPath = () => `/api/shared-sessions/${sessionId}/tasks`;
    const find = (session, name) => session.tasks.find(task => task.name === name);

    test("an event needs a day; tasks stay tasks by default", async () => {
        assert.equal((await call("POST", tasksPath(), { name: "Ohne Tag", kind: "event" }, ann.token)).data.field, "due");
        assert.equal((await call("POST", tasksPath(), { name: "Falsch", kind: "meeting" }, ann.token)).data.field, "kind");
        assert.equal(find((await call("POST", tasksPath(), { name: "Aufgabe" }, ann.token)).data, "Aufgabe").kind, "task");
    });

    test("is done once it is over, never by hand; moving it opens it again", async () => {
        const past = find((await call("POST", tasksPath(), { name: "Vorbei", kind: "event", due: daysFromToday(-1), due_time: "10:00", duration_minutes: 60 }, ann.token)).data, "Vorbei");
        assert.equal(past.kind, "event");
        assert.equal(past.done, true);
        const coming = find((await call("POST", tasksPath(), { name: "Bald", kind: "event", due: daysFromToday(2) }, ann.token)).data, "Bald");
        assert.equal(coming.done, false);
        assert.equal((await call("PATCH", `${tasksPath()}/${coming.id}`, { done: true }, bob.token)).data.code, "EVENT_NOT_DONE_BY_HAND");
        const moved = find((await call("PATCH", `${tasksPath()}/${past.id}`, { due: daysFromToday(3) }, bob.token)).data, "Vorbei");
        assert.equal(moved.done, false);
        assert.equal((await call("PATCH", `${tasksPath()}/${coming.id}`, { due: null }, bob.token)).data.field, "due");
    });

    test("one of my own events comes along as an event, with its type's colour", async () => {
        const type = (await call("POST", "/api/event-types", { name: "Vorlesung", color: "violet" }, ann.token)).data;
        const own = (await call("POST", "/api/tasks", { name: "Mathe", prio: 50, due: daysFromToday(4), description: "", kind: "event", event_type_id: type.id }, ann.token)).data;
        const shared = find((await call("POST", tasksPath(), { taskId: own.id }, ann.token)).data, "Mathe");
        assert.equal(shared.kind, "event");
        assert.equal(shared.color, "violet");
    });

    test("nobody works on an event, and it stays out of the list to work on", async () => {
        const event = find((await call("POST", tasksPath(), { name: "Treffen", kind: "event", due: daysFromToday(5) }, ann.token)).data, "Treffen");
        assert.equal((await call("POST", `/api/shared-sessions/${sessionId}/activity`, { currentTaskId: event.id }, bob.token)).data.code, "EVENT_NOT_WORKED");
        const mine = (await call("GET", "/api/shared-sessions/my-tasks", null, bob.token)).data.find(s => s.id === sessionId);
        assert.ok(mine.tasks.length > 0);
        assert.ok(!mine.tasks.some(task => task.name === "Treffen"));
    });

    test("family calendars don't take a kind", async () => {
        assert.equal((await sql("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'family_tasks' AND column_name = 'kind'"))[0].n, 0);
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

    test("testers rate and comment on what they test; admins see it together", async () => {
        const boss = await member("fbboss", { admin: true });
        const tina = await member("fbtina", { pro: false });
        const timo = await member("fbtimo", { pro: false });
        const paul = await member("fbpaul");
        await sql("UPDATE users SET is_tester = true WHERE username IN ('fbtina', 'fbtimo')");
        const F = "/api/tester/feedback";

        assert.equal((await call("GET", F, null, paul.token)).data.code, "TESTER_REQUIRED");
        assert.deepEqual((await call("GET", F, null, tina.token)).data, []);

        const saved = (await call("PUT", `${F}/ui:schulheft`, { rating: 4, comment: "  Ruhig und klar.  " }, tina.token)).data;
        assert.equal(saved.rating, 4);
        assert.equal(saved.comment, "Ruhig und klar.", "trimmed");
        // only the fields sent change
        const rated = (await call("PUT", `${F}/ui:schulheft`, { rating: 5 }, tina.token)).data;
        assert.equal(rated.comment, "Ruhig und klar.");
        assert.equal(rated.rating, 5);
        await call("PUT", `${F}/feature:family`, { comment: "Toll für die WG" }, tina.token);
        await call("PUT", `${F}/ui:schulheft`, { rating: 2 }, timo.token);
        await call("PUT", `${F}/ui:tafel`, { rating: 3 }, timo.token);
        assert.deepEqual((await call("GET", F, null, tina.token)).data.map(f => f.topic), ["feature:family", "ui:schulheft"]);

        // checks
        assert.equal((await call("PUT", `${F}/Not a topic`, { rating: 3 }, tina.token)).data.code, "INVALID_TOPIC");
        assert.equal((await call("PUT", `${F}/ui:x`, { rating: 6 }, tina.token)).data.code, "INVALID_RATING");
        assert.equal((await call("PUT", `${F}/ui:x`, { rating: 2.5 }, tina.token)).data.code, "INVALID_RATING");
        assert.equal((await call("PUT", `${F}/ui:x`, { comment: "x".repeat(2001) }, tina.token)).data.code, "INVALID_COMMENT");
        assert.equal((await call("PUT", `${F}/ui:x`, {}, tina.token)).data.code, "EMPTY_FEEDBACK");

        // both emptied: the entry is gone
        await call("PUT", `${F}/feature:family`, { comment: "   " }, tina.token);
        assert.deepEqual((await call("GET", F, null, tina.token)).data.map(f => f.topic), ["ui:schulheft"]);

        assert.equal((await call("GET", "/api/admin/tester-feedback", null, tina.token)).status, 403);
        const all = (await call("GET", "/api/admin/tester-feedback", null, boss.token)).data;
        const schulheft = all.topics.find(topic => topic.topic === "ui:schulheft");
        assert.equal(schulheft.ratings, 2);
        assert.equal(schulheft.average, 3.5);
        assert.deepEqual(schulheft.spread, [0, 1, 0, 0, 1]);
        assert.equal(schulheft.entries.find(e => e.user.username === "fbtina").comment, "Ruhig und klar.");
        assert.ok(all.testers >= 2);

        assert.equal((await call("DELETE", `${F}/ui:tafel`, null, timo.token)).status, 200);
        assert.deepEqual((await call("GET", F, null, timo.token)).data.map(f => f.topic), ["ui:schulheft"]);

        // gone with the account
        assert.equal((await call("DELETE", "/api/users", { password: PW }, timo.token)).status, 200);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tester_feedback WHERE user_id = $1", [timo.id]))[0].n, 0);
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
        // teal and aurora come with levels 4 and 8 (utils/progress.js)
        await sql("UPDATE users SET level = 10 WHERE id = $1", [pam.id]);
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
        await sql("UPDATE users SET level = 10 WHERE id = $1", [pia.id]);
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

describe("Quidey Family", () => {
    let mia, leo, ida, kai;
    const F = "/api/families";
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
        await befriend(mia, leo, "famleo");
        await befriend(mia, ida, "famida");
    });
    after(() => { for (const socket of sockets) socket.disconnect(); });

    test("everybody with access to the app gets in, no tester needed", async () => {
        assert.equal((await call("GET", F)).status, 401);
        const outsider = await member("famout", { pro: false });
        assert.equal((await call("GET", F, null, outsider.token)).data.code, "PRO_REQUIRED");
        assert.equal((await call("POST", F, { name: "Nope" }, outsider.token)).status, 403);
        assert.deepEqual((await call("GET", F, null, kai.token)).data, { families: [], invites: [] }, "pro without tester");
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
        assert.equal((await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, { done: true }, kai.token)).status, 404, "not in it");

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

describe("progress: XP, levels and challenges", () => {
    let pia, tom;
    before(async () => {
        pia = await member("pia");
        tom = await member("tom");
    });

    test("a new account starts at level 1 with three daily and two weekly challenges, none needing friends", async () => {
        const r = await call("GET", "/api/progress", null, pia.token);
        assert.equal(r.status, 200);
        assert.equal(r.data.level, 1);
        assert.equal(r.data.xp, 0);
        assert.equal(r.data.nextLevelXp, 150);
        assert.equal(r.data.daily.length, 3);
        assert.equal(r.data.weekly.length, 2);
        const social = ["together20", "cheer2", "togetherWeek", "cheer10"];
        assert.ok([...r.data.daily, ...r.data.weekly].every(c => !social.includes(c.id)), "nobody to cheer on or work with yet");
        assert.ok(r.data.daily.every(c => c.value === 0 && !c.done));
    });

    test("focus minutes and tasks give XP; the daily focus challenge completes once and is posted", async () => {
        await befriend(pia, tom, "tom");
        // 100 minutes: more than any daily focus goal (the first slot is always one)
        assert.equal((await call("POST", "/api/sessions", { totalTime: 100 * 60, workedTasks: [] }, pia.token)).status, 201);
        const task = (await call("POST", "/api/tasks", { name: "Lesen", prio: 1, due: daysFromToday(0), description: "" }, pia.token)).data;
        await call("PUT", `/api/tasks/${task.id}`, { ...task, done: true }, pia.token);

        const r = (await call("GET", "/api/progress", null, pia.token)).data;
        const focus = r.daily[0];
        assert.match(focus.id, /^focus/);
        assert.ok(focus.done);
        assert.equal(focus.value, focus.goal, "progress stops at the goal");
        assert.equal(r.sources.focus, 100);
        assert.equal(r.sources.tasks, 5);
        assert.ok(r.sources.challenges >= focus.xp);
        assert.equal(r.xp, r.sources.focus + r.sources.tasks + r.sources.challenges);

        const again = (await call("GET", "/api/progress", null, pia.token)).data;
        assert.equal(again.sources.challenges, r.sources.challenges, "completed once per period");
        const [{ n }] = await sql("SELECT count(*)::int AS n FROM challenge_completions WHERE user_id = $1 AND challenge = $2", [pia.id, focus.id]);
        assert.equal(n, 1);

        // the friend sees the day and the challenge in the feed
        const feed = (await call("GET", "/api/feed", null, tom.token)).data;
        const kinds = feed.entries.filter(e => e.user.id === pia.id).map(e => e.kind);
        assert.ok(kinds.includes("day"));
        assert.ok(kinds.includes("challenge"));
        const day = feed.entries.find(e => e.kind === "day");
        assert.equal(day.data.focusMs, 100 * 60 * 1000);
        assert.equal(day.data.tasksDone, 1);
    });

    test("reaching a level is stored and announced once", async () => {
        await sql("INSERT INTO challenge_completions (user_id, challenge, period, xp) VALUES ($1, 'week5h', '2026-01-05', 5000)", [pia.id]);
        const r = (await call("GET", "/api/progress", null, pia.token)).data;
        assert.ok(r.level >= 9, `level ${r.level}`);
        assert.ok(r.xp >= r.levelStartXp && r.xp < r.nextLevelXp);
        await call("GET", "/api/progress", null, pia.token);
        const levels = await sql("SELECT data FROM feed_events WHERE user_id = $1 AND kind = 'level'", [pia.id]);
        assert.equal(levels.length, 1);
        assert.equal(levels[0].data.level, r.level);
        assert.equal((await sql("SELECT level FROM users WHERE id = $1", [pia.id]))[0].level, r.level);
    });

    test("profile choices above my level are refused; what I already have stays allowed", async () => {
        const locked = await call("PUT", "/api/profile", { banner: "sky" }, tom.token);
        assert.equal(locked.status, 403);
        assert.equal(locked.data.code, "LEVEL_LOCKED");
        assert.equal(locked.data.level, 24);
        assert.equal((await call("PUT", "/api/profile", { banner: "dots", color: "red" }, tom.token)).status, 200);
        assert.equal((await call("PUT", "/api/profile", { frame: "ring" }, tom.token)).data.code, "LEVEL_LOCKED");

        await sql("UPDATE users SET banner = 'sky' WHERE id = $1", [tom.id]);
        assert.equal((await call("PUT", "/api/profile", { banner: "sky", status: "Lernen" }, tom.token)).status, 200, "kept from before");

        // pia is past level 8: aurora and titles are hers
        const ok = await call("PUT", "/api/profile", { banner: "aurora", title: "planner" }, pia.token);
        assert.equal(ok.status, 200, JSON.stringify(ok.data));
        assert.equal(ok.data.banner, "aurora");
        assert.equal(ok.data.title, "planner");
        assert.equal((await call("PUT", "/api/profile", { title: "mentor" }, pia.token)).data.code, "LEVEL_LOCKED");
        assert.equal((await call("PUT", "/api/profile", { frame: "spiral" }, pia.token)).status, 400);
        assert.equal((await call("PUT", "/api/profile", { showcase: ["firstSession", "firstSession"] }, pia.token)).status, 400);
    });

    test("this week among friends: me and friends who show their numbers, most XP first", async () => {
        const r = (await call("GET", "/api/progress/friends", null, tom.token)).data;
        assert.deepEqual(r.ranking.map(row => row.user.username), ["pia", "tom"]);
        assert.ok(r.ranking[0].weekXp > 0);
        assert.equal(r.ranking[1].me, true);
        await sql("UPDATE users SET show_stats = false WHERE id = $1", [pia.id]);
        assert.deepEqual((await call("GET", "/api/progress/friends", null, tom.token)).data.ranking.map(row => row.user.username), ["tom"]);
        await sql("UPDATE users SET show_stats = true WHERE id = $1", [pia.id]);
    });
});

describe("the owner's level", () => {
    test("the owner (admin for good) is always on the top level, with everything unlocked", async () => {
        const boss = await member("bossowner");
        // only a database superuser can set it (the tests connect as one)
        await sql("UPDATE users SET is_owner = true WHERE id = $1", [boss.id]);
        const r = (await call("GET", "/api/progress", null, boss.token)).data;
        assert.equal(r.level, r.maxLevel);
        assert.equal(r.level, 50);
        assert.equal(r.nextLevelXp, null);
        assert.ok(r.xp >= r.levelStartXp);
        assert.equal((await sql("SELECT level FROM users WHERE id = $1", [boss.id]))[0].level, 50);
        const saved = await call("PUT", "/api/profile", { frame: "orbit", banner: "sky", title: "mentor" }, boss.token);
        assert.equal(saved.status, 200, JSON.stringify(saved.data));
        assert.equal(saved.data.level, 50);
    });

    test("everybody else stops at the top level too", async () => {
        const grinder = await member("grinder");
        await sql("INSERT INTO challenge_completions (user_id, challenge, period, xp) SELECT $1, 'week8h', d, 10000 FROM generate_series('2025-01-06'::date, '2025-04-07'::date, '7 days') AS d", [grinder.id]);
        const r = (await call("GET", "/api/progress", null, grinder.token)).data;
        assert.equal(r.level, 50);
        assert.equal(r.nextLevelXp, null);
    });
});

describe("feed", () => {
    let lea, max, eve;
    before(async () => {
        lea = await member("lea");
        max = await member("max");
        eve = await member("eve");
        await befriend(lea, max, "max");
    });

    test("posts reach friends only", async () => {
        assert.equal((await call("POST", "/api/feed/posts", { text: "   " }, lea.token)).status, 400);
        assert.equal((await call("POST", "/api/feed/posts", { text: "x".repeat(281) }, lea.token)).status, 400);
        const post = await call("POST", "/api/feed/posts", { text: "Klausur geschafft" }, lea.token);
        assert.equal(post.status, 201);
        assert.equal(post.data.mine, true);
        assert.equal(post.data.data.text, "Klausur geschafft");
        assert.ok((await call("GET", "/api/feed", null, max.token)).data.entries.some(e => e.id === post.data.id));
        assert.ok(!(await call("GET", "/api/feed", null, eve.token)).data.entries.some(e => e.id === post.data.id));
        assert.equal((await call("PUT", `/api/feed/${post.data.id}/cheer`, null, eve.token)).status, 404, "a stranger can't reach it");
    });

    test("friends cheer once; I can't cheer myself; I see who cheered", async () => {
        const [post] = (await call("GET", "/api/feed", null, lea.token)).data.entries;
        assert.equal((await call("PUT", `/api/feed/${post.id}/cheer`, null, lea.token)).data.code, "OWN_FEED_ENTRY");
        assert.deepEqual((await call("PUT", `/api/feed/${post.id}/cheer`, null, max.token)).data, { cheers: 1, cheered: true });
        assert.deepEqual((await call("PUT", `/api/feed/${post.id}/cheer`, null, max.token)).data, { cheers: 1, cheered: true });
        const mine = (await call("GET", "/api/feed", null, lea.token)).data.entries[0];
        assert.equal(mine.cheers, 1);
        assert.deepEqual(mine.cheerers.map(u => u.username), ["max"]);
        assert.equal((await call("GET", "/api/feed", null, max.token)).data.entries[0].cheerers, undefined);
        assert.deepEqual((await call("DELETE", `/api/feed/${post.id}/cheer`, null, max.token)).data, { cheers: 0, cheered: false });
    });

    test("pages go on from the cursor", async () => {
        for (let i = 0; i < 31; i++) await sql("INSERT INTO feed_events (user_id, kind, data) VALUES ($1, 'post', $2)", [max.id, { text: `Nr. ${i}` }]);
        const first = (await call("GET", "/api/feed", null, lea.token)).data;
        assert.equal(first.entries.length, 30);
        assert.ok(first.next);
        const second = (await call("GET", `/api/feed?before=${encodeURIComponent(first.next)}`, null, lea.token)).data;
        assert.equal(second.entries.length, 2);
        assert.equal(second.next, null);
        assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, 32);
        assert.equal((await call("GET", "/api/feed?before=nonsense", null, lea.token)).status, 400);
    });

    test("only my own entries can be removed; today's focus entry stays out", async () => {
        const [post] = (await call("GET", "/api/feed", null, max.token)).data.entries;
        assert.equal((await call("DELETE", `/api/feed/${post.id}`, null, lea.token)).status, 404);
        assert.equal((await call("DELETE", `/api/feed/${post.id}`, null, max.token)).status, 204);

        await call("POST", "/api/sessions", { totalTime: 20 * 60, workedTasks: [] }, lea.token);
        await call("GET", "/api/progress", null, lea.token);
        const day = (await call("GET", "/api/feed", null, lea.token)).data.entries.find(e => e.kind === "day");
        assert.ok(day);
        assert.equal((await call("DELETE", `/api/feed/${day.id}`, null, lea.token)).status, 204);
        await call("POST", "/api/sessions", { totalTime: 15 * 60, workedTasks: [] }, lea.token);
        await call("GET", "/api/progress", null, lea.token);
        assert.ok(!(await call("GET", "/api/feed", null, max.token)).data.entries.some(e => e.kind === "day" && e.user.id === lea.id));
    });

    test("with sharing off, friends see my posts but nothing automatic", async () => {
        assert.equal((await call("PUT", "/api/profile", { shareActivity: false }, max.token)).data.shareActivity, false);
        await call("POST", "/api/sessions", { totalTime: 30 * 60, workedTasks: [] }, max.token);
        await call("GET", "/api/progress", null, max.token);
        const seen = (await call("GET", "/api/feed", null, lea.token)).data.entries.filter(e => e.user.id === max.id);
        assert.ok(seen.every(e => e.kind === "post"));
        assert.equal((await call("PUT", "/api/profile", { shareActivity: "no" }, max.token)).status, 400);
    });
});

describe("online status", () => {
    let ona, onb, onc;
    const sockets = [];
    const bobSockets = [];
    const connectBob = async () => { const socket = await connect(onb.token); bobSockets.push(socket); return socket; };
    const connect = (token) => new Promise((resolve, reject) => {
        const socket = io(API, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
        sockets.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (err) => reject(err));
    });
    // the next presence:changed about `userId`
    const presence = (socket, userId, ms = 2000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("presence:changed", handler); reject(new Error(`no presence of ${userId} within ${ms} ms`)); }, ms);
        const handler = (payload) => {
            if (payload.userId !== userId) return;
            clearTimeout(timer);
            socket.off("presence:changed", handler);
            resolve(payload);
        };
        socket.on("presence:changed", handler);
    });
    const silentPresence = (socket, ms = 400) => new Promise((resolve, reject) => {
        const handler = (payload) => reject(new Error(`unexpected presence ${JSON.stringify(payload)}`));
        socket.on("presence:changed", handler);
        setTimeout(() => { socket.off("presence:changed", handler); resolve(); }, ms);
    });
    const onlineFriend = async (token, id) => (await call("GET", "/api/friends", null, token)).data.find(f => f.id === id)?.online;

    before(async () => {
        ona = await member("onlineann");
        onb = await member("onlinebob");
        onc = await member("onlinecleo");
        await befriend(ona, onb, "onlinebob");
    });
    after(() => { for (const socket of sockets) socket.disconnect(); });

    test("friends see who has the app open, strangers are not told", async () => {
        const annLive = await connect(ona.token);
        const cleoLive = await connect(onc.token);
        assert.equal(await onlineFriend(ona.token, onb.id), false);
        const [came] = await Promise.all([presence(annLive, onb.id), silentPresence(cleoLive), connectBob()]);
        assert.deepEqual(came, { userId: onb.id, online: true });
        assert.equal(await onlineFriend(ona.token, onb.id), true);
        assert.equal((await call("GET", "/api/profiles/onlinebob", null, ona.token)).data.online, true);
        assert.equal((await call("GET", "/api/profiles/onlinebob", null, onc.token)).data.online, undefined, "not a friend");
    });

    test("a second tab changes nothing; closing the last one is told after a moment", async () => {
        const annLive = await connect(ona.token);
        await connectBob();
        await silentPresence(annLive, 300);
        const gone = presence(annLive, onb.id);
        for (const socket of bobSockets.splice(0)) socket.disconnect();
        assert.deepEqual(await gone, { userId: onb.id, online: false });
        assert.equal(await onlineFriend(ona.token, onb.id), false);
    });

    test("whoever switches it off is never shown online", async () => {
        const annLive = await connect(ona.token);
        await Promise.all([presence(annLive, onb.id), connectBob()]);
        const [hidden, saved] = await Promise.all([
            presence(annLive, onb.id),
            call("PUT", "/api/profile", { showOnline: false }, onb.token),
        ]);
        assert.equal(saved.data.showOnline, false);
        assert.equal(hidden.online, false);
        assert.equal(await onlineFriend(ona.token, onb.id), false);
        assert.equal((await call("PUT", "/api/profile", { showOnline: "yes" }, onb.token)).status, 400);
        const [shown] = await Promise.all([presence(annLive, onb.id), call("PUT", "/api/profile", { showOnline: true }, onb.token)]);
        assert.equal(shown.online, true);
    });

    test("people in an open shared session see each other", async () => {
        await befriend(ona, onc, "onlinecleo");
        const session = (await call("POST", "/api/shared-sessions", { name: "Online", friendIds: [onb.id, onc.id] }, ona.token)).data;
        await call("POST", `/api/shared-sessions/${session.id}/join`, null, onb.token);
        await call("POST", `/api/shared-sessions/${session.id}/join`, null, onc.token);
        const people = (await call("GET", `/api/shared-sessions/${session.id}`, null, onc.token)).data.people;
        assert.equal(people.find(p => p.user.id === onb.id).online, true, "bob is no friend of cleo, but in the session");
    });
});

describe("Quidey Family: board, looks, who does what, the week", () => {
    let fia, fil, fim;
    const F = "/api/families";
    let family;

    before(async () => {
        fia = await member("famxfia");
        fil = await member("famxfil");
        fim = await member("famxfim");
        await befriend(fia, fil, "famxfil");
        family = (await call("POST", F, { name: "Haus", friendIds: [fil.id] }, fia.token)).data;
        await call("POST", `${F}/${family.id}/join`, null, fil.token);
    });

    test("the owner picks emoji and colour; every member writes on the board", async () => {
        assert.equal((await call("PATCH", `${F}/${family.id}`, { emoji: "🏡", color: "teal" }, fil.token)).data.code, "NOT_OWNER");
        assert.equal((await call("PATCH", `${F}/${family.id}`, { emoji: "🐙" }, fia.token)).data.field, "emoji");
        assert.equal((await call("PATCH", `${F}/${family.id}`, { color: "plaid" }, fia.token)).data.field, "color");
        const looks = (await call("PATCH", `${F}/${family.id}`, { emoji: "🏡", color: "teal" }, fia.token)).data;
        assert.equal(looks.emoji, "🏡");
        assert.equal(looks.color, "teal");
        assert.equal(looks.name, "Haus", "what isn't sent stays");
        const listed = (await call("GET", F, null, fil.token)).data.families[0];
        assert.deepEqual([listed.emoji, listed.color], ["🏡", "teal"]);

        const noted = (await call("PATCH", `${F}/${family.id}`, { note: "  Müll raus am Dienstag  " }, fil.token)).data;
        assert.equal(noted.note.text, "Müll raus am Dienstag");
        assert.equal(noted.note.updatedBy.id, fil.id);
        assert.equal((await call("PATCH", `${F}/${family.id}`, { note: "x".repeat(2001) }, fil.token)).data.field, "note");
        assert.equal((await call("PATCH", `${F}/${family.id}`, { note: "" }, fia.token)).data.note, null);
        assert.equal((await call("PATCH", `${F}/${family.id}`, {}, fia.token)).data.code, "NOTHING_TO_CHANGE");
    });

    test("entries go to a member; leaving takes it away again", async () => {
        assert.equal((await call("POST", `${F}/${family.id}/tasks`, { name: "Einkaufen", assignee_id: fim.id }, fia.token)).data.field, "assignee_id", "not a member");
        const added = (await call("POST", `${F}/${family.id}/tasks`, { name: "Einkaufen", assignee_id: fil.id }, fia.token)).data;
        const entry = added.tasks.find(t => t.name === "Einkaufen");
        assert.equal(entry.assignee.id, fil.id);
        assert.equal(entry.due, null, "without a day: on the list");
        const moved = (await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, { assignee_id: fia.id }, fil.token)).data;
        assert.equal(moved.tasks.find(t => t.id === entry.id).assignee.id, fia.id);
        await call("PATCH", `${F}/${family.id}/tasks/${entry.id}`, { assignee_id: fil.id }, fil.token);
        await call("DELETE", `${F}/${family.id}/members/me`, null, fil.token);
        const after = (await call("GET", `${F}/${family.id}`, null, fia.token)).data;
        assert.equal(after.tasks.find(t => t.id === entry.id).assignee, null);
    });

    test("the week of the members who show their numbers", async () => {
        await call("POST", `${F}/${family.id}/invites`, { userIds: [fil.id] }, fia.token);
        await call("POST", `${F}/${family.id}/join`, null, fil.token);
        await call("POST", "/api/sessions", { totalTime: 30 * 60, workedTasks: [] }, fil.token);
        const week = (await call("GET", `${F}/${family.id}`, null, fia.token)).data.week;
        const lil = week.people.find(p => p.userId === fil.id);
        assert.equal(lil.focusMin, 30);
        assert.equal(lil.streak, 1);
        assert.ok(week.weekStart);
        await sql("UPDATE users SET show_stats = false WHERE id = $1", [fil.id]);
        const hidden = (await call("GET", `${F}/${family.id}`, null, fia.token)).data.week;
        assert.deepEqual(hidden.people.map(p => p.userId), [fia.id], "only me");
        assert.equal((await call("GET", `${F}/${family.id}`, null, fil.token)).data.week.people.some(p => p.userId === fil.id), true, "I always see mine");
    });
});

describe("streaks", () => {
    let sia, sib;
    before(async () => {
        sia = await member("streaksia");
        sib = await member("streaksib");
        await befriend(sia, sib, "streaksib");
    });

    test("progress tells whether today counts, the best streak and the last seven days", async () => {
        const fresh = (await call("GET", "/api/progress", null, sia.token)).data;
        assert.equal(fresh.streak, 0);
        assert.equal(fresh.streakToday, false);
        assert.equal(fresh.bestStreak, 0);
        assert.equal(fresh.recentDays.length, 7);
        assert.equal(fresh.recentDays.at(-1).day, fresh.today);
        assert.ok(fresh.streakMilestones.includes(7));

        // focus yesterday and the day before: the streak runs, today doesn't count yet
        for (const days of [1, 2]) {
            await sql("INSERT INTO sessions (user_id, date, time_ms) VALUES ($1, now() - make_interval(days => $2), 600000)", [sia.id, days]);
        }
        const before = (await call("GET", "/api/progress", null, sia.token)).data;
        assert.equal(before.streak, 2);
        assert.equal(before.streakToday, false);
        assert.deepEqual(before.recentDays.slice(-3).map(d => d.active), [true, true, false]);

        await call("POST", "/api/sessions", { totalTime: 25 * 60, workedTasks: [] }, sia.token);
        const now = (await call("GET", "/api/progress", null, sia.token)).data;
        assert.equal(now.streak, 3);
        assert.equal(now.streakToday, true);
        assert.equal(now.bestStreak, 3);
        assert.equal(now.todayFocusMin, 25);
    });

    test("the ranking shows each friend's streak", async () => {
        const ranking = (await call("GET", "/api/progress/friends", null, sib.token)).data.ranking;
        assert.equal(ranking.find(r => r.user.id === sia.id).streak, 3);
        assert.equal(ranking.find(r => r.user.id === sia.id).online, false);
        assert.equal(ranking.find(r => r.me).online, undefined);
    });
});
