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
            RATE_LIMIT_REGISTER: "1000", RATE_LIMIT_AUTH: "1000", RATE_LIMIT_VERIFICATION_MAIL: "1000", RATE_LIMIT_API: "10000",
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
        await call("POST", "/api/sessions", { totalTime: 1500, workedTasks: [], group: "Arbeit" }, gone.token);
        await call("POST", "/api/shared-sessions", { name: "Lerngruppe" }, gone.token);
        await call("POST", `/api/messages/${friend.id}`, { body: "Tschüss" }, gone.token);
        await call("POST", `/api/messages/${gone.id}`, { body: "Schade" }, friend.token);

        assert.equal((await call("DELETE", "/api/users", { password: PW }, gone.token)).status, 200);
        const [left] = await sql(
            `SELECT (SELECT count(*) FROM tasks WHERE user_id = $1) + (SELECT count(*) FROM groups WHERE user_id = $1)
                + (SELECT count(*) FROM sessions WHERE user_id = $1) + (SELECT count(*) FROM friendships WHERE requester_id = $1 OR addressee_id = $1)
                + (SELECT count(*) FROM shared_sessions WHERE owner_id = $1) + (SELECT count(*) FROM messages WHERE sender_id = $1 OR recipient_id = $1)
                + (SELECT count(*) FROM notifications WHERE user_id = $1) + (SELECT count(*) FROM users WHERE id = $1) AS n`,
            [gone.id]
        );
        assert.equal(Number(left.n), 0);
        assert.equal((await call("GET", "/api/users", null, gone.token)).status, 401, "the old login stops working");
        assert.equal((await call("GET", "/api/messages", null, friend.token)).data.length, 0, "the friend's side is gone too");
        assert.equal((await register("goner", "goner@example.com")).status, 201, "name and address are free again");
    });
});
