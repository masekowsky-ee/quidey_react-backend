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
import { createRequire } from "node:module";
import pg from "pg";
import dotenv from "dotenv";
import { io } from "socket.io-client";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { startFakeUntis } from "./fakeUntis.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const DB = `quidey_test_${process.pid}`;
// Sign in with Google: the server checks the tests' own tokens with this key (GOOGLE_TEST_CERTS)
const GOOGLE_CLIENT = "test-client.apps.googleusercontent.com";
const GOOGLE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const GOOGLE_KID = "test-key";
const googleToken = (claims) => jwt.sign(
    { iss: "https://accounts.google.com", aud: GOOGLE_CLIENT, email_verified: true, ...claims },
    GOOGLE_KEY.privateKey.export({ type: "pkcs8", format: "pem" }),
    { algorithm: "RS256", keyid: GOOGLE_KID, expiresIn: "5m" }
);
// WebUntis, played by a local fake (fakeUntis.mjs); the server reaches it through UNTIS_TEST_BASE
const fakeUntis = await startFakeUntis();
const PW = "Sup3r-secret-pass!";
// what the fake AI answers per job (utils/ai.js): a line read by the AI, a scanned document
const AI_FAKE = {
    "parse-entry": {
        kind: "event", name: "Study", date: "2026-11-19", time: "13:00", endTime: "15:00", durationMinutes: null,
        color: "blue", eventType: "school", remindersMinutesBefore: [15, 99999], priority: null,
    },
    scan: {
        plan: {
            name: "Biologie Klausur", kind: "exam", due: "2099-03-02", subject: "Biologie",
            parts: [{ name: "Zellatmung", minutes: 90 }, { name: "Fotosynthese", minutes: 4 }, { name: "", minutes: 60 }],
        },
        notes: { title: "Zellatmung", body: "# Zellatmung\r\n- Glykolyse\n- [ ] Schaubild\n" },
        entries: [
            { kind: "event", name: "Klausur Biologie", date: "2099-03-02", time: "08:00", endTime: "09:30", durationMinutes: null },
            { kind: "task", name: "Abgabe Protokoll", date: "2099-02-27", time: null, endTime: null, durationMinutes: null },
            { kind: "task", name: "kaputt", date: "2099-02-31", time: "25:00", endTime: null, durationMinutes: 9999 },
        ],
    },
};
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

async function call(method, path, body, token, headers = {}) {
    const res = await fetch(API + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
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
            RATE_LIMIT_REGISTER: "1000", RATE_LIMIT_AUTH: "1000", RATE_LIMIT_FRIEND_REQUESTS: "1000", RATE_LIMIT_VERIFICATION_MAIL: "1000", RATE_LIMIT_API: "10000", REMINDER_CHECK_MS: "200", EVENT_CHECK_MS: "200", FOCUS_CHECK_MS: "200", NOTEBOOK_STORAGE_MAX: "4000", PRESENCE_GRACE_MS: "200", USAGE_RAW_MAX: "50",
            // pushes are only logged ("[DEV] Push to user …"), like mails without SMTP_HOST
            VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
            // the Android app's pushes are only logged too; Pro on sale, but no payments set up
            FIREBASE_SERVICE_ACCOUNT_FILE: "", STRIPE_SECRET_KEY: "", PLAY_SERVICE_ACCOUNT_FILE: "", ACCESS_MODE: "beta", PRO_BILLING: "on",
            GOOGLE_CLIENT_IDS: GOOGLE_CLIENT,
            // the AI answers from fixed replies (utils/ai.js), never the real API; "AI_FAIL" in the input fails
            ANTHROPIC_API_KEY: "", AI_FAKE: JSON.stringify(AI_FAKE),
            UNTIS_TEST_BASE: fakeUntis.base, UNTIS_SECRET: "a-test-secret-for-untis-that-is-long-enough",
            GOOGLE_TEST_CERTS: JSON.stringify({ [GOOGLE_KID]: GOOGLE_KEY.publicKey.export({ type: "spki", format: "pem" }) }),
        },
    });
    server.stdout.on("data", (chunk) => { log += chunk; });
    server.stderr.on("data", (chunk) => { log += chunk; });
    for (let i = 0; i < 100 && !log.includes("Server running"); i++) await sleep(100);
    assert.ok(log.includes("Server running"), `server did not start:\n${log}`);
});

after(async () => {
    server?.kill();
    await fakeUntis.close();
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

    test("a rating: a yes needs its stars, a no needs words", async () => {
        const bob = await member("fbrating");
        const rate = (body) => call("POST", "/api/feedback", { category: "rating", ...body }, bob.token);
        assert.equal((await rate({ message: "Schön." })).data.field, "liked");
        assert.equal((await rate({ liked: true })).data.field, "stars");
        assert.equal((await rate({ liked: true, stars: 6 })).data.field, "stars");
        assert.equal((await rate({ liked: false, message: "" })).data.code, "INVALID_MESSAGE");
        assert.equal((await rate({ liked: true, stars: 4 })).status, 200);
        await sleep(100);
        assert.match(log, /Feedback aus Quidey: Bewertung[\s\S]*@fbrating[\s\S]*Gefällt Quidey: Ja, ★★★★☆ \(4\/5\)/);
        assert.equal((await rate({ liked: false, message: "Zu viele Knöpfe." })).status, 200);
        await sleep(100);
        assert.match(log, /Gefällt Quidey: Nicht wirklich\n\nZu viele Knöpfe\./);
    });
});

describe("intro tour", () => {
    test("a new account hasn't seen it until it says so", async () => {
        const ann = await member("tournew");
        assert.equal((await call("GET", "/api/me", null, ann.token)).data.tourSeen, false);
        assert.deepEqual((await call("PUT", "/api/users/tour-seen", null, ann.token)).data, { tourSeen: true });
        assert.equal((await call("GET", "/api/me", null, ann.token)).data.tourSeen, true);
        // the first time stays
        const [{ tour_seen_at: first }] = await sql("SELECT tour_seen_at FROM users WHERE id = $1", [ann.id]);
        await call("PUT", "/api/users/tour-seen", null, ann.token);
        assert.deepEqual((await sql("SELECT tour_seen_at FROM users WHERE id = $1", [ann.id]))[0].tour_seen_at, first);
        assert.ok([401, 403].includes((await call("PUT", "/api/users/tour-seen")).status));
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
        const task = (await call("POST", "/api/tasks", { name: "Laufen", prio: 60, due: daysFromToday(-10), description: "Park", repeat: "weekly", due_time: "07:30", reminders: [15, 0] }, me.token)).data;
        await call("POST", `/api/tasks/${task.id}/groups/${group.id}`, null, me.token);

        const done = (await call("PUT", `/api/tasks/${task.id}`, { ...task, due: daysFromToday(-10), done: true }, me.token)).data;
        assert.ok(done.completed_at);
        const next = done.nextTask;
        assert.ok(next && !next.done);
        const [{ due }] = await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1", [next.id]);
        assert.equal(due, daysFromToday(4), "two weekly steps: the first one not in the past");
        assert.equal(next.description, "Park");
        assert.equal(next.due_time, "07:30");
        assert.deepEqual(next.reminders, [0, 15]);
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
        const task = (await call("POST", "/api/tasks", { name: "Mathe lernen", prio: 50, description: "", ...start, reminders: [5], reminder_email: true }, ann.token)).data;
        assert.equal(task.reminder_email, true);
        // the same without "by mail" (as an app from before several reminders sends it), and one
        // whose reminder is still ahead
        await call("POST", "/api/tasks", { name: "Nur in der App", prio: 50, description: "", ...start, reminder_minutes: 5 }, ann.token);
        await call("POST", "/api/tasks", { name: "Später", prio: 50, description: "", ...utcIn(120), reminders: [5], reminder_email: true }, ann.token);

        assert.equal(await waitForMails("mailann@example.com", "Mathe lernen", 1), 1);
        await sleep(800);
        assert.equal(mailsFor("mailann@example.com", "Mathe lernen"), 1, "only once");
        assert.equal(mailsFor("mailann@example.com", "Nur in der App"), 0);
        assert.equal(mailsFor("mailann@example.com", "Später"), 0);

        const moved = utcIn(4);
        await call("PUT", `/api/tasks/${task.id}`, { ...task, ...moved }, ann.token);
        assert.equal(await waitForMails("mailann@example.com", "Mathe lernen", 2), 2, "a new time reminds again");

        // done tasks are quiet
        const done = (await call("POST", "/api/tasks", { name: "Schon erledigt", prio: 50, description: "", ...utcIn(3), reminders: [10] }, ann.token)).data;
        await call("PUT", `/api/tasks/${done.id}`, { ...done, ...utcIn(3), done: true, reminder_email: true }, ann.token);
        await sleep(800);
        assert.equal(mailsFor("mailann@example.com", "Schon erledigt"), 0);
    });

    test("only the owner turns mails on or off; they reach only the owner", async () => {
        const start = utcIn(3);
        const task = (await call("POST", "/api/tasks", { name: "Gruppenarbeit", prio: 50, description: "", ...start, reminders: [30] }, ann.token)).data;
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

    test("a task has up to 5 reminders, sorted; an app from before sends one as reminder_minutes", async () => {
        const base = { prio: 50, description: "", ...utcIn(600) };
        const task = (await call("POST", "/api/tasks", { name: "Viele", ...base, reminders: [60, 0, 0, 15] }, ann.token)).data;
        assert.deepEqual(task.reminders, [0, 15, 60]);
        assert.equal(task.reminder_minutes, 0, "the one closest to the start, for older apps");
        for (const reminders of [[1, 2, 3, 4, 5, 6], [-1], [10081], [1.5], ["x"], "15", { 0: 1 }]) {
            assert.equal((await call("POST", "/api/tasks", { name: "Falsch", ...base, reminders }, ann.token)).data.field, "reminders", JSON.stringify(reminders));
        }
        const old = (await call("POST", "/api/tasks", { name: "Alt", ...base, reminder_minutes: 30 }, ann.token)).data;
        assert.deepEqual(old.reminders, [30]);
        assert.deepEqual((await call("PUT", `/api/tasks/${old.id}`, { ...old, ...base, reminders: undefined, reminder_minutes: null }, ann.token)).data.reminders, []);
        assert.deepEqual((await call("PUT", `/api/tasks/${task.id}`, { ...task, ...base, reminders: [] }, ann.token)).data.reminders, []);
        // a PUT without the field keeps them
        const kept = (await call("POST", "/api/tasks", { name: "Bleibt", ...base, reminders: [5] }, ann.token)).data;
        assert.deepEqual((await call("PUT", `/api/tasks/${kept.id}`, { name: "Bleibt", prio: 50, description: "", due: base.due }, ann.token)).data.reminders, [5]);
    });

    test("feature tips: seen ones kept per account and added up, hidden, shown again", async () => {
        assert.ok(Array.isArray((await call("GET", "/api/me", null, ann.token)).data.tipsSeen));
        await call("DELETE", "/api/users/tips", null, ann.token);
        const me = (await call("GET", "/api/me", null, ann.token)).data;
        assert.deepEqual([me.tipsSeen, me.tipsOff], [[], false]);
        assert.deepEqual((await call("POST", "/api/users/tips/seen", { ids: ["navHome", "add"] }, ann.token)).data, { tipsSeen: ["add", "navHome"], tipsOff: false });
        const more = (await call("POST", "/api/users/tips/seen", { ids: ["add", "notesNew"] }, ann.token)).data;
        assert.deepEqual([...more.tipsSeen].sort(), ["add", "navHome", "notesNew"]);
        for (const ids of [undefined, [], ["bad id"], [1], "add", Array.from({ length: 51 }, (_, i) => `t${i}`)]) {
            assert.equal((await call("POST", "/api/users/tips/seen", { ids }, ann.token)).data.field, "ids", JSON.stringify(ids));
        }
        assert.deepEqual((await call("PUT", "/api/users/tips", { off: true }, ann.token)).data.tipsOff, true);
        assert.equal((await call("PUT", "/api/users/tips", { off: "yes" }, ann.token)).data.field, "off");
        assert.equal((await call("GET", "/api/me", null, ann.token)).data.tipsOff, true);
        assert.deepEqual((await call("DELETE", "/api/users/tips", null, ann.token)).data, { tipsSeen: [], tipsOff: false });
        assert.equal((await call("POST", "/api/users/tips/seen", { ids: ["add"] })).status, 401);
    });

    test("my own colours for the pickers: kept per account, checked, at most 16", async () => {
        assert.deepEqual((await call("GET", "/api/me", null, ann.token)).data.savedColors, []);
        const r = await call("PUT", "/api/users/colors", { colors: ["#2A9D8F", "#e76f51", "#2a9d8f"] }, ann.token);
        assert.deepEqual([r.status, r.data], [200, { savedColors: ["#2a9d8f", "#e76f51"] }]);
        assert.deepEqual((await call("GET", "/api/me", null, ann.token)).data.savedColors, ["#2a9d8f", "#e76f51"]);
        for (const colors of [undefined, "#2a9d8f", ["red"], ["#12345"], [null], Array.from({ length: 17 }, (_, i) => `#0000${String(i).padStart(2, "0")}`)]) {
            assert.equal((await call("PUT", "/api/users/colors", { colors }, ann.token)).data.field, "colors", JSON.stringify(colors));
        }
        assert.equal((await call("PUT", "/api/users/colors", { colors: [] })).status, 401);
        assert.deepEqual((await call("PUT", "/api/users/colors", { colors: [] }, ann.token)).data, { savedColors: [] });
    });

    test("tasks without a time are reminded at my all-day time", async () => {
        assert.equal((await call("GET", "/api/me", null, ann.token)).data.allDayReminderTime, "12:00");
        assert.equal((await call("PUT", "/api/users/reminder-time", { time: "25:00" }, ann.token)).data.field, "time");
        assert.equal((await call("PUT", "/api/users/reminder-time", {}, ann.token)).data.field, "time");
        assert.equal((await call("PUT", "/api/users/reminder-time", { time: "08:00" })).status, 401);

        // ann lives in UTC (see above): the all-day time is this minute
        const now = utcIn(0);
        assert.deepEqual((await call("PUT", "/api/users/reminder-time", { time: now.due_time }, ann.token)).data, { allDayReminderTime: now.due_time });
        assert.equal((await call("GET", "/api/me", null, ann.token)).data.allDayReminderTime, now.due_time);
        await call("POST", "/api/tasks", { name: "Ganztags", prio: 50, description: "", due: now.due, reminders: [0], reminder_email: true }, ann.token);
        await call("POST", "/api/tasks", { name: "Ohne Erinnerung", prio: 50, description: "", due: now.due, reminder_email: true }, ann.token);
        assert.equal(await waitForMails("mailann@example.com", "Ganztags", 1), 1);
        assert.ok(log.includes("[DEV] Reminder for mailann@example.com: Ganztags (Today, all day)"));
        await sleep(600);
        assert.equal(mailsFor("mailann@example.com", "Ganztags"), 1, "once");
        assert.equal(mailsFor("mailann@example.com", "Ohne Erinnerung"), 0);
        await call("PUT", "/api/users/reminder-time", { time: "12:00" }, ann.token);
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

    test("family entries have a kind, reminders and who ticked them off", async () => {
        const columns = async (table) => (await sql(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]
        )).map(row => row.column_name);
        const family = await columns("family_tasks");
        for (const name of ["kind", "reminders", "push_sent_for", "done_by", "completed_at"]) assert.ok(family.includes(name), `family_tasks.${name}`);
        const session = await columns("shared_session_tasks");
        for (const name of ["done_by", "completed_at"]) assert.ok(session.includes(name), `shared_session_tasks.${name}`);
        assert.ok((await columns("push_subscriptions")).includes("groups"), "push_subscriptions.groups");
    });
});

describe("study goals: schema", () => {
    test("study tables and columns exist", async () => {
        const columns = async (table) => (await sql(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]
        )).map(row => row.column_name);
        const expected = {
            subjects: ["id", "user_id", "name", "emoji", "color", "archived", "created_at"],
            goals: ["id", "user_id", "subject_id", "kind", "name", "due", "due_time", "plan_mode", "status",
                "behind_notified_minutes", "behind_notified_on", "freed_minutes", "created_at"],
            goal_parts: ["id", "goal_id", "name", "position", "estimate_minutes", "estimate_source", "role", "done_at", "actual_minutes"],
            study_windows: ["id", "user_id", "weekday", "start_time", "end_time"],
        };
        for (const [table, names] of Object.entries(expected)) {
            const have = await columns(table);
            for (const name of names) assert.ok(have.includes(name), `${table}.${name}`);
        }
        const tasks = await columns("tasks");
        for (const name of ["goal_part_id", "plan_pinned"]) assert.ok(tasks.includes(name), `tasks.${name}`);
        const users = await columns("users");
        for (const name of ["study_session_minutes", "study_daily_max_minutes", "study_ai_auto"]) assert.ok(users.includes(name), `users.${name}`);
        assert.ok((await columns("push_subscriptions")).includes("study"), "push_subscriptions.study");

        const u = await member("studyschema");
        const subject = (await sql("INSERT INTO subjects (user_id, name) VALUES ($1, 'Mathe') RETURNING id", [u.id]))[0];
        await assert.rejects(
            sql("INSERT INTO goals (user_id, subject_id, kind, name, due) VALUES ($1, $2, 'quiz', 'x', CURRENT_DATE)", [u.id, subject.id]),
            /goals_kind_check/
        );
        await sql("INSERT INTO goals (user_id, subject_id, kind, name, due) VALUES ($1, $2, 'exam', 'x', CURRENT_DATE)", [u.id, subject.id]);
        await assert.rejects(
            sql("INSERT INTO study_windows (user_id, weekday, start_time, end_time) VALUES ($1, 1, '10:00', '09:00')", [u.id]),
            /study_windows_time_check/
        );
        await assert.rejects(
            sql("INSERT INTO study_windows (user_id, weekday, start_time, end_time) VALUES ($1, 8, '09:00', '10:00')", [u.id]),
            /study_windows_weekday_check/
        );
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

    test("routes under /api/tester: the old test features for everybody with app access, the ratings for testers", async () => {
        const boss = await member("routeboss", { admin: true });
        const rita = await member("routerita", { pro: false });
        const pia = await member("routepia");
        await sql("UPDATE users SET is_tester = true WHERE username = 'routerita'");

        assert.equal((await call("GET", "/api/tester/anything")).status, 401);
        // past the check (there is no such route): pro is enough now, as for the rest of the app
        assert.equal((await call("GET", "/api/tester/anything", null, pia.token)).status, 404);
        assert.equal((await call("GET", "/api/tester/anything", null, rita.token)).status, 404);
        assert.equal((await call("GET", "/api/tester/anything", null, boss.token)).status, 404);
        // without app access: no
        const outside = await member("routeout", { pro: false });
        assert.equal((await call("GET", "/api/tester/anything", null, outside.token)).data.code, "PRO_REQUIRED");
        // the Testbereich's ratings stay with the testers
        assert.equal((await call("GET", "/api/tester/feedback", null, pia.token)).data.code, "TESTER_REQUIRED");
        assert.equal((await call("GET", "/api/tester/feedback", null, rita.token)).status, 200);
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
            (await call("GET", "/api/users", null, boss.token)).data,
        ]);
        assert.ok(!/is_owner|isOwner/.test(responses));
        // only the admin panel sees who is an owner
        const listed = (await call("GET", "/api/admin/users?q=ownerboss", null, other.token)).data;
        assert.equal(listed.find(u => u.username === "ownerboss").isOwner, true);

        await sql("UPDATE users SET is_owner = false WHERE username = 'ownerboss'");
    });

    test("every account has an email address", async () => {
        await member("mailless");
        await assert.rejects(sql("UPDATE users SET email = NULL WHERE username = 'mailless'"));
    });
});

describe("admin users: every field, paging, export", () => {
    const KEYS = ["birthDate", "emailVerified", "termsAcceptedAt", "privacyAcceptedAt", "language", "timezone", "signIn", "level", "isOwner", "usageConsent"];

    test("a user row has every account field and no secrets", async () => {
        const boss = await member("auboss", { admin: true });
        await member("aupass");
        const n = (await call("GET", "/api/auth/google/nonce")).data.nonce;
        const first = await call("POST", "/api/auth/google", { idToken: googleToken({ sub: "g-au-1", email: "augoo@example.com", name: "Au Goo", nonce: n }) });
        const made = await call("POST", "/api/auth/google/register", {
            signupToken: first.data.signup.token, username: "augoo", display_name: "Au Goo", birth_date: "2000-01-01",
            accept_terms: true, accept_privacy: true, confirm_age: true,
        });
        assert.equal(made.status, 201);
        const list = (await call("GET", "/api/admin/users?q=au", null, boss.token)).data;
        assert.ok(Array.isArray(list));
        const pass = list.find(u => u.username === "aupass");
        const goo = list.find(u => u.username === "augoo");
        for (const k of KEYS) assert.ok(k in pass, `missing ${k}`);
        assert.equal(pass.signIn, "password");
        assert.equal(goo.signIn, "google");
        assert.equal(pass.birthDate, "1995-05-05");
        assert.equal(pass.isOwner, false);
        assert.equal(pass.level, 1);
        assert.ok(pass.termsAcceptedAt && pass.privacyAcceptedAt);
        assert.deepEqual(pass.usageConsent, { choice: null, at: null, version: null });
        await sql("UPDATE users SET has_password = true WHERE username = 'augoo'");
        assert.equal((await call("GET", "/api/admin/users?q=augoo", null, boss.token)).data[0].signIn, "both");
        const exp = (await call("GET", "/api/admin/users/export", null, boss.token)).data;
        assert.ok(!/hash|token|google_sub/i.test(JSON.stringify([list, exp])));
    });

    test("paging, sorting, and the old array without page", async () => {
        const boss = await member("pgboss", { admin: true });
        for (const name of ["pgcc", "pgaa", "pgbb"]) await member(name);
        await sql("UPDATE users SET display_name = NULL WHERE username = 'pgbb'");
        const one = await call("GET", "/api/admin/users?q=pg&page=1&pageSize=2", null, boss.token);
        assert.equal(one.status, 200);
        assert.equal(one.data.total, 4);
        assert.equal(one.data.users.length, 2);
        const two = (await call("GET", "/api/admin/users?q=pg&page=2&pageSize=2", null, boss.token)).data;
        assert.equal(two.users.length, 2);
        const p3 = (await call("GET", "/api/admin/users?q=pgc&page=1&pageSize=2", null, boss.token)).data;
        assert.equal(p3.total, 1);
        const newest = (await call("GET", "/api/admin/users?q=pg&page=1&pageSize=100&sort=newest", null, boss.token)).data.users.map(u => u.username);
        const oldest = (await call("GET", "/api/admin/users?q=pg&page=1&pageSize=100&sort=oldest", null, boss.token)).data.users.map(u => u.username);
        assert.deepEqual(oldest, [...newest].reverse());
        const byName = (await call("GET", "/api/admin/users?q=pg&page=1&pageSize=100&sort=name", null, boss.token)).data.users.map(u => u.username);
        assert.deepEqual(byName, ["pgaa", "pgbb", "pgboss", "pgcc"]);
        const old = await call("GET", "/api/admin/users?q=pg", null, boss.token);
        assert.ok(Array.isArray(old.data));
        assert.equal((await call("GET", "/api/admin/users?page=1&pageSize=101", null, boss.token)).status, 400);
        // a sort that names something every object inherits is unknown too: the default order
        for (const sort of ["constructor", "toString", "__proto__"]) {
            const odd = await call("GET", `/api/admin/users?q=pg&page=1&pageSize=100&sort=${sort}`, null, boss.token);
            assert.equal(odd.status, 200, sort);
            assert.deepEqual(odd.data.users.map(u => u.username), newest, sort);
        }
        const zero = await call("GET", "/api/admin/users?page=0", null, boss.token);
        assert.equal(zero.status, 400);
        assert.equal(zero.data.code, "INVALID_PAGE");
    });

    test("export lists everybody and is logged", async () => {
        const boss = await member("exboss", { admin: true });
        const pal = await member("expal");
        assert.equal((await call("GET", "/api/admin/users/export", null, pal.token)).status, 403);
        const exp = await call("GET", "/api/admin/users/export", null, boss.token);
        assert.equal(exp.status, 200);
        assert.ok(exp.data.users.some(u => u.username === "expal"));
        for (const k of KEYS) assert.ok(k in exp.data.users[0]);
        const rows = await sql("SELECT target_id, target_username FROM admin_actions WHERE action = 'export_users' AND admin_id = $1", [boss.id]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].target_id, boss.id);
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

describe("events and reminders in a family", () => {
    const F = "/api/families";
    let ola, per, ute, familyId;
    const tasksPath = () => `${F}/${familyId}/tasks`;
    const find = (family, name) => family.tasks.find(task => task.name === name);
    before(async () => {
        ola = await member("fevola");
        per = await member("fevper");
        ute = await member("fevute");
        await befriend(ola, per, "fevper");
        await befriend(ola, ute, "fevute");
        familyId = (await call("POST", F, { name: "Termine daheim", friendIds: [per.id, ute.id] }, ola.token)).data.id;
        await call("POST", `${F}/${familyId}/join`, null, per.token);
        // ute stays invited
    });

    test("an event needs a day; entries stay tasks by default", async () => {
        assert.equal((await call("POST", tasksPath(), { name: "Ohne Tag", kind: "event" }, ola.token)).data.field, "due");
        assert.equal((await call("POST", tasksPath(), { name: "Falsch", kind: "meeting" }, ola.token)).data.field, "kind");
        assert.equal(find((await call("POST", tasksPath(), { name: "Einkauf" }, ola.token)).data, "Einkauf").kind, "task");
    });

    test("an event is done once it is over, never by hand; moving it opens it again", async () => {
        const past = find((await call("POST", tasksPath(), { name: "Konzert", kind: "event", due: daysFromToday(-1), due_time: "19:00", duration_minutes: 90 }, ola.token)).data, "Konzert");
        assert.equal(past.kind, "event");
        assert.equal(past.done, true);
        assert.ok(past.completedAt, "ended");
        const coming = find((await call("POST", tasksPath(), { name: "Geburtstag", kind: "event", due: daysFromToday(2) }, ola.token)).data, "Geburtstag");
        assert.equal(coming.done, false);
        assert.equal((await call("PATCH", `${tasksPath()}/${coming.id}`, { done: true }, per.token)).data.code, "EVENT_NOT_DONE_BY_HAND");
        const moved = find((await call("PATCH", `${tasksPath()}/${past.id}`, { due: daysFromToday(3) }, per.token)).data, "Konzert");
        assert.equal(moved.done, false);
        assert.equal(moved.completedAt, null);
        assert.equal((await call("PATCH", `${tasksPath()}/${coming.id}`, { due: null }, per.token)).data.field, "due");
        const back = find((await call("PATCH", `${tasksPath()}/${past.id}`, { due: daysFromToday(-2) }, per.token)).data, "Konzert");
        assert.equal(back.done, true, "moved into the past: over at once");
        assert.ok(back.completedAt);
    });

    test("the server ticks off family events that end while nobody looks", async () => {
        const event = find((await call("POST", tasksPath(), { name: "Elternabend", kind: "event", due: daysFromToday(1) }, ola.token)).data, "Elternabend");
        await sql("UPDATE family_tasks SET due = current_date - 1, done = false WHERE id = $1", [event.id]);
        let row;
        for (let i = 0; i < 20; i++) {
            [row] = await sql("SELECT done, completed_at FROM family_tasks WHERE id = $1", [event.id]);
            if (row.done) break;
            await sleep(100);
        }
        assert.equal(row.done, true);
        assert.ok(row.completed_at);
    });

    test("reminders are kept only with a day", async () => {
        const entry = find((await call("POST", tasksPath(), { name: "Zahnarzt", due: daysFromToday(4), due_time: "09:00", reminders: [60, 0] }, ola.token)).data, "Zahnarzt");
        assert.deepEqual(entry.reminders, [0, 60]);
        assert.equal((await call("POST", tasksPath(), { name: "Zuviel", due: daysFromToday(4), reminders: [1, 2, 3, 4, 5, 6] }, ola.token)).data.field, "reminders");
        const cleared = find((await call("PATCH", `${tasksPath()}/${entry.id}`, { due: null }, per.token)).data, "Zahnarzt");
        assert.deepEqual(cleared.reminders, []);
        const noDay = find((await call("POST", tasksPath(), { name: "Ohne Tag erinnert", reminders: [0] }, ola.token)).data, "Ohne Tag erinnert");
        assert.deepEqual(noDay.reminders, []);
    });

    test("ticking off records who and when, in families and sessions", async () => {
        const entry = find((await call("POST", tasksPath(), { name: "Müll", due: daysFromToday(0) }, ola.token)).data, "Müll");
        await call("PATCH", `${tasksPath()}/${entry.id}`, { done: true }, per.token);
        let [row] = await sql("SELECT done_by, completed_at FROM family_tasks WHERE id = $1", [entry.id]);
        assert.equal(row.done_by, per.id);
        assert.ok(row.completed_at);
        await call("PATCH", `${tasksPath()}/${entry.id}`, { done: false }, ola.token);
        [row] = await sql("SELECT done_by, completed_at FROM family_tasks WHERE id = $1", [entry.id]);
        assert.equal(row.done_by, null);
        assert.equal(row.completed_at, null);

        const sessionId = (await call("POST", "/api/shared-sessions", { name: "Abhaken", friendIds: [per.id] }, ola.token)).data.id;
        await call("POST", `/api/shared-sessions/${sessionId}/join`, null, per.token);
        const task = (await call("POST", `/api/shared-sessions/${sessionId}/tasks`, { name: "Folien" }, ola.token)).data.tasks.find(t => t.name === "Folien");
        await call("PATCH", `/api/shared-sessions/${sessionId}/tasks/${task.id}`, { done: true }, per.token);
        [row] = await sql("SELECT done_by, completed_at FROM shared_session_tasks WHERE id = $1", [task.id]);
        assert.equal(row.done_by, per.id);
        assert.ok(row.completed_at);
        await call("PATCH", `/api/shared-sessions/${sessionId}/tasks/${task.id}`, { done: false }, per.token);
        [row] = await sql("SELECT done_by, completed_at FROM shared_session_tasks WHERE id = $1", [task.id]);
        assert.equal(row.done_by, null);
        assert.equal(row.completed_at, null);
    });

    const ownTask = async (user, fields) => (await call("POST", "/api/tasks", { prio: 50, due: null, description: "", ...fields }, user.token)).data;
    const myTaskIds = async (user) => (await call("GET", "/api/tasks", null, user.token)).data.map(task => task.id);

    test("one of my own tasks moves into the family with its details and reminders", async () => {
        const own = await ownTask(per, {
            name: "Steuer", description: "Belege sammeln", due: daysFromToday(5), due_time: "18:00", prio: 80, duration_minutes: 45,
            location: "Küche", link: "https://example.com/steuer", details: "Ordner blau", color: "orange", reminders: [60, 0],
        });
        const moved = await call("POST", tasksPath(), { taskId: own.id }, per.token);
        assert.equal(moved.status, 201, JSON.stringify(moved.data));
        const entry = find(moved.data, "Steuer");
        assert.equal(entry.description, "Belege sammeln");
        assert.equal(entry.due_time, "18:00");
        assert.equal(entry.prio, 80);
        assert.equal(entry.duration_minutes, 45);
        assert.equal(entry.location, "Küche");
        assert.equal(entry.link, "https://example.com/steuer");
        assert.equal(entry.details, "Ordner blau");
        assert.equal(entry.color, "orange");
        assert.equal(entry.kind, "task");
        assert.deepEqual(entry.reminders, [0, 60]);
        assert.equal(entry.addedBy.id, per.id);
        assert.ok(!(await myTaskIds(per)).includes(own.id), "gone from my list");
    });

    test("an own event moves as an event, with its type's colour", async () => {
        const type = (await call("POST", "/api/event-types", { name: "Sport", color: "teal" }, per.token)).data;
        const own = await ownTask(per, { name: "Schwimmen", due: daysFromToday(6), kind: "event", event_type_id: type.id });
        const entry = find((await call("POST", tasksPath(), { taskId: own.id }, per.token)).data, "Schwimmen");
        assert.equal(entry.kind, "event");
        assert.equal(entry.color, "teal");
    });

    test("moving is refused for repeating, shared, done and other people's tasks", async () => {
        const repeating = await ownTask(per, { name: "Wöchentlich", due: daysFromToday(1), repeat: "weekly" });
        assert.equal((await call("POST", tasksPath(), { taskId: repeating.id }, per.token)).data.code, "TASK_REPEATS");
        const shared = await ownTask(per, { name: "Geteilt" });
        await call("POST", `/api/tasks/${shared.id}/shares`, { userIds: [ola.id] }, per.token);
        assert.equal((await sql("SELECT count(*)::int AS n FROM task_shares WHERE task_id = $1", [shared.id]))[0].n, 1, "shared");
        assert.equal((await call("POST", tasksPath(), { taskId: shared.id }, per.token)).data.code, "TASK_SHARED");
        const done = await ownTask(per, { name: "Erledigt" });
        await call("PUT", `/api/tasks/${done.id}`, { name: "Erledigt", description: "", prio: 50, due: null, done: true }, per.token);
        assert.equal((await call("POST", tasksPath(), { taskId: done.id }, per.token)).data.code, "TASK_DONE");
        const foreign = await ownTask(ola, { name: "Olas" });
        const refused = await call("POST", tasksPath(), { taskId: foreign.id }, per.token);
        assert.equal(refused.status, 404);
        assert.equal(refused.data.code, "TASK_NOT_FOUND");
        for (const [user, task] of [[per, repeating], [per, shared], [per, done], [ola, foreign]]) {
            assert.ok((await myTaskIds(user)).includes(task.id), `${task.name} stays`);
        }
    });

    test("moving twice moves once", async () => {
        const own = await ownTask(per, { name: "Doppelklick" });
        const answers = await Promise.all([1, 2].map(() => call("POST", tasksPath(), { taskId: own.id }, per.token)));
        assert.deepEqual(answers.map(a => a.status).sort(), [201, 404]);
        assert.equal((await sql("SELECT count(*)::int AS n FROM family_tasks WHERE family_id = $1 AND name = 'Doppelklick'", [familyId]))[0].n, 1);
    });

    test("a family entry's reminder reaches every joined member once", async () => {
        const pushes = (user, text) => log.split("\n").filter(line => line.includes(`[DEV] Push to user ${user.id} (plan): `) && line.includes(text)).length;
        for (const [n, who] of [ola, per, ute].entries()) {
            await call("PUT", "/api/push/subscription", { endpoint: `https://push.example.com/send/family-rem-${n}`, keys: { p256dh: `BKeyR${n}`, auth: `authR${n}` } }, who.token);
        }
        // the owner's time zone counts; the start a minute from now, reminded a minute before it
        await call("PUT", "/api/users/locale", { timezone: "UTC", language: "de" }, ola.token);
        const start = new Date(Date.now() + 60000);
        await call("POST", tasksPath(), { name: "Elterngespräch", due: start.toISOString().slice(0, 10), due_time: start.toISOString().slice(11, 16), reminders: [1] }, per.token);
        for (let i = 0; i < 30 && (pushes(ola, "Elterngespräch") < 1 || pushes(per, "Elterngespräch") < 1); i++) await sleep(100);
        assert.equal(pushes(ola, "Elterngespräch"), 1, "the owner");
        assert.equal(pushes(per, "Elterngespräch"), 1, "a member");
        await sleep(800);
        assert.equal(pushes(ola, "Elterngespräch"), 1, "once");
        assert.equal(pushes(per, "Elterngespräch"), 1, "once");
        assert.equal(pushes(ute, "Elterngespräch"), 0, "only invited");
        assert.ok(log.includes("„Termine daheim“ ·"), "the family's name in front");

        // an edit that keeps the time (the editor always sends day and time) doesn't remind again
        const entry = (await call("GET", `${F}/${familyId}`, null, per.token)).data.tasks.find(t => t.name === "Elterngespräch");
        await call("PATCH", `${tasksPath()}/${entry.id}`, { due: start.toISOString().slice(0, 10), due_time: entry.due_time, location: "Schule" }, per.token);
        await sleep(800);
        assert.equal(pushes(ola, "Elterngespräch"), 1, "not again after an edit");
        assert.equal(pushes(per, "Elterngespräch"), 1, "not again after an edit");
    });

    test("session and family work counts in my statistics", async () => {
        const kim = await member("fstkim");
        const lou = await member("fstlou");
        await befriend(kim, lou, "fstlou");
        const fam = (await call("POST", F, { name: "Statistikfamilie", friendIds: [lou.id] }, kim.token)).data.id;
        await call("POST", `${F}/${fam}/join`, null, lou.token);
        const ses = (await call("POST", "/api/shared-sessions", { name: "Statistiksitzung", friendIds: [lou.id] }, kim.token)).data.id;
        await call("POST", `/api/shared-sessions/${ses}/join`, null, lou.token);
        const famEntry = async (by, body) => (await call("POST", `${F}/${fam}/tasks`, body, by.token)).data.tasks.find(t => t.name === body.name);
        const sesEntry = async (by, body) => (await call("POST", `/api/shared-sessions/${ses}/tasks`, body, by.token)).data.tasks.find(t => t.name === body.name);
        const before = (await call("GET", `/api/stats?from=${daysFromToday(-6)}&to=${daysFromToday(0)}`, null, kim.token)).data;

        // ticked by me in the family and in the session; given to me and ticked by lou
        const a = await famEntry(lou, { name: "Spülen" });
        await call("PATCH", `${F}/${fam}/tasks/${a.id}`, { done: true }, kim.token);
        const b = await sesEntry(lou, { name: "Zusammenfassung" });
        await call("PATCH", `/api/shared-sessions/${ses}/tasks/${b.id}`, { done: true }, kim.token);
        const c = await famEntry(lou, { name: "Staubsaugen", assignee_id: kim.id });
        await call("PATCH", `${F}/${fam}/tasks/${c.id}`, { done: true }, lou.token);
        // lou's own, ticked by lou: not mine
        const d = await famEntry(lou, { name: "Lous Sache" });
        await call("PATCH", `${F}/${fam}/tasks/${d.id}`, { done: true }, lou.token);
        // a 90-min family event I added yesterday; one lou added, not given to me
        await famEntry(kim, { name: "Kino", kind: "event", due: daysFromToday(-1), due_time: "18:00", duration_minutes: 90 });
        await famEntry(lou, { name: "Lous Termin", kind: "event", due: daysFromToday(-1), due_time: "10:00", duration_minutes: 60 });
        // one of my own tasks shared into the session and ticked there counts once
        const own = (await call("POST", "/api/tasks", { name: "Eigenes", prio: 50, due: null, description: "" }, kim.token)).data;
        const copy = await sesEntry(kim, { taskId: own.id, name: "Eigenes" });
        await call("PATCH", `/api/shared-sessions/${ses}/tasks/${copy.id}`, { done: true }, kim.token);
        await sql("INSERT INTO shared_time_days (user_id, day, time_ms) VALUES ($1, current_date, 600000)", [kim.id]);

        const week = (await call("GET", `/api/stats?from=${daysFromToday(-6)}&to=${daysFromToday(0)}`, null, kim.token)).data;
        assert.equal(week.tasksDone - before.tasksDone, 4, "three shared ones + my own once");
        assert.equal(week.events.ms - before.events.ms, 90 * 60_000);
        assert.equal(week.events.count - before.events.count, 1);
        assert.equal(week.together.teamMs, 600000);
        const places = Object.fromEntries(week.together.places.map(p => [`${p.kind}:${p.id}`, [p.name, p.done, p.events]]));
        assert.deepEqual(places[`family:${fam}`], ["Statistikfamilie", 2, 1]);
        assert.deepEqual(places[`session:${ses}`], ["Statistiksitzung", 1, 0]);
        assert.deepEqual(week.together.done.map(t => t.name).sort(), ["Spülen", "Staubsaugen", "Zusammenfassung"]);
        assert.equal(week.together.done.find(t => t.name === "Spülen").where.name, "Statistikfamilie");
        assert.equal(week.together.done.find(t => t.name === "Zusammenfassung").where.kind, "session");

        const lous = (await call("GET", `/api/stats?from=${daysFromToday(-6)}&to=${daysFromToday(0)}`, null, lou.token)).data;
        assert.equal(lous.tasksDone, 2, "what lou ticked off, also when it was given to kim");
        assert.equal(lous.events.count, 1);
    });
});

describe("focus in shared sessions counts in my totals", () => {
    // kim works 400 s on a session task with the solo timer (booked as her session AND as team
    // time), 200 s more with the session's own stopwatch; yesterday only the stopwatch, 300 s.
    const setUp = async (prefix) => {
        const kim = await member(`${prefix}kim`);
        const lou = await member(`${prefix}lou`);
        await befriend(kim, lou, `${prefix}lou`);
        const ses = (await call("POST", "/api/shared-sessions", { name: "Lerngruppe", friendIds: [lou.id] }, kim.token)).data.id;
        const task = (await call("POST", `/api/shared-sessions/${ses}/tasks`, { name: "Kapitel 4" }, kim.token)).data.tasks.find(t => t.name === "Kapitel 4");
        assert.equal((await call("POST", "/api/sessions", { totalTime: 400, workedTasks: [{ sharedTaskId: task.id, name: "Kapitel 4", time: 400 }] }, kim.token)).status, 201);
        await sql("INSERT INTO shared_time_days (user_id, day, time_ms) VALUES ($1, (now() AT TIME ZONE 'Europe/Berlin')::date, 600000)", [kim.id]);
        await sql("INSERT INTO shared_time_days (user_id, day, time_ms) VALUES ($1, (now() AT TIME ZONE 'Europe/Berlin')::date - 1, 300000)", [kim.id]);
        // a few seconds started by mistake: time counts, but it isn't a session
        await sql("INSERT INTO sessions (user_id, time_ms, date) VALUES ($1, 20000, now())", [kim.id]);
        return kim;
    };

    test("statistics: team time beyond my own sessions, short runs not counted as sessions", async () => {
        const kim = await setUp("ftot");
        const week = (await call("GET", `/api/stats?from=${daysFromToday(-6)}&to=${daysFromToday(0)}`, null, kim.token)).data;
        assert.equal(week.focus.ms, 400_000 + 20_000 + 200_000 + 300_000, "the 400 s on the session task count once");
        assert.equal(week.focus.sessions, 1);
        assert.deepEqual(week.focus.days, [{ day: daysFromToday(-1), ms: 300_000 }, { day: daysFromToday(0), ms: 620_000 }]);
        assert.equal(week.together.teamMs, 900_000, "the breakdown stays");
        assert.equal(week.firstDay, daysFromToday(-1));
    });

    test("profile: totals and streak include team time", async () => {
        const kim = await setUp("fpro");
        const stats = (await call("GET", "/api/profile", null, kim.token)).data.stats;
        assert.equal(stats.totalMs, 920_000);
        assert.equal(stats.sessions, 1);
        assert.equal(stats.avgSessionMs, 400_000, "only real sessions");
        assert.equal(stats.currentStreak, 2);
        assert.equal(stats.todayMs, 620_000);
    });

    test("a session under a minute is not saved", async () => {
        const pia = await member("fshort");
        for (const totalTime of [0, 59]) {
            const res = await call("POST", "/api/sessions", { totalTime, workedTasks: [] }, pia.token);
            assert.equal(res.status, 400);
            assert.equal(res.data.code, "SESSION_TOO_SHORT");
        }
        assert.equal((await call("POST", "/api/sessions", { totalTime: 60, workedTasks: [] }, pia.token)).status, 201);
        assert.equal((await sql("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [pia.id]))[0].n, 1);
    });
});

describe("notices about my families and sessions", () => {
    const F = "/api/families";
    let ann, ben, cleo, familyId, otherFamilyId, sessionId;
    let annLive, benLive, cleoLive;
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
    const silent = (socket, event, ms = 500) => new Promise((resolve, reject) => {
        const handler = () => reject(new Error(`unexpected ${event}`));
        socket.once(event, handler);
        setTimeout(() => { socket.off(event, handler); resolve(); }, ms);
    });
    const pushesFor = (user, kind, text) => log.split("\n").filter(line => line.includes(`[DEV] Push to user ${user.id} (${kind}): `) && line.includes(text)).length;
    async function waitForPushes(user, kind, text, count = 1) {
        for (let i = 0; i < 30 && pushesFor(user, kind, text) < count; i++) await sleep(100);
        return pushesFor(user, kind, text);
    }
    const notices = async (user, kind) => sql("SELECT title, body, data, read_at FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id", [user.id, kind]);
    // notices go out after the answer: the rows of user / kind that `pick` keeps, once there are `count` of them
    async function noticesOnce(user, kind, pick, count) {
        let rows = [];
        for (let i = 0; i < 30; i++) {
            rows = (await notices(user, kind)).filter(pick);
            if (rows.length >= count && (count > 0 || i >= 5)) break;
            await sleep(100);
        }
        return rows;
    }
    // the same, until the newest one counts `n` entries
    async function countOnce(user, pick, n) {
        let rows = [];
        for (let i = 0; i < 30; i++) {
            rows = (await notices(user, "entries_added")).filter(pick);
            if (rows.at(-1)?.data.count === n) break;
            await sleep(100);
        }
        return rows;
    }
    const addEntry = (user, body, id = familyId) => call("POST", `${F}/${id}/tasks`, body, user.token);

    before(async () => {
        ann = await member("gnann");
        ben = await member("gnben");
        cleo = await member("gncleo");
        await befriend(ann, ben, "gnben");
        await befriend(ann, cleo, "gncleo");
        for (const [n, who] of [ann, ben, cleo].entries()) {
            await call("PUT", "/api/users/locale", { timezone: "UTC", language: "de" }, who.token);
            await call("PUT", "/api/push/subscription", { endpoint: `https://push.example.com/send/groups-${n}`, keys: { p256dh: `BKeyG${n}`, auth: `authG${n}` } }, who.token);
        }
        familyId = (await call("POST", F, { name: "WG Süd", friendIds: [ben.id, cleo.id] }, ann.token)).data.id;
        await call("POST", `${F}/${familyId}/join`, null, ben.token);
        otherFamilyId = (await call("POST", F, { name: "Eltern", friendIds: [ben.id] }, ann.token)).data.id;
        await call("POST", `${F}/${otherFamilyId}/join`, null, ben.token);
        sessionId = (await call("POST", "/api/shared-sessions", { name: "Lerngruppe", friendIds: [ben.id, cleo.id] }, ann.token)).data.id;
        await call("POST", `/api/shared-sessions/${sessionId}/join`, null, ben.token);
        // cleo stays invited everywhere
        [annLive, benLive, cleoLive] = await Promise.all([connect(ann.token), connect(ben.token), connect(cleo.token)]);
    });
    after(() => { for (const socket of sockets) socket.disconnect(); });

    test("an entry by somebody else lands in the other members' inboxes, not mine", async () => {
        const [notice] = await Promise.all([
            next(benLive, "notification:new"),
            silent(annLive, "notification:new"),
            silent(cleoLive, "notification:new"),
            addEntry(ann, { name: "Wäsche" }),
        ]);
        assert.equal(notice.kind, "entries_added");
        assert.equal(notice.title, "Wäsche");
        assert.equal(notice.body, "WG Süd");
        assert.equal(notice.data.place, "family");
        assert.equal(notice.data.placeId, familyId);
        assert.equal(notice.data.count, 1);
        assert.equal(notice.data.by.id, ann.id);
        assert.equal(await waitForPushes(ben, "groups", "„Wäsche“ eingetragen"), 1);
        assert.equal(pushesFor(ann, "groups", "Wäsche"), 0);
        assert.equal(pushesFor(cleo, "groups", "Wäsche"), 0, "only invited");
    });

    test("several entries within half an hour are one notice", async () => {
        const here = (n) => n.data.place === "family" && n.data.placeId === familyId;
        await addEntry(ann, { name: "Bad" });
        await countOnce(ben, here, 2);
        await addEntry(ann, { name: "Flur" });
        const rows = await countOnce(ben, here, 3);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].data.count, 3);
        assert.equal(rows[0].title, "Flur");
        assert.equal(await waitForPushes(ben, "groups", "3 Einträge"), 1);

        await call("POST", "/api/notifications/read", null, ben.token);
        await addEntry(ann, { name: "Keller" });
        const after = await noticesOnce(ben, "entries_added", here, 2);
        assert.equal(after.length, 2, "read: the next one is new");
        assert.equal(after[1].data.count, 1);
    });

    test("the same person in two places makes two notices", async () => {
        await call("POST", "/api/notifications/read", null, ben.token);
        await addEntry(ann, { name: "Garten" });
        await addEntry(ann, { name: "Oma anrufen" }, otherFamilyId);
        const unread = await noticesOnce(ben, "entries_added", n => !n.read_at, 2);
        assert.deepEqual(unread.map(n => [n.data.placeId, n.data.count]), [[familyId, 1], [otherFamilyId, 1]]);
    });

    test("entries at the same moment are still one notice", async () => {
        await call("POST", "/api/notifications/read", null, ben.token);
        await Promise.all(["Fenster", "Tür", "Dach"].map(name => addEntry(ann, { name }, otherFamilyId)));
        const rows = await countOnce(ben, n => !n.read_at && n.data.placeId === otherFamilyId, 3);
        assert.deepEqual(rows.map(n => n.data.count), [3]);
        await call("POST", "/api/notifications/read", null, ben.token);
    });

    test("moving a task in is announced too", async () => {
        const own = (await call("POST", "/api/tasks", { name: "Fahrrad", prio: 50, due: null, description: "" }, ben.token)).data;
        const [notice] = await Promise.all([next(annLive, "notification:new"), call("POST", `${F}/${familyId}/tasks`, { taskId: own.id }, ben.token)]);
        assert.equal(notice.kind, "entries_added");
        assert.equal(notice.data.by.id, ben.id);
        assert.equal(notice.title, "Fahrrad");
    });

    test("a session entry by somebody else is announced too", async () => {
        await call("POST", "/api/notifications/read", null, ben.token);
        const inSession = (n) => n.data.place === "session";
        await call("POST", `/api/shared-sessions/${sessionId}/tasks`, { name: "Folien" }, ann.token);
        await countOnce(ben, inSession, 1);
        const own = (await call("POST", "/api/tasks", { name: "Skript", prio: 50, due: null, description: "" }, ann.token)).data;
        await call("POST", `/api/shared-sessions/${sessionId}/tasks`, { taskId: own.id }, ann.token);
        const rows = await countOnce(ben, inSession, 2);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].data.placeId, sessionId);
        assert.equal(rows[0].data.count, 2);
        assert.equal(rows[0].body, "Lerngruppe");
        assert.equal((await notices(cleo, "entries_added")).length, 0, "invited only");
        assert.equal((await notices(ann, "entries_added")).filter(n => n.data.place === "session").length, 0);
        assert.equal(await waitForPushes(ben, "groups", "„Folien“ eingetragen"), 1);
    });

    test("a family entry given to me lands in my inbox", async () => {
        const added = await addEntry(ann, { name: "Einkaufen", assignee_id: ben.id });
        const entry = added.data.tasks.find(t => t.name === "Einkaufen");
        const inFamily = (n) => n.data.familyId === familyId;
        const [given] = await noticesOnce(ben, "task_assigned", inFamily, 1);
        assert.ok(given, "notice");
        assert.equal(given.title, "Einkaufen");
        assert.equal(given.body, "WG Süd");
        assert.equal(given.data.by.id, ann.id);
        assert.equal(await waitForPushes(ben, "social", "Einkaufen"), 1);
        // the one it was given to hears of it once: not also as a new entry
        assert.equal((await noticesOnce(ben, "entries_added", n => n.title === "Einkaufen", 0)).length, 0);
        assert.equal(pushesFor(ben, "groups", "Einkaufen"), 0);

        // given on to ann by ann herself: nothing; to ben again: nothing new
        await call("PATCH", `${F}/${familyId}/tasks/${entry.id}`, { assignee_id: ann.id }, ann.token);
        assert.equal((await noticesOnce(ann, "task_assigned", () => true, 0)).length, 0);
        await call("PATCH", `${F}/${familyId}/tasks/${entry.id}`, { name: "Einkaufen gehen" }, ann.token);
        assert.equal((await notices(ben, "task_assigned")).filter(n => n.data.familyId === familyId).length, 1);
        await call("PATCH", `${F}/${familyId}/tasks/${entry.id}`, { assignee_id: ben.id }, ann.token);
        assert.equal((await noticesOnce(ben, "task_assigned", inFamily, 2)).length, 2, "given again");
    });

    test("family and session chat reach the others as a push", async () => {
        await call("POST", `${F}/${familyId}/messages`, { text: "Hallo Familie" }, ann.token);
        await call("POST", `/api/shared-sessions/${sessionId}/messages`, { text: "Hallo Gruppe" }, ann.token);
        assert.equal(await waitForPushes(ben, "groups", "Hallo Familie"), 1);
        assert.equal(await waitForPushes(ben, "groups", "Hallo Gruppe"), 1);
        assert.equal(pushesFor(ann, "groups", "Hallo"), 0);
        assert.equal(pushesFor(cleo, "groups", "Hallo"), 0);
        assert.equal((await notices(ben, "chat")).length, 0, "no inbox notice");
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

describe("push notifications", () => {
    let pia, pib, pic;
    const device = (n) => ({ endpoint: `https://push.example.com/send/device-${n}`, keys: { p256dh: `BKey${n}_-x`, auth: `auth${n}` } });
    const pushesFor = (user, kind, text) => log.split("\n").filter(line => line.includes(`[DEV] Push to user ${user.id} (${kind}): `) && line.includes(text)).length;
    async function waitForPushes(user, kind, text, count = 1) {
        for (let i = 0; i < 40 && pushesFor(user, kind, text) < count; i++) await sleep(100);
        return pushesFor(user, kind, text);
    }
    // "YYYY-MM-DD" and "HH:MM" in UTC, `minutes` from now
    const utcIn = (minutes) => {
        const d = new Date(Date.now() + minutes * 60000);
        return { due: d.toISOString().slice(0, 10), due_time: d.toISOString().slice(11, 16) };
    };

    before(async () => {
        pia = await member("pushpia");
        pib = await member("pushpib");
        pic = await member("pushpic");
        await befriend(pia, pib, "pushpib");
        for (const who of [pia, pib, pic]) await call("PUT", "/api/users/locale", { timezone: "UTC", language: "de" }, who.token);
    });

    test("a device signs up with its address and keys; kinds start on and change one by one", async () => {
        assert.deepEqual((await call("GET", "/api/push/key", null, pia.token)).data, { publicKey: null, fcm: false }, "no keys: only logged");
        assert.equal((await call("PUT", "/api/push/subscription", { ...device(1), endpoint: "http://insecure.example.com/x" }, pia.token)).data.field, "endpoint");
        assert.equal((await call("PUT", "/api/push/subscription", { ...device(1), keys: { p256dh: "a b", auth: "x" } }, pia.token)).data.field, "keys");
        assert.equal((await call("PUT", "/api/push/subscription", { ...device(1), kinds: { spam: true } }, pia.token)).data.field, "kinds");
        assert.equal((await call("PUT", "/api/push/subscription", device(1))).status, 401);

        const fresh = await call("PUT", "/api/push/subscription", device(1), pia.token);
        assert.deepEqual(fresh.data.kinds, { plan: true, digest: true, messages: true, social: true, groups: true, study: true });
        const changed = await call("PUT", "/api/push/subscription", { ...device(1), kinds: { digest: false } }, pia.token);
        assert.deepEqual(changed.data.kinds, { plan: true, digest: false, messages: true, social: true, groups: true, study: true });
        const again = await call("PUT", "/api/push/subscription", device(1), pia.token);
        assert.equal(again.data.kinds.digest, false, "kinds not sent stay");
        assert.equal((await sql("SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1", [device(1).endpoint]))[0].n, 1);
    });

    test("devices switch the new kind groups on and off", async () => {
        const on = await call("PUT", "/api/push/subscription", device(8), pia.token);
        assert.equal(on.data.kinds.groups, true);
        const off = await call("PUT", "/api/push/subscription", { ...device(8), kinds: { groups: false } }, pia.token);
        assert.equal(off.data.kinds.groups, false);
        assert.equal(off.data.kinds.social, true, "the others stay");
        assert.equal((await sql("SELECT groups FROM push_subscriptions WHERE endpoint = $1", [device(8).endpoint]))[0].groups, false);
        await call("DELETE", "/api/push/subscription", { endpoint: device(8).endpoint }, pia.token);
    });

    test("only for accounts with app access", async () => {
        const outsider = await member("pushout", { pro: false });
        assert.equal((await call("PUT", "/api/push/subscription", device(9), outsider.token)).data.code, "PRO_REQUIRED");
    });

    test("the same device signed in as somebody else goes over to them", async () => {
        await call("PUT", "/api/push/subscription", device(2), pic.token);
        await call("PUT", "/api/push/subscription", device(2), pib.token);
        const [row] = await sql("SELECT user_id FROM push_subscriptions WHERE endpoint = $1", [device(2).endpoint]);
        assert.equal(row.user_id, pib.id);
        // pic can't remove pib's device
        await call("DELETE", "/api/push/subscription", { endpoint: device(2).endpoint }, pic.token);
        assert.equal((await sql("SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1", [device(2).endpoint]))[0].n, 1);
    });

    test("a test push reaches only a signed-up device of mine", async () => {
        const sent = await call("POST", "/api/push/test", { endpoint: device(1).endpoint }, pia.token);
        assert.deepEqual(sent.data, { sent: true });
        assert.equal(await waitForPushes(pia, "plan", "Benachrichtigungen kommen"), 1);
        assert.equal((await call("POST", "/api/push/test", { endpoint: device(2).endpoint }, pia.token)).data.code, "NOT_SUBSCRIBED");
    });

    test("direct messages are pushed to the friend's devices that want them", async () => {
        await call("POST", `/api/messages/${pib.id}`, { body: "Lernen wir heute?" }, pia.token);
        assert.equal(await waitForPushes(pib, "messages", "Pushpia — Lernen wir heute?"), 1);
        await call("PUT", "/api/push/subscription", { ...device(2), kinds: { messages: false } }, pib.token);
        await call("POST", `/api/messages/${pib.id}`, { body: "Still?" }, pia.token);
        await sleep(300);
        assert.equal(pushesFor(pib, "messages", "Still?"), 0);
    });

    test("a friend request and an invite are pushed", async () => {
        await call("PUT", "/api/push/subscription", device(3), pic.token);
        await call("POST", "/api/friends/requests", { username: "pushpic" }, pia.token);
        assert.equal(await waitForPushes(pic, "social", "Pushpia möchte mit dir lernen."), 1);
        const [request] = (await call("GET", "/api/friends/requests", null, pic.token)).data.incoming;
        await call("POST", `/api/friends/requests/${request.id}/accept`, null, pic.token);
        await call("POST", "/api/shared-sessions", { name: "Klausur", friendIds: [pic.id] }, pia.token);
        assert.equal(await waitForPushes(pic, "social", "Pushpia lädt dich zu „Klausur“ ein."), 1);
    });

    test("a beta request is pushed to the admins, not to anybody else", async () => {
        const boss = await member("pushboss", { admin: true });
        await call("PUT", "/api/push/subscription", device(6), boss.token);
        const asker = await member("pushask", { pro: false });
        const asked = await call("POST", "/api/beta-requests", { reason: "Ich will besser lernen." }, asker.token);
        assert.equal(asked.status, 201);
        assert.equal(await waitForPushes(boss, "social", "Neue Beta-Anfrage — Pushask: Ich will besser lernen."), 1);
        await sleep(300);
        assert.equal(pushesFor(pic, "social", "Beta-Anfrage"), 0);
    });

    test("a task is pushed at its reminder, once; without a reminder it stays quiet", async () => {
        const reminded = (await call("POST", "/api/tasks", { name: "Essay abgeben", prio: 50, description: "", ...utcIn(10), reminders: [15] }, pia.token)).data;
        await call("POST", "/api/tasks", { name: "Vorlesung", prio: 50, description: "", ...utcIn(-1), kind: "event", location: "Hörsaal 2", reminders: [0] }, pia.token);
        await call("POST", "/api/tasks", { name: "Viel später", prio: 50, description: "", ...utcIn(90), reminders: [0] }, pia.token);
        await call("POST", "/api/tasks", { name: "Ohne Zeit", prio: 50, description: "", due: utcIn(0).due }, pia.token);
        await call("POST", "/api/tasks", { name: "Ohne Erinnerung", prio: 50, description: "", ...utcIn(-1) }, pia.token);

        assert.equal(await waitForPushes(pia, "plan", "Essay abgeben — Aufgabe um"), 1);
        assert.equal(await waitForPushes(pia, "plan", "Vorlesung — Beginnt jetzt"), 1);
        assert.ok(log.includes("Hörsaal 2"));
        await sleep(600);
        assert.equal(pushesFor(pia, "plan", "Essay abgeben"), 1, "only once");
        assert.equal(pushesFor(pia, "plan", "Viel später"), 0);
        assert.equal(pushesFor(pia, "plan", "Ohne Zeit"), 0);
        assert.equal(pushesFor(pia, "plan", "Ohne Erinnerung"), 0);

        // moved: a new reminder time, pushed again
        await call("PUT", `/api/tasks/${reminded.id}`, { ...reminded, ...utcIn(11) }, pia.token);
        assert.equal(await waitForPushes(pia, "plan", "Essay abgeben", 2), 2);

        // somebody without a device that wants "plan" gets nothing
        await call("PUT", "/api/push/subscription", { ...device(3), kinds: { plan: false } }, pic.token);
        await call("POST", "/api/tasks", { name: "Leise", prio: 50, description: "", ...utcIn(-1), reminders: [0] }, pic.token);
        await sleep(600);
        assert.equal(pushesFor(pic, "plan", "Leise"), 0);
    });

    test("of several reminders the latest due one is pushed, later ones follow; all-day ones at my all-day time", async () => {
        // both due (the server was down): only the one at the start
        await call("POST", "/api/tasks", { name: "Doppelt", prio: 50, description: "", ...utcIn(-1), reminders: [30, 0] }, pia.token);
        assert.equal(await waitForPushes(pia, "plan", "Doppelt — Jetzt dran"), 1);
        await sleep(600);
        assert.equal(pushesFor(pia, "plan", "Doppelt"), 1);

        // the earlier one now, the one at the start once it's there (here: the task moved closer)
        const twice = (await call("POST", "/api/tasks", { name: "Zweimal", prio: 50, description: "", ...utcIn(3), reminders: [5, 0] }, pia.token)).data;
        assert.equal(await waitForPushes(pia, "plan", "Zweimal — Aufgabe um"), 1);
        await call("PUT", `/api/tasks/${twice.id}`, { ...twice, ...utcIn(-1) }, pia.token);
        assert.equal(await waitForPushes(pia, "plan", "Zweimal — Jetzt dran"), 1);
        await sleep(600);
        assert.equal(pushesFor(pia, "plan", "Zweimal"), 2);

        // pia lives in UTC: the all-day time is this minute
        const now = utcIn(0);
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        await call("PUT", "/api/users/reminder-time", { time: now.due_time }, pia.token);
        await call("POST", "/api/tasks", { name: "Ganzer Tag", prio: 50, description: "", due: now.due, reminders: [0] }, pia.token);
        await call("POST", "/api/tasks", { name: "Tag davor", prio: 50, description: "", due: tomorrow, reminders: [1440] }, pia.token);
        await call("POST", "/api/tasks", { name: "Ausflug", prio: 50, description: "", due: tomorrow, kind: "event", reminders: [1440] }, pia.token);
        assert.equal(await waitForPushes(pia, "plan", "Ganzer Tag — Heute fällig"), 1);
        assert.equal(await waitForPushes(pia, "plan", "Tag davor — Morgen fällig"), 1);
        assert.equal(await waitForPushes(pia, "plan", "Ausflug — Morgen"), 1);
        await call("PUT", "/api/users/reminder-time", { time: "12:00" }, pia.token);
    });

    test("the morning overview comes once a day with what's open today", async () => {
        // a time zone where it's 09:xx right now
        const offset = ((9 - new Date().getUTCHours() + 36) % 24) - 12;
        const zone = offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
        const pid = await member("pushpid");
        await call("PUT", "/api/users/locale", { timezone: zone }, pid.token);
        const [{ today }] = await sql("SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today", [zone]);
        await call("POST", "/api/tasks", { name: "Lesen", prio: 50, description: "", due: today }, pid.token);
        await call("POST", "/api/tasks", { name: "Rechnen", prio: 50, description: "", due: today }, pid.token);
        await call("PUT", "/api/push/subscription", { ...device(4), kinds: { plan: false } }, pid.token);

        assert.equal(await waitForPushes(pid, "digest", "Dein Tag — Heute: 2 Aufgaben"), 1);
        await sleep(600);
        assert.equal(pushesFor(pid, "digest", "Dein Tag"), 1, "once a day");
        const [row] = await sql("SELECT to_char(push_digest_on, 'YYYY-MM-DD') AS day FROM users WHERE id = $1", [pid.id]);
        assert.equal(row.day, today);
    });

    test("turning off removes the device; signing out everywhere removes all of them", async () => {
        assert.deepEqual((await call("DELETE", "/api/push/subscription", { endpoint: device(1).endpoint }, pia.token)).data, { subscribed: false });
        assert.equal((await sql("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [pia.id]))[0].n, 0);
        await call("PUT", "/api/push/subscription", device(5), pic.token);
        await call("POST", "/api/users/logout-all", null, pic.token);
        assert.equal((await sql("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [pic.id]))[0].n, 0);
    });
});

describe("sub-groups in sessions and families (everybody)", () => {
    let tia, tom, sessionId, familyId;
    before(async () => {
        tia = await member("subtia");
        tom = await member("subtom");
        await befriend(tia, tom, "subtom");
        sessionId = (await call("POST", "/api/shared-sessions", { name: "Lernen", friendIds: [tom.id] }, tia.token)).data.id;
        await call("POST", `/api/shared-sessions/${sessionId}/join`, null, tom.token);
        familyId = (await call("POST", "/api/families", { name: "WG", friendIds: [tom.id] }, tia.token)).data.id;
        await call("POST", `/api/families/${familyId}/join`, null, tom.token);
    });

    test("any member makes groups in a session and files tasks in them; deleting one keeps its tasks", async () => {
        const G = `/api/shared-sessions/${sessionId}/groups`;
        let session = (await call("POST", G, { name: "Kapitel 1" }, tia.token)).data;
        assert.deepEqual(session.groups.map(g => g.name), ["Kapitel 1"]);
        assert.equal((await call("POST", G, { name: "kapitel 1" }, tia.token)).data.code, "SUB_GROUP_EXISTS");
        assert.equal((await call("POST", G, { name: "  " }, tia.token)).data.field, "name");
        const groupId = session.groups[0].id;

        const T = `/api/shared-sessions/${sessionId}/tasks`;
        session = (await call("POST", T, { name: "Lesen", group_id: groupId }, tia.token)).data;
        const task = session.tasks.find(t => t.name === "Lesen");
        assert.equal(task.groupId, groupId);
        assert.equal(task.addedBy.username, "subtia");
        assert.ok(Date.parse(task.createdAt) > Date.now() - 60000, "when it was made");
        // another member (no tester) files tasks in groups too, and sees them
        const tomsSession = (await call("POST", T, { name: "Auch", group_id: groupId }, tom.token)).data;
        assert.equal(tomsSession.tasks.find(t => t.name === "Auch").groupId, groupId);
        assert.equal((await call("GET", `/api/shared-sessions/${sessionId}`, null, tom.token)).data.tasks.find(t => t.id === task.id).groupId, groupId);
        // the old tester address answers everybody in the session now
        const old = await call("POST", `/api/tester/shared-sessions/${sessionId}/groups`, { name: "Alt" }, tom.token);
        assert.equal(old.status, 201, JSON.stringify(old.data));
        const oldId = old.data.groups?.find(g => g.name === "Alt")?.id ?? old.data.id;
        assert.equal((await call("DELETE", `/api/tester/shared-sessions/${sessionId}/groups/${oldId}`, null, tom.token)).status, 200);
        // only this session's groups
        assert.equal((await call("POST", T, { name: "Falsch", group_id: 999999 }, tia.token)).data.field, "group_id");

        const mine = (await call("GET", "/api/shared-sessions/my-tasks", null, tia.token)).data.find(s => s.id === sessionId);
        assert.deepEqual(mine.groups, [{ id: groupId, name: "Kapitel 1" }]);
        assert.equal(mine.tasks.find(t => t.id === task.id).groupId, groupId);
        assert.equal(mine.tasks.find(t => t.id === task.id).addedBy.username, "subtia");

        session = (await call("PATCH", `${T}/${task.id}`, { group_id: null }, tia.token)).data;
        assert.equal(session.tasks.find(t => t.id === task.id).groupId, null);
        await call("PATCH", `${T}/${task.id}`, { group_id: groupId }, tia.token);

        session = (await call("DELETE", `${G}/${groupId}`, null, tia.token)).data;
        assert.deepEqual(session.groups, []);
        assert.equal(session.tasks.find(t => t.id === task.id).groupId, null, "the task stays");
        assert.equal((await call("DELETE", `${G}/${groupId}`, null, tia.token)).data.code, "SUB_GROUP_NOT_FOUND");
    });

    test("the same in a family", async () => {
        const G = `/api/families/${familyId}/groups`;
        let family = (await call("POST", G, { name: "Einkauf" }, tom.token)).data;
        const groupId = family.groups[0].id;
        family = (await call("POST", `/api/families/${familyId}/tasks`, { name: "Milch", group_id: groupId }, tia.token)).data;
        const entry = family.tasks.find(t => t.name === "Milch");
        assert.equal(entry.groupId, groupId);
        assert.equal(entry.addedBy.username, "subtia");
        family = (await call("PATCH", `/api/families/${familyId}/tasks/${entry.id}`, { group_id: null }, tom.token)).data;
        assert.equal(family.tasks.find(t => t.id === entry.id).groupId, null);
        // another family's group doesn't fit
        const otherSession = (await call("POST", `/api/shared-sessions/${sessionId}/groups`, { name: "Anderes" }, tia.token)).data;
        const foreign = otherSession.groups.find(g => g.name === "Anderes").id;
        assert.equal((await call("PATCH", `/api/families/${familyId}/tasks/${entry.id}`, { group_id: foreign }, tia.token)).data.field, "group_id");
        family = (await call("DELETE", `${G}/${groupId}`, null, tia.token)).data;
        assert.deepEqual(family.groups, []);
    });
});

describe("Fokusraum: alarm, routines, notebook", () => {
    let fa, fb, outsider;
    const device = { endpoint: "https://push.example.com/send/focus-device", keys: { p256dh: "BKeyFocus_-x", auth: "authFocus" } };
    const pushesFor = (user, text) => log.split("\n").filter(line => line.includes(`[DEV] Push to user ${user.id} (plan): `) && line.includes(text)).length;
    async function waitForPush(user, text) {
        for (let i = 0; i < 40 && pushesFor(user, text) < 1; i++) await sleep(100);
        return pushesFor(user, text);
    }

    before(async () => {
        fa = await member("focusfa");
        fb = await member("focusfb");
        outsider = await member("focusout", { pro: false });
        await call("PUT", "/api/push/subscription", device, fa.token);
    });

    test("the end of a countdown is pushed once, and not after pause", async () => {
        const soon = new Date(Date.now() + 300).toISOString();
        const r = await call("PUT", "/api/focus/alarm", { endsAt: soon, phase: "focus" }, fa.token);
        assert.equal(r.status, 200);
        assert.equal(await waitForPush(fa, "Pause!"), 1);
        await sleep(500);
        assert.equal(pushesFor(fa, "Pause!"), 1, "only once");
        assert.equal((await sql("SELECT count(*)::int AS n FROM focus_alarms WHERE user_id = $1", [fa.id]))[0].n, 0);

        // set again and taken away (pause): nothing comes
        await call("PUT", "/api/focus/alarm", { endsAt: new Date(Date.now() + 400).toISOString(), phase: "timer" }, fa.token);
        assert.equal((await call("DELETE", "/api/focus/alarm", null, fa.token)).status, 200);
        await sleep(800);
        assert.equal(pushesFor(fa, "Zeit ist um"), 0);
    });

    test("alarm input is checked and needs app access", async () => {
        const inAMinute = new Date(Date.now() + 60e3).toISOString();
        assert.equal((await call("PUT", "/api/focus/alarm", { endsAt: "soon", phase: "focus" }, fa.token)).data.field, "endsAt");
        assert.equal((await call("PUT", "/api/focus/alarm", { endsAt: new Date(Date.now() + 9 * 3600e3).toISOString(), phase: "focus" }, fa.token)).data.field, "endsAt");
        assert.equal((await call("PUT", "/api/focus/alarm", { endsAt: inAMinute, phase: "nap" }, fa.token)).data.field, "phase");
        assert.equal((await call("PUT", "/api/focus/alarm", { endsAt: inAMinute, phase: "focus" }, outsider.token)).data.code, "PRO_REQUIRED");
        assert.equal((await call("PUT", "/api/focus/alarm", { endsAt: inAMinute, phase: "focus" })).status, 401);
    });

    test("routines: create, plan, change, run and delete, only my own", async () => {
        const steps = [{ title: "Fenster auf", minutes: 1 }, { title: "Schreibtisch frei", minutes: 5 }, { title: "Boden saugen", minutes: 10 }];
        let r = await call("POST", "/api/routines", { name: "Putzen", emoji: "\u{1F9FD}", steps, days: [6, 1, 6], atTime: "18:30" }, fa.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const routine = r.data;
        assert.deepEqual(routine.days, [1, 6]);
        assert.equal(routine.atTime, "18:30");
        assert.equal(routine.steps.length, 3);
        assert.equal(routine.doneToday, false);

        assert.equal((await call("POST", "/api/routines", { name: "", steps }, fa.token)).data.field, "name");
        assert.equal((await call("POST", "/api/routines", { name: "Leer", steps: [] }, fa.token)).data.field, "steps");
        assert.equal((await call("POST", "/api/routines", { name: "X", steps, days: [8] }, fa.token)).data.field, "days");
        assert.equal((await call("POST", "/api/routines", { name: "X", steps, atTime: "25:00" }, fa.token)).data.field, "atTime");

        r = await call("PUT", `/api/routines/${routine.id}`, { atTime: null, remind: false }, fa.token);
        assert.equal(r.data.atTime, null);
        assert.equal(r.data.remind, false);
        assert.equal((await call("PUT", `/api/routines/${routine.id}`, { name: "Meins" }, fb.token)).status, 404);

        r = await call("POST", `/api/routines/${routine.id}/runs`, { startedAt: new Date(Date.now() - 600e3).toISOString(), stepsDone: 3, stepsTotal: 3, seconds: 600 }, fa.token);
        assert.equal(r.status, 201);
        assert.equal(r.data.doneToday, true);
        assert.equal(r.data.runsThisWeek, 1);
        assert.equal((await call("POST", `/api/routines/${routine.id}/runs`, { startedAt: new Date().toISOString(), stepsDone: 4, stepsTotal: 3, seconds: 1 }, fa.token)).data.field, "stepsDone");
        assert.equal((await call("POST", `/api/routines/${routine.id}/runs`, { startedAt: new Date().toISOString(), stepsDone: 1, stepsTotal: 3, seconds: 1 }, fb.token)).status, 404);

        assert.equal((await call("GET", "/api/routines", null, fb.token)).data.length, 0);
        assert.equal((await call("DELETE", `/api/routines/${routine.id}`, null, fb.token)).status, 404);
        assert.equal((await call("DELETE", `/api/routines/${routine.id}`, null, fa.token)).status, 200);
        assert.equal((await call("GET", "/api/routines", null, fa.token)).data.length, 0);
    });

    test("a routine planned for now is pushed once today", async () => {
        const [{ now, weekday }] = await sql("SELECT to_char(now() AT TIME ZONE 'Europe/Berlin' - interval '1 minute', 'HH24:MI') AS now, extract(isodow FROM now() AT TIME ZONE 'Europe/Berlin' - interval '1 minute')::int AS weekday");
        const r = await call("POST", "/api/routines", { name: "Lernstart", steps: [{ title: "Handy weg", minutes: 0 }], days: [weekday], atTime: now }, fa.token);
        assert.equal(r.status, 201);
        assert.equal(await waitForPush(fa, "Lernstart"), 1);
        await sleep(500);
        assert.equal(pushesFor(fa, "Lernstart"), 1);
    });

    test("notebook: notes with checklist, links and a picture; the list leaves picture data out", async () => {
        const created = (await call("POST", "/api/tasks", { name: "Klausur Mathe" }, fa.token)).data;
        const taskId = created.id ?? created.task?.id;
        assert.ok(taskId, JSON.stringify(created));
        const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let r = await call("POST", "/api/notebook", {
            title: "Formeln", body: "- [ ] Ableitungen\n- [x] Integrale", taskId,
            attachments: [{ kind: "link", url: "https://de.wikipedia.org/wiki/Ableitung", title: "Wiki" }, { kind: "image", data: picture, name: "tafel.png" }],
        }, fa.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const note = r.data;
        assert.equal(note.attachments[1].data, picture);
        assert.equal(note.taskId, taskId);

        const list = (await call("GET", "/api/notebook", null, fa.token)).data;
        assert.equal(list.length, 1);
        assert.deepEqual(list[0].attachments[1], { kind: "image", name: "tafel.png" });
        assert.equal((await call("GET", `/api/notebook/${note.id}`, null, fa.token)).data.attachments[1].data, picture);

        assert.equal((await call("POST", "/api/notebook", { title: "", body: " " }, fa.token)).data.field, "body");
        assert.equal((await call("POST", "/api/notebook", { body: "x", attachments: [{ kind: "link", url: "javascript:alert(1)" }] }, fa.token)).data.field, "attachments");
        assert.equal((await call("POST", "/api/notebook", { body: "x", attachments: [{ kind: "image", data: "data:image/svg+xml;base64,PHN2Zz4=" }] }, fa.token)).data.field, "attachments");
        assert.equal((await call("POST", "/api/notebook", { body: "x", taskId }, fb.token)).status, 404, "not somebody else's task");

        r = await call("PUT", `/api/notebook/${note.id}`, { pinned: true, body: "- [x] Ableitungen" }, fa.token);
        assert.equal(r.data.pinned, true);
        assert.equal(r.data.title, "Formeln", "fields not sent stay");
        assert.equal((await call("GET", `/api/notebook/${note.id}`, null, fb.token)).status, 404);
        assert.equal((await call("DELETE", `/api/notebook/${note.id}`, null, fb.token)).status, 404);
        assert.equal((await call("DELETE", `/api/notebook/${note.id}`, null, fa.token)).status, 200);
    });

    test("a task's notes are notebook notes about it (migration 043): the old routes read and write the notebook", async () => {
        const created = (await call("POST", "/api/tasks", { name: "Referat Bio" }, fa.token)).data;
        const taskId = created.id ?? created.task?.id;
        let r = await call("POST", `/api/tasks/${taskId}/notes`, { content: "Folien bis Freitag" }, fa.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const quick = r.data;
        assert.equal(quick.task_id, taskId);
        assert.equal(quick.content, "Folien bis Freitag");

        // the notebook (Fokusraum, Notizen) has it, about that task
        const inNotebook = (await call("GET", `/api/notebook/${quick.id}`, null, fa.token)).data;
        assert.equal(inNotebook.taskId, taskId);
        assert.equal(inNotebook.body, "Folien bis Freitag");

        // a notebook note about the task shows on the task, its title as the first line
        const titled = (await call("POST", "/api/notebook", { title: "Gliederung", body: "1. Zelle", taskId }, fa.token)).data;
        await call("POST", "/api/notebook", { body: "ohne Aufgabe" }, fa.token);
        let list = (await call("GET", "/api/notes", null, fa.token)).data;
        assert.deepEqual(list.map(n => n.content), ["Folien bis Freitag", "Gliederung\n1. Zelle"]);
        assert.deepEqual((await call("GET", `/api/tasks/${taskId}/notes`, null, fa.token)).data.map(n => n.id), [quick.id, titled.id]);

        // editing on the task keeps the title while the first line still is it
        r = await call("PUT", `/api/notes/${titled.id}`, { content: "Gliederung\n1. Zelle\n2. Kern" }, fa.token);
        assert.equal(r.status, 200);
        let row = (await call("GET", `/api/notebook/${titled.id}`, null, fa.token)).data;
        assert.deepEqual([row.title, row.body], ["Gliederung", "1. Zelle\n2. Kern"]);
        await call("PUT", `/api/notes/${titled.id}`, { content: "Neu" }, fa.token);
        row = (await call("GET", `/api/notebook/${titled.id}`, null, fa.token)).data;
        assert.deepEqual([row.title, row.body], ["", "Neu"]);

        // only my own; the trash leaves the task's list
        assert.equal((await call("PUT", `/api/notes/${quick.id}`, { content: "x" }, fb.token)).status, 404);
        assert.equal((await call("DELETE", `/api/notes/${quick.id}`, null, fb.token)).status, 404);
        await sql("UPDATE notebook_notes SET trashed_at = now() WHERE id = $1", [titled.id]);
        list = (await call("GET", "/api/notes", null, fa.token)).data;
        assert.deepEqual(list.map(n => n.id), [quick.id]);
        assert.equal((await call("DELETE", `/api/notes/${quick.id}`, null, fa.token)).status, 200);
        assert.equal((await call("GET", `/api/notebook/${quick.id}`, null, fa.token)).status, 404);
        await sql("DELETE FROM notebook_notes WHERE user_id = $1", [fa.id]);
    });

    test("everything goes with the account", async () => {
        const gone = await member("focusgone");
        await call("POST", "/api/routines", { name: "R", steps: [{ title: "a", minutes: 1 }] }, gone.token);
        await call("POST", "/api/notebook", { body: "n" }, gone.token);
        await call("PUT", "/api/focus/alarm", { endsAt: new Date(Date.now() + 3600e3).toISOString(), phase: "timer" }, gone.token);
        const r = await call("DELETE", "/api/users", { password: PW }, gone.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const left = await sql(`SELECT (SELECT count(*) FROM routines WHERE user_id = $1)::int + (SELECT count(*) FROM notebook_notes WHERE user_id = $1)::int
            + (SELECT count(*) FROM focus_alarms WHERE user_id = $1)::int AS n`, [gone.id]);
        assert.equal(left[0].n, 0);
    });
});

describe("notes area and collections (testers)", () => {
    let tess, other, plain;
    const makeTester = (user) => sql("UPDATE users SET is_tester = true WHERE id = $1", [user.id]);
    const newTask = async (user, body) => {
        const data = (await call("POST", "/api/tasks", body, user.token)).data;
        return data.id ?? data.task?.id;
    };

    before(async () => {
        tess = await member("notestess");
        other = await member("notesother");
        plain = await member("notesplain");
        await makeTester(tess);
        await makeTester(other);
        await sql("UPDATE users SET is_tester = false WHERE id = $1", [plain.id]);
    });

    test("folders, tags, colour, archive; for everybody", async () => {
        let r = await call("POST", "/api/tester/note-folders", { name: "Mathe", emoji: "📐" }, tess.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const folder = r.data;
        assert.equal((await call("POST", "/api/tester/note-folders", { name: "mathe" }, tess.token)).data.code, "FOLDER_EXISTS");
        assert.equal((await call("POST", "/api/tester/note-folders", { name: " " }, tess.token)).data.field, "name");
        assert.deepEqual((await call("GET", "/api/tester/note-folders", null, plain.token)).data, [], "not a tester: folders all the same");

        r = await call("POST", "/api/notebook", { title: "Analysis", body: "x", folderId: folder.id, tags: ["#klausur", "Klausur", "lernzettel"], color: "blue" }, tess.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const note = r.data;
        assert.equal(note.folderId, folder.id);
        assert.deepEqual(note.tags, ["klausur", "lernzettel"], "# dropped, the same word once");
        assert.equal(note.color, "blue");
        assert.equal(note.archived, false);
        assert.equal((await call("POST", "/api/notebook", { body: "x", tags: ["zwei worte"] }, tess.token)).data.field, "tags");
        assert.equal((await call("POST", "/api/notebook", { body: "x", color: "beige" }, tess.token)).data.field, "color");
        // a NUL byte is refused up front (Postgres can't store it: a 500 otherwise)
        assert.equal((await call("POST", "/api/notebook", { title: "a\u0000b", body: "x" }, tess.token)).data.field, "title");
        assert.equal((await call("POST", "/api/notebook", { body: "a\u0000b" }, tess.token)).data.field, "body");
        assert.equal((await call("POST", "/api/notebook", { body: "x", tags: ["a\u0000b"] }, tess.token)).data.field, "tags");
        assert.equal((await call("POST", "/api/notebook", { body: "x", attachments: [{ kind: "link", url: "https://a.de/\u0000" }] }, tess.token)).data.field, "attachments");
        assert.equal((await call("POST", "/api/tester/note-folders", { name: "a\u0000b" }, tess.token)).data.field, "name");
        assert.equal((await call("POST", "/api/notebook", { body: "x", folderId: folder.id }, other.token)).status, 404, "not somebody else's folder");
        assert.deepEqual((await call("POST", "/api/notebook", { body: "x", tags: ["a"] }, plain.token)).data.tags, ["a"], "tags for everybody");
        assert.equal((await call("POST", "/api/notebook", { body: "plain note" }, plain.token)).status, 201, "the notebook itself stays for everybody");

        const before = note.updatedAt;
        r = await call("PUT", `/api/notebook/${note.id}`, { archived: true }, tess.token);
        assert.equal(r.data.archived, true);
        assert.equal(r.data.updatedAt, before, "archiving isn't an edit");
        assert.equal((await call("GET", "/api/tester/note-folders", null, tess.token)).data[0].notes, 1);

        assert.equal((await call("DELETE", `/api/tester/note-folders/${folder.id}`, null, other.token)).status, 404);
        assert.equal((await call("DELETE", `/api/tester/note-folders/${folder.id}`, null, tess.token)).status, 200);
        assert.equal((await call("GET", `/api/notebook/${note.id}`, null, tess.token)).data.folderId, null, "its notes stay, loose");
    });

    test("trash: out of the list, back again, emptied, and gone after 30 days", async () => {
        const note = (await call("POST", "/api/notebook", { title: "Weg damit", body: "x" }, tess.token)).data;
        let r = await call("PUT", `/api/notebook/${note.id}`, { trashed: true }, tess.token);
        assert.ok(r.data.trashedAt);
        assert.ok(!(await call("GET", "/api/notebook", null, tess.token)).data.some(n => n.id === note.id));
        assert.ok((await call("GET", "/api/notebook?trash=1", null, tess.token)).data.some(n => n.id === note.id));
        r = await call("PUT", `/api/notebook/${note.id}`, { trashed: false }, tess.token);
        assert.equal(r.data.trashedAt, null);

        const old = (await call("POST", "/api/notebook", { body: "alt" }, tess.token)).data;
        await sql("UPDATE notebook_notes SET trashed_at = now() - interval '31 days' WHERE id = $1", [old.id]);
        const fresh = (await call("POST", "/api/notebook", { body: "neu" }, tess.token)).data;
        await call("PUT", `/api/notebook/${fresh.id}`, { trashed: true }, tess.token);
        const trash = (await call("GET", "/api/notebook?trash=1", null, tess.token)).data;
        assert.ok(!trash.some(n => n.id === old.id), "over 30 days: deleted");
        assert.ok(trash.some(n => n.id === fresh.id));
        r = await call("DELETE", "/api/tester/notebook/trash", null, tess.token);
        assert.equal(r.data.deleted, 1);
        assert.equal((await call("GET", "/api/notebook?trash=1", null, tess.token)).data.length, 0);
    });

    test("collections hold tasks, events and notes, from either side", async () => {
        const exam = await newTask(tess, { name: "Klausur Mathe", kind: "event", due: daysFromToday(10), due_time: "09:00" });
        const learn = await newTask(tess, { name: "Kapitel 3 lernen" });
        const sheet = (await call("POST", "/api/notebook", { title: "Formelsammlung", body: "x" }, tess.token)).data;
        const foreign = await newTask(other, { name: "Nicht meins" });
        assert.ok(exam && learn && foreign);

        let r = await call("POST", "/api/tester/collections", { name: "Klausur Mathe", emoji: "📐", color: "violet", items: [{ kind: "task", id: exam }] }, tess.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const col = r.data;
        assert.deepEqual(col.items.map(i => [i.kind, i.id]), [["task", exam]]);

        r = await call("POST", `/api/tester/collections/${col.id}/items`, { kind: "task", id: learn }, tess.token);
        assert.equal(r.status, 201);
        r = await call("POST", `/api/tester/collections/${col.id}/items`, { kind: "note", id: sheet.id }, tess.token);
        assert.equal(r.data.items.length, 3);
        assert.equal((await call("POST", `/api/tester/collections/${col.id}/items`, { kind: "note", id: sheet.id }, tess.token)).status, 200, "in already");
        assert.equal((await call("POST", `/api/tester/collections/${col.id}/items`, { kind: "task", id: foreign }, tess.token)).status, 404, "not somebody else's task");
        assert.equal((await call("POST", `/api/tester/collections/${col.id}/items`, { kind: "folder", id: 1 }, tess.token)).data.field, "item");
        assert.equal((await call("POST", `/api/tester/collections/${col.id}/items`, { kind: "task", id: learn }, other.token)).status, 404, "not somebody else's collection");
        assert.equal((await call("POST", "/api/tester/collections", { name: "x", items: [{ kind: "task", id: foreign }] }, tess.token)).status, 404);
        assert.equal((await call("GET", "/api/tester/collections", null, plain.token)).status, 200, "for everybody");

        // one thing in two collections
        const second = (await call("POST", "/api/tester/collections", { name: "Diese Woche", items: [{ kind: "task", id: learn }] }, tess.token)).data;
        const list = (await call("GET", "/api/tester/collections", null, tess.token)).data;
        assert.equal(list.filter(c => c.items.some(i => i.kind === "task" && i.id === learn)).length, 2);

        // a trashed note is out of sight, a deleted task goes for good
        await call("PUT", `/api/notebook/${sheet.id}`, { trashed: true }, tess.token);
        assert.equal((await call("GET", "/api/tester/collections", null, tess.token)).data.find(c => c.id === col.id).items.length, 2);
        await call("PUT", `/api/notebook/${sheet.id}`, { trashed: false }, tess.token);
        await call("DELETE", `/api/tasks/${learn}`, null, tess.token);
        assert.equal((await call("GET", "/api/tester/collections", null, tess.token)).data.find(c => c.id === second.id).items.length, 0);

        r = await call("PUT", `/api/tester/collections/${col.id}`, { description: "Am 14. im Hörsaal 2", color: null }, tess.token);
        assert.equal(r.data.description, "Am 14. im Hörsaal 2");
        assert.equal(r.data.color, null);
        assert.equal(r.data.name, "Klausur Mathe");
        r = await call("DELETE", `/api/tester/collections/${col.id}/items/note/${sheet.id}`, null, tess.token);
        assert.equal(r.data.items.length, 1);
        assert.equal((await call("GET", `/api/notebook/${sheet.id}`, null, tess.token)).status, 200, "the note itself stays");
        assert.equal((await call("DELETE", `/api/tester/collections/${col.id}`, null, other.token)).status, 404);
        assert.equal((await call("DELETE", `/api/tester/collections/${col.id}`, null, tess.token)).status, 200);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [exam]))[0].n, 1, "its tasks stay");
    });

    test("a tester's groups become collections once; stats count focus per collection", async () => {
        const gina = await member("notesgina");
        await makeTester(gina);
        const sport = (await call("POST", "/api/groups", { name: "Sport", description: "Laufen und so", color: "green" }, gina.token)).data;
        const uni = (await call("POST", "/api/groups", { name: "Uni", description: "" }, gina.token)).data;
        const run = await newTask(gina, { name: "Laufen", description: "" });
        const read = await newTask(gina, { name: "Lesen", description: "" });
        await call("POST", `/api/tasks/${run}/groups/${sport.id}`, null, gina.token);
        await call("POST", `/api/tasks/${read}/groups/${uni.id}`, null, gina.token);
        await call("POST", `/api/tasks/${run}/groups/${uni.id}`, null, gina.token);
        // a collection named like a group already: that group isn't taken over a second time
        await call("POST", "/api/tester/collections", { name: "uni" }, gina.token);

        let list = (await call("GET", "/api/tester/collections", null, gina.token)).data;
        assert.equal(list.length, 2);
        const taken = list.find(c => c.name === "Sport");
        assert.equal(taken.color, "green");
        assert.equal(taken.description, "Laufen und so");
        assert.deepEqual(taken.items.map(item => [item.kind, item.id]), [["task", run]]);
        assert.equal(list.find(c => c.name === "uni").items.length, 0);
        assert.equal((await call("GET", "/api/groups", null, gina.token)).data.length, 2, "the groups themselves stay");

        // only once: what is deleted stays deleted
        await call("DELETE", `/api/tester/collections/${taken.id}`, null, gina.token);
        list = (await call("GET", "/api/tester/collections", null, gina.token)).data;
        assert.equal(list.length, 1);

        const learn = (await call("POST", "/api/tester/collections", { name: "Lernen", items: [{ kind: "task", id: read }] }, gina.token)).data;
        await call("POST", "/api/sessions", { totalTime: 1500, workedTasks: [{ id: read, name: "Lesen", time: 1200 }, { id: run, name: "Laufen", time: 300 }] }, gina.token);
        let stats = (await call("GET", "/api/stats", null, gina.token)).data;
        assert.deepEqual(stats.collections.map(c => [c.id, c.ms]), [[learn.id, 1200000]]);
        stats = (await call("GET", "/api/stats", null, plain.token)).data;
        assert.ok(Array.isArray(stats.collections), "for everybody");
    });
});

describe("upload safety and profile pictures", () => {
    let pia, pal, stranger, admin, outsider;
    // 1 × 1 pixel pictures
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const WEBP = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";
    // says PNG, is text
    const FAKE = `data:image/png;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`;

    before(async () => {
        pia = await member("picpia");
        pal = await member("picpal");
        stranger = await member("picstranger");
        admin = await member("picadmin", { admin: true });
        outsider = await member("picout", { pro: false });
        await sql("UPDATE users SET is_tester = true WHERE username = 'picpia'");
        await befriend(pia, pal, "picpal");
    });

    test("the notebook reads big bodies only from signed-in accounts", async () => {
        const big = { body: "x", attachments: [{ kind: "image", data: "data:image/png;base64," + "A".repeat(300 * 1024) }] };
        assert.equal((await call("POST", "/api/notebook", big)).status, 401, "no account: refused before reading it");
        assert.equal((await call("POST", "/api/notebook", big, outsider.token)).data.code, "PRO_REQUIRED");
        // the other routes keep their small limit
        assert.equal((await call("POST", "/api/tasks", { name: "x".repeat(200 * 1024) }, pia.token)).status, 413);
    });

    test("pictures must really be pictures", async () => {
        assert.equal((await call("POST", "/api/notebook", { body: "x", attachments: [{ kind: "image", data: FAKE }] }, pia.token)).data.field, "attachments");
        assert.equal((await call("POST", "/api/notebook", { body: "x", attachments: [{ kind: "image", data: WEBP }] }, pia.token)).status, 201);
    });

    test("all pictures of an account together have a limit", async () => {
        // the test server allows 4000 characters of pictures per account
        const big = "data:image/png;base64," + Buffer.concat([Buffer.from(PNG.split(",")[1], "base64"), Buffer.alloc(1800)]).toString("base64");
        const first = await call("POST", "/api/notebook", { body: "eins", attachments: [{ kind: "image", data: big }] }, pal.token);
        assert.equal(first.status, 201, JSON.stringify(first.data));
        const second = await call("POST", "/api/notebook", { body: "zwei", attachments: [{ kind: "image", data: big }] }, pal.token);
        assert.equal(second.data.code, "NOTEBOOK_STORAGE_FULL");
        // changing the note that holds it doesn't count it twice
        assert.equal((await call("PUT", `/api/notebook/${first.data.id}`, { attachments: [{ kind: "image", data: big }] }, pal.token)).status, 200);
        await call("DELETE", `/api/notebook/${first.data.id}`, null, pal.token);
        assert.equal((await call("POST", "/api/notebook", { body: "drei", attachments: [{ kind: "image", data: big }] }, pal.token)).status, 201);
    });

    test("everybody sets a profile picture (testers' old address still works)", async () => {
        assert.equal((await call("PUT", "/api/profile/avatar", { data: WEBP }, pal.token)).status, 200);
        assert.equal((await call("PUT", "/api/tester/avatar", { data: WEBP }, pal.token)).status, 200, "the old address too");
        assert.equal((await call("PUT", "/api/profile/avatar", { data: WEBP }, outsider.token)).data.code, "PRO_REQUIRED");
        assert.deepEqual(Object.keys((await call("GET", `/api/avatars?ids=${pal.id}`, null, pia.token)).data), [String(pal.id)]);
        await call("DELETE", "/api/profile/avatar", null, pal.token);
    });

    test("friends see a profile picture, strangers don't", async () => {
        assert.equal((await call("PUT", "/api/profile/avatar", { data: FAKE }, pia.token)).data.field, "data");
        assert.equal((await call("PUT", "/api/tester/avatar", { data: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }, pia.token)).data.field, "data", "no GIF");
        const set = await call("PUT", "/api/tester/avatar", { data: WEBP }, pia.token);
        assert.equal(set.status, 200);
        assert.ok(set.data.avatar);

        const forPal = (await call("GET", `/api/avatars?ids=${pia.id},${stranger.id}`, null, pal.token)).data;
        assert.deepEqual(Object.keys(forPal), [String(pia.id)]);
        const res = await fetch(`${API}/api/avatars/${pia.id}?v=1`, { headers: { Authorization: `Bearer ${pal.token}` } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "image/webp");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal(Buffer.from(await res.arrayBuffer()).toString("latin1", 8, 12), "WEBP");

        assert.deepEqual((await call("GET", `/api/avatars?ids=${pia.id}`, null, stranger.token)).data, {});
        assert.equal((await call("GET", `/api/avatars/${pia.id}`, null, stranger.token)).status, 404);
        assert.equal((await call("GET", `/api/avatars?ids=${pia.id}`, null, outsider.token)).data.code, "PRO_REQUIRED");
        assert.equal((await fetch(`${API}/api/avatars/${pia.id}`)).status, 401);
    });

    test("anyone takes their own picture away, an admin anybody's (logged)", async () => {
        await call("PUT", "/api/tester/avatar", { data: PNG }, pia.token);
        assert.equal((await call("GET", "/api/admin/users?q=picpia", null, admin.token)).data.find(u => u.username === "picpia")?.hasAvatar, true);
        assert.equal((await call("DELETE", `/api/admin/users/${pia.id}/avatar`, null, pal.token)).status, 403);
        assert.equal((await call("DELETE", `/api/admin/users/${pia.id}/avatar`, null, admin.token)).status, 200);
        const log = await sql("SELECT action, target_username FROM admin_actions WHERE action = 'remove_avatar'");
        assert.deepEqual(log.at(-1), { action: "remove_avatar", target_username: "picpia" });
        assert.deepEqual((await call("GET", `/api/avatars?ids=${pia.id}`, null, pal.token)).data, {});

        await call("PUT", "/api/tester/avatar", { data: PNG }, pia.token);
        assert.equal((await call("DELETE", "/api/profile/avatar", null, pia.token)).status, 200);
        assert.equal((await sql("SELECT count(*)::int AS n FROM user_avatars WHERE user_id = $1", [pia.id]))[0].n, 0);
    });
});

describe("notes on the board of a family or a shared session", () => {
    let bea, ben, bob, familyId, sessionId, beaNote, benNote;
    const WEBP = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";
    before(async () => {
        bea = await member("boardbea");
        ben = await member("boardben");
        bob = await member("boardbob");
        // the trash is in the notes area (testers)
        await sql("UPDATE users SET is_tester = true WHERE username = 'boardbea'");
        await befriend(bea, ben, "boardben");
        familyId = (await call("POST", "/api/families", { name: "Board-WG", friendIds: [ben.id] }, bea.token)).data.id;
        await call("POST", `/api/families/${familyId}/join`, null, ben.token);
        sessionId = (await call("POST", "/api/shared-sessions", { name: "Board-Lernen", friendIds: [ben.id] }, bea.token)).data.id;
        await call("POST", `/api/shared-sessions/${sessionId}/join`, null, ben.token);
        beaNote = (await call("POST", "/api/notebook", { title: "Formeln", body: "a² + b² = c²", attachments: [{ kind: "image", data: WEBP, name: "skizze" }] }, bea.token)).data;
        benNote = (await call("POST", "/api/notebook", { title: "Einkauf", body: "- [ ] Milch" }, ben.token)).data;
    });

    for (const [kind, base] of [["family", () => `/api/families/${familyId}`], ["session", () => `/api/shared-sessions/${sessionId}`]]) {
        test(`${kind}: a member pins an own note, the others read it as it is now`, async () => {
            const B = `${base()}/board`;
            assert.equal((await call("POST", B, { noteId: benNote.id }, bea.token)).status, 404, "only my own notes");
            assert.equal((await call("POST", B, { noteId: "x" }, bea.token)).data.field, "noteId");
            assert.equal((await call("GET", B, null, bob.token)).status, 404, "not a member");
            assert.equal((await call("POST", B, { noteId: beaNote.id }, bob.token)).status, 404);

            const pin = await call("POST", B, { noteId: beaNote.id }, bea.token);
            assert.equal(pin.status, 201);
            assert.equal((await call("POST", B, { noteId: beaNote.id }, bea.token)).status, 200, "again: the same pin");
            let board = (await call("GET", B, null, ben.token)).data;
            assert.equal(board.length, 1);
            assert.equal(board[0].title, "Formeln");
            assert.equal(board[0].owner.username, "boardbea");
            assert.equal(board[0].mine, false);
            assert.deepEqual(board[0].attachments, [{ kind: "image", name: "skizze" }], "the list leaves the pictures' data out");
            const one = (await call("GET", `${B}/${pin.data.id}`, null, ben.token)).data;
            assert.equal(one.attachments[0].data, WEBP);

            // edits show; where it is pinned is known to the owner only
            await call("PUT", `/api/notebook/${beaNote.id}`, { body: "neu" }, bea.token);
            board = (await call("GET", B, null, ben.token)).data;
            assert.equal(board[0].body, "neu");
            const where = (await call("GET", `/api/notebook/${beaNote.id}/boards`, null, bea.token)).data;
            assert.ok(where.some(item => item.kind === kind && item.pinId === pin.data.id));
            assert.equal((await call("GET", `/api/notebook/${beaNote.id}/boards`, null, ben.token)).status, 404);

            // ben's pin: bea (the owner) takes it off; ben can't take bea's
            const benPin = (await call("POST", B, { noteId: benNote.id }, ben.token)).data;
            assert.equal((await call("DELETE", `${B}/${pin.data.id}`, null, ben.token)).data.code, "NOT_ALLOWED");
            assert.equal((await call("DELETE", `${B}/${benPin.id}`, null, bea.token)).status, 200);
            assert.deepEqual((await call("GET", B, null, bea.token)).data.map(item => item.noteId), [beaNote.id]);

            // in the trash: not shown; back: shown again
            await call("PUT", `/api/notebook/${beaNote.id}`, { trashed: true }, bea.token);
            assert.equal((await call("GET", B, null, ben.token)).data.length, 0);
            await call("PUT", `/api/notebook/${beaNote.id}`, { trashed: false }, bea.token);
            assert.equal((await call("GET", B, null, ben.token)).data.length, 1);
        });
    }

    test("a note of somebody who left isn't shown; deleting the note takes it off", async () => {
        const B = `/api/families/${familyId}/board`;
        await call("POST", B, { noteId: benNote.id }, ben.token);
        assert.equal((await call("GET", B, null, bea.token)).data.length, 2);
        await call("DELETE", `/api/families/${familyId}/members/${ben.id}`, null, ben.token);
        assert.deepEqual((await call("GET", B, null, bea.token)).data.map(item => item.noteId), [beaNote.id]);

        await call("DELETE", `/api/notebook/${beaNote.id}`, null, bea.token);
        assert.equal((await call("GET", B, null, bea.token)).data.length, 0);
        assert.equal((await sql("SELECT count(*)::int AS n FROM board_notes WHERE note_id = $1", [beaNote.id]))[0].n, 0);
    });

    test("an ended session's board can be read, not pinned to", async () => {
        const note = (await call("POST", "/api/notebook", { title: "Rest", body: "x" }, bea.token)).data;
        await call("POST", `/api/shared-sessions/${sessionId}/end`, null, bea.token);
        assert.equal((await call("POST", `/api/shared-sessions/${sessionId}/board`, { noteId: note.id }, bea.token)).data.code, "SESSION_ENDED");
        assert.equal((await call("GET", `/api/shared-sessions/${sessionId}/board`, null, ben.token)).status, 200);
    });
});

describe("the arcade: scores and the leaderboard", () => {
    let ace, bo, waiting;
    const send = (who, body) => call("POST", "/api/arcade/scores", { game: "reflex", level: "normal", ranked: true, ...body }, who.token);
    const board = (who, game = "reflex", level = "normal") => call("GET", `/api/arcade/leaderboard?game=${game}&level=${level}`, null, who.token);
    before(async () => {
        ace = await member("arcadeace");
        bo = await member("arcadebo");
        // signed in, still waiting for beta access: the arcade is open for them too
        waiting = await member("arcadewait", { pro: false });
    });

    test("anybody signed in plays, even while waiting for access; not signed in: no", async () => {
        assert.equal((await call("POST", "/api/arcade/scores", { game: "reflex", level: "normal", score: 1, ranked: false })).status, 401);
        assert.equal((await send(waiting, { score: 40 })).status, 200);
        assert.equal((await call("GET", "/api/tasks", null, waiting.token)).data.code, "PRO_REQUIRED", "the app itself stays closed");
    });

    test("scores are checked: a known game and difficulty, a whole number within reach", async () => {
        assert.equal((await send(ace, { game: "chess" })).data.field, "game");
        assert.equal((await send(ace, { game: "reflex", level: "hard", score: 3 })).data.field, "game", "reflex has one difficulty");
        assert.equal((await send(ace, { score: 1.5 })).data.field, "score");
        assert.equal((await send(ace, { score: 100000 })).data.field, "score");
        assert.equal((await send(ace, { score: 5, ranked: "yes" })).data.field, "ranked");
    });

    test("not ranked: only my personal best; ranked: the leaderboard too", async () => {
        let saved = (await send(ace, { score: 90, ranked: false })).data;
        assert.deepEqual(saved, { best: 90, rankedBest: null, rank: null });
        assert.equal((await board(bo)).data.top.some(row => row.user.username === "arcadeace"), false);

        saved = (await send(ace, { score: 50 })).data;
        assert.equal(saved.best, 90, "a lower score doesn't lower the best");
        assert.equal(saved.rankedBest, 50);
        await send(bo, { score: 70 });
        // equal to ace later: ace stays ahead
        await send(waiting, { score: 50 });

        const list = (await board(ace)).data;
        assert.deepEqual(list.top.map(row => [row.user.username, row.score]), [["arcadebo", 70], ["arcadeace", 50], ["arcadewait", 50]]);
        assert.equal(list.top[1].me, true);
        assert.deepEqual(list.me, { rank: 2, score: 50 });
        assert.equal(list.top[0].user.email, undefined, "only public fields");

        const mine = (await call("GET", "/api/arcade/me", null, ace.token)).data;
        assert.deepEqual(mine, [{ game: "reflex", level: "normal", best: 90, rankedBest: 50, plays: 2 }]);
    });

    test("quiz games have a board per difficulty; leaving takes me off every board", async () => {
        await send(ace, { game: "guess", level: "hard", score: 4 });
        assert.equal((await board(ace, "guess", "hard")).data.me.rank, 1);
        assert.equal((await board(ace, "guess", "easy")).data.top.length, 0);

        assert.equal((await call("DELETE", "/api/arcade/ranked", null, ace.token)).status, 200);
        assert.equal((await board(bo)).data.top.some(row => row.user.username === "arcadeace"), false);
        assert.equal((await board(ace)).data.me, null);
        assert.equal((await call("GET", "/api/arcade/me", null, ace.token)).data.find(row => row.game === "reflex").best, 90, "the personal best stays");
    });
});

describe("sign in with Google", () => {
    const nonce = async () => (await call("GET", "/api/auth/google/nonce")).data.nonce;
    const signIn = async (claims) => call("POST", "/api/auth/google", { idToken: googleToken({ nonce: await nonce(), ...claims }) });
    const consents = { accept_terms: true, accept_privacy: true, confirm_age: true };

    test("a new Google account asks for the rest, then signs in; the nonce works once", async () => {
        const n = await nonce();
        const idToken = googleToken({ sub: "g-new-1", email: "gnew@example.com", name: "Gina New", nonce: n });
        const first = await call("POST", "/api/auth/google", { idToken });
        assert.equal(first.status, 200);
        assert.equal(first.data.signup.email, "gnew@example.com");
        assert.equal(first.data.signup.username, "gnew");
        assert.equal((await call("POST", "/api/auth/google", { idToken })).data.code, "GOOGLE_INVALID", "used up");

        const form = { signupToken: first.data.signup.token, username: "gina", display_name: "Gina", birth_date: "2000-01-01", ...consents };
        assert.equal((await call("POST", "/api/auth/google/register", { ...form, birth_date: daysFromToday(-365 * 10) })).data.code, "TOO_YOUNG");
        assert.equal((await call("POST", "/api/auth/google/register", { ...form, accept_terms: false })).data.code, "TERMS_REQUIRED");
        assert.equal((await call("POST", "/api/auth/google/register", { ...form, signupToken: "x" })).data.code, "GOOGLE_SIGNUP_EXPIRED");
        const made = await call("POST", "/api/auth/google/register", form);
        assert.equal(made.status, 201);
        const [row] = await sql("SELECT email_verified, has_password, google_sub, is_tester, is_pro FROM users WHERE username = 'gina'");
        assert.deepEqual(row, { email_verified: true, has_password: false, google_sub: "g-new-1", is_tester: false, is_pro: false });
        const me = (await call("GET", "/api/me", null, made.data.token)).data;
        assert.equal(me.isPro, false, "closed beta: no access yet");
        assert.equal(me.hasPassword, false);
        assert.equal(me.googleLinked, true);
        assert.equal((await call("POST", "/api/login", { username: "gina", password: PW })).status, 401, "no password to sign in with");

        const again = await signIn({ sub: "g-new-1", email: "gnew@example.com" });
        assert.equal(again.data.username, "gina");
    });

    test("a token for another client, without a confirmed address or a nonce of ours is refused", async () => {
        assert.equal((await signIn({ sub: "g-x", email: "x@example.com", aud: "someone-else" })).data.code, "GOOGLE_INVALID");
        assert.equal((await signIn({ sub: "g-x", email: "x@example.com", email_verified: false })).data.code, "GOOGLE_INVALID");
        const forged = googleToken({ sub: "g-x", email: "x@example.com", nonce: "made-up" });
        assert.equal((await call("POST", "/api/auth/google", { idToken: forged })).data.code, "GOOGLE_INVALID");
    });

    test("an existing account is found by its address; an unconfirmed one loses its password", async () => {
        const ok = await member("gold");
        const linked = await signIn({ sub: "g-gold", email: "GOLD@example.com" });
        assert.equal(linked.data.username, "gold");
        assert.equal((await call("POST", "/api/login", { username: "gold", password: PW })).status, 200, "a confirmed account keeps its password");
        assert.equal((await call("GET", "/api/users", null, ok.token)).status, 200, "and its logins");
        assert.equal((await signIn({ sub: "g-other", email: "gold@example.com" })).data.code, "GOOGLE_OTHER_ACCOUNT");

        await register("squatter", "victim@example.com");
        const taken = await signIn({ sub: "g-victim", email: "victim@example.com" });
        assert.equal(taken.data.username, "squatter");
        assert.equal((await call("POST", "/api/login", { username: "squatter", password: PW })).status, 401, "whoever made it can't get in any more");
        const [row] = await sql("SELECT email_verified, has_password FROM users WHERE username = 'squatter'");
        assert.deepEqual(row, { email_verified: true, has_password: false });
    });

    test("an account without a password sets its first one freely and deletes itself with its username", async () => {
        const make = async (sub, username) => {
            const signup = (await signIn({ sub, email: `${username}@example.com` })).data.signup;
            return (await call("POST", "/api/auth/google/register", { signupToken: signup.token, username, display_name: "G", birth_date: "1990-01-01", ...consents })).data;
        };
        const made = await make("g-del", "gdel");
        assert.equal((await call("DELETE", "/api/users", { password: "x" }, made.token)).data.code, "WRONG_USERNAME");
        const set = await call("PUT", "/api/users/password", { newPassword: "a-new-password" }, made.token);
        assert.equal(set.status, 200);
        assert.equal((await call("POST", "/api/login", { username: "gdel", password: "a-new-password" })).status, 200);
        assert.equal((await call("PUT", "/api/users/password", { newPassword: "another-pass" }, set.data.token)).data.code, "WRONG_PASSWORD", "now it needs the current one");

        const made2 = await make("g-del2", "gdel2");
        assert.equal((await call("DELETE", "/api/users", { confirmUsername: "nope" }, made2.token)).data.code, "WRONG_USERNAME");
        assert.equal((await call("DELETE", "/api/users", { confirmUsername: "GDEL2" }, made2.token)).status, 200);
    });
});

describe("access: testers, Pro and admins", () => {
    test("beta access makes a tester; Pro is paid (pro_until) or a gift; taking tester away ends the access", async () => {
        const tess = await member("tessa", { pro: false });
        const boss = await member("tessboss", { admin: true });
        assert.equal((await call("GET", "/api/tasks", null, tess.token)).data.code, "PRO_REQUIRED");
        await call("POST", "/api/beta-requests", { reason: "I want to try it out please" }, tess.token);
        await call("POST", `/api/admin/requests/${tess.id}/approve`, null, boss.token);
        const [row] = await sql("SELECT is_tester, is_pro FROM users WHERE id = $1", [tess.id]);
        assert.deepEqual(row, { is_tester: true, is_pro: false });
        const me = (await call("GET", "/api/me", null, tess.token)).data;
        assert.equal(me.isPro, true, "may use the app");
        assert.equal(me.isTester, true);
        assert.equal(me.pro.active, false);
        assert.equal(me.accessMode, "beta");
        assert.equal(me.limits, null);

        await call("PATCH", `/api/admin/users/${tess.id}`, { isTester: false }, boss.token);
        assert.equal((await call("GET", "/api/tasks", null, tess.token)).data.code, "PRO_REQUIRED");

        // paid: the account is read fresh after a payment (the cache is skipped by signing in anew is
        // not enough, so this waits out nothing: /api/me reads the row itself)
        await sql("UPDATE users SET pro_until = now() + interval '30 days' WHERE id = $1", [tess.id]);
        const proMe = (await call("GET", "/api/me", null, tess.token)).data;
        assert.equal(proMe.isPro, true, "paid Pro gets in");
        assert.equal(proMe.isTester, false, "but sees nothing in test");
        assert.equal(proMe.pro.active, true);
    });
});

describe("Android app: push through Firebase", () => {
    const token = "fcm-token_abc:DEF-0123456789xyz";
    test("a device signs up with its FCM token and no keys; pushes to it are logged as the app's", async () => {
        const ana = await member("fcmana");
        assert.equal((await call("PUT", "/api/push/subscription", { endpoint: `fcm:${token}`, keys: { p256dh: "a", auth: "b" } }, ana.token)).data.field, "keys");
        assert.equal((await call("PUT", "/api/push/subscription", { endpoint: "fcm:short" }, ana.token)).data.field, "endpoint");
        const saved = await call("PUT", "/api/push/subscription", { endpoint: `fcm:${token}` }, ana.token);
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.data.kinds, { plan: true, digest: true, messages: true, social: true, groups: true, study: true });
        assert.equal((await call("POST", "/api/push/test", { endpoint: `fcm:${token}` }, ana.token)).data.sent, true);
        const line = `[DEV] Push to user ${ana.id} (plan, app): Quidey`;
        for (let i = 0; i < 20 && !log.includes(line); i++) await sleep(50);
        assert.ok(log.includes(line));
        assert.equal((await call("DELETE", "/api/push/subscription", { endpoint: `fcm:${token}` }, ana.token)).status, 200);
        assert.equal((await sql("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [ana.id]))[0].n, 0);
    });
});

describe("Quidey Pro: billing", () => {
    test("without payments set up: the status answers, buying says it's off; anyone signed in may ask", async () => {
        const out = await member("buyer", { pro: false });
        const status = (await call("GET", "/api/billing", null, out.token)).data;
        assert.equal(status.active, false);
        assert.equal(status.stripe, false);
        assert.equal(status.play, false);
        assert.deepEqual(status.prices, { currency: "EUR", monthly: 2.99, yearly: 25 });
        assert.match(status.playAccountId, /^[0-9a-f]{64}$/);
        assert.equal((await call("POST", "/api/billing/checkout", { plan: "monthly" }, out.token)).data.code, "BILLING_DISABLED");
        assert.equal((await call("POST", "/api/billing/play", { purchaseToken: "abcdefghijkl" }, out.token)).data.code, "BILLING_DISABLED");
        assert.equal((await call("GET", "/api/billing")).status, 401);
        assert.equal((await fetch(`${API}/api/billing/play-notifications?token=x`, { method: "POST" })).status, 403);
    });

    test("a running subscription gives Pro until its end; a cancelled one runs to its end", async () => {
        const sub = await member("subber", { pro: false });
        await sql(
            `INSERT INTO subscriptions (user_id, provider, provider_id, plan, status, current_period_end, cancel_at_period_end)
            VALUES ($1, 'stripe', 'sub_test_1', 'yearly', 'active', now() + interval '200 days', true)`,
            [sub.id]
        );
        await sql("UPDATE users SET pro_until = (SELECT current_period_end FROM subscriptions WHERE provider_id = 'sub_test_1') WHERE id = $1", [sub.id]);
        const status = (await call("GET", "/api/billing", null, sub.token)).data;
        assert.equal(status.active, true);
        assert.equal(status.subscription.plan, "yearly");
        assert.equal(status.subscription.cancelAtPeriodEnd, true);
    });

    test("the cancel button needs no sign-in, confirms right away and never says whether an account matched", async () => {
        assert.equal((await call("POST", "/api/billing/cancel", { name: "", email: "x@example.com" })).data.field, "name");
        assert.equal((await call("POST", "/api/billing/cancel", { name: "A", email: "x@example.com", reason: "extraordinary" })).data.field, "explanation");
        const res = await call("POST", "/api/billing/cancel", { name: "Nobody", email: "nobody@example.com", reason: "ordinary" });
        assert.equal(res.status, 200);
        assert.equal(res.data.received, true);
        const line = "[DEV] Cancellation confirmation to nobody@example.com (matched 0)";
        for (let i = 0; i < 20 && !log.includes(line); i++) await sleep(50);
        assert.ok(log.includes(line));
    });
});

describe("Reminders (testers): once or on weekdays, pushed except to devices that ring them", () => {
    let rita, rolf, plain;
    const web = { endpoint: "https://push.example.com/send/reminder-web", keys: { p256dh: "BKeyRemind_-x", auth: "authRemind" } };
    const phone = "fcm:reminderphonetoken_abcdefghijklmnop";
    const R = "/api/tester/reminders";
    const pushesFor = (user, text) => log.split("\n").filter(line => line.includes(`[DEV] Push to user ${user.id} (plan`) && line.includes(text));
    async function waitForPushes(user, text, n = 1) {
        for (let i = 0; i < 40 && pushesFor(user, text).length < n; i++) await sleep(100);
        return pushesFor(user, text);
    }

    before(async () => {
        rita = await member("remrita");
        rolf = await member("remrolf");
        plain = await member("remplain");
        await sql("UPDATE users SET is_tester = true WHERE id = ANY($1)", [[rita.id, rolf.id]]);
    });

    test("for everybody, and the input is checked", async () => {
        const soon = new Date(Date.now() + 3600e3).toISOString();
        assert.equal((await call("GET", R, null, plain.token)).status, 200);
        assert.equal((await call("POST", R, { text: "", at: soon }, rita.token)).data.field, "text");
        assert.equal((await call("POST", R, { text: "x" }, rita.token)).data.field, "at");
        assert.equal((await call("POST", R, { text: "x", at: "bald" }, rita.token)).data.field, "at");
        assert.equal((await call("POST", R, { text: "x", at: new Date(Date.now() - 3600e3).toISOString() }, rita.token)).data.field, "at");
        assert.equal((await call("POST", R, { text: "x", days: [], atTime: "07:30" }, rita.token)).data.field, "days");
        assert.equal((await call("POST", R, { text: "x", days: [8], atTime: "07:30" }, rita.token)).data.field, "days");
        assert.equal((await call("POST", R, { text: "x", days: [1], atTime: "7.30" }, rita.token)).data.field, "atTime");
        assert.equal((await call("POST", R, { text: "x", at: soon, days: [1], atTime: "07:30" }, rita.token)).data.field, "at");
        assert.equal((await call("POST", R, { text: "x".repeat(201), at: soon }, rita.token)).data.field, "text");
    });

    test("create, list, edit, done, delete; somebody else's stays hidden", async () => {
        const at = new Date(Date.now() + 3600e3).toISOString();
        let r = await call("POST", R, { text: "Mama anrufen", at }, rita.token);
        assert.equal(r.status, 201);
        const once = r.data;
        assert.equal(once.text, "Mama anrufen");
        assert.equal(once.at, at);
        assert.equal(once.days, null);
        r = await call("POST", R, { text: "Tabletten", days: [5, 1, 1], atTime: "07:30" }, rita.token);
        const weekly = r.data;
        assert.deepEqual(weekly.days, [1, 5]);
        assert.equal(weekly.atTime, "07:30");
        assert.equal(weekly.at, null);

        let list = (await call("GET", R, null, rita.token)).data;
        assert.deepEqual(list.map(x => x.id).sort(), [once.id, weekly.id].sort());
        assert.equal((await call("GET", R, null, rolf.token)).data.length, 0);
        assert.equal((await call("PATCH", `${R}/${once.id}`, { text: "nope" }, rolf.token)).status, 404);
        assert.equal((await call("DELETE", `${R}/${once.id}`, null, rolf.token)).status, 404);

        // once -> weekly and back
        r = await call("PATCH", `${R}/${once.id}`, { days: [2], atTime: "18:00" }, rita.token);
        assert.equal(r.data.at, null);
        assert.deepEqual(r.data.days, [2]);
        r = await call("PATCH", `${R}/${once.id}`, { text: "Papa anrufen", at }, rita.token);
        assert.equal(r.data.text, "Papa anrufen");
        assert.equal(r.data.days, null);

        // done: a once reminder ends (still listed for 7 days), a weekly one goes on
        r = await call("POST", `${R}/${once.id}/done`, null, rita.token);
        assert.ok(r.data.doneAt);
        r = await call("POST", `${R}/${weekly.id}/done`, null, rita.token);
        assert.equal(r.data.doneAt, null);
        list = (await call("GET", R, null, rita.token)).data;
        assert.equal(list.length, 2);
        assert.equal(list.at(-1).id, once.id, "done ones last");

        assert.equal((await call("POST", `${R}/${weekly.id}/snooze`, { minutes: 0 }, rita.token)).data.field, "minutes");
        r = await call("POST", `${R}/${weekly.id}/snooze`, { minutes: 10 }, rita.token);
        assert.ok(Date.parse(r.data.snoozedUntil) > Date.now() + 9 * 60e3);

        assert.equal((await call("DELETE", `${R}/${once.id}`, null, rita.token)).status, 200);
        assert.equal((await call("DELETE", `${R}/${weekly.id}`, null, rita.token)).status, 200);
        assert.equal((await call("GET", R, null, rita.token)).data.length, 0);
    });

    test("a due reminder is pushed once, to the browser but not to the phone that rings it", async () => {
        assert.equal((await call("PUT", "/api/push/subscription", web, rolf.token)).status, 200);
        assert.equal((await call("PUT", "/api/push/subscription", { endpoint: phone }, rolf.token)).status, 200);
        let r = await call("PUT", `${R}/device`, { endpoint: phone, alarms: true }, rolf.token);
        assert.deepEqual(r.data, { alarms: true, known: true });
        assert.equal((await call("PUT", `${R}/device`, { endpoint: phone, alarms: "yes" }, rolf.token)).data.field, "alarms");
        assert.equal((await call("PUT", `${R}/device`, { endpoint: "fcm:unknown_device_token_123456", alarms: true }, rolf.token)).data.known, false);

        r = await call("POST", R, { text: "Wäsche aufhängen", at: new Date(Date.now() + 300).toISOString() }, rolf.token);
        const pushes = await waitForPushes(rolf, "Wäsche aufhängen");
        await sleep(600);
        assert.equal(pushesFor(rolf, "Wäsche aufhängen").length, 1, "once, and only to the browser");
        assert.ok(!pushes[0].includes(", app)"), "not to the phone");
        const row = (await sql("SELECT fired_for, done_at FROM reminders WHERE id = $1", [r.data.id]))[0];
        assert.ok(row.fired_for);
        assert.equal(row.done_at, null, "still open until confirmed");

        // snoozed: rings again
        await sql("UPDATE reminders SET snoozed_until = now() + interval '300 milliseconds' WHERE id = $1", [r.data.id]);
        assert.equal((await waitForPushes(rolf, "Wäsche aufhängen", 2)).length, 2);
        assert.equal((await sql("SELECT snoozed_until FROM reminders WHERE id = $1", [r.data.id]))[0].snoozed_until, null);

        // without alarms the phone gets the push too
        await call("PUT", `${R}/device`, { endpoint: phone, alarms: false }, rolf.token);
        await call("POST", R, { text: "Blumen gießen", at: new Date(Date.now() + 300).toISOString() }, rolf.token);
        assert.equal((await waitForPushes(rolf, "Blumen gießen", 2)).length, 2);
    });

    test("a weekly reminder rings on the weekday at its time, once", async () => {
        await sql("UPDATE users SET timezone = 'UTC' WHERE id = $1", [rita.id]);
        await call("PUT", "/api/push/subscription", { ...web, endpoint: `${web.endpoint}-rita` }, rita.token);
        const now = new Date();
        const today = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
        const r = await call("POST", R, { text: "Wochenplan machen", days: [today], atTime: "12:00" }, rita.token);
        // its time today: a minute ago (set directly: the API takes only HH:MM)
        await sql("UPDATE reminders SET at_time = (now() AT TIME ZONE 'UTC')::time - interval '1 minute' WHERE id = $1", [r.data.id]);
        assert.equal((await waitForPushes(rita, "Wochenplan machen")).length, 1);
        await sleep(600);
        assert.equal(pushesFor(rita, "Wochenplan machen").length, 1);
    });

    test("done ones are deleted after 30 days", async () => {
        const r = await call("POST", R, { text: "Alt", at: new Date(Date.now() + 3600e3).toISOString() }, rita.token);
        await sql("UPDATE reminders SET done_at = now() - interval '31 days' WHERE id = $1", [r.data.id]);
        assert.ok(!(await call("GET", R, null, rita.token)).data.some(x => x.id === r.data.id));
        assert.equal((await sql("SELECT count(*)::int AS n FROM reminders WHERE id = $1", [r.data.id]))[0].n, 0);
    });
});

describe("study goals", () => {
    const S = "/api/tester/study";
    let tess, other, plain;

    before(async () => {
        tess = await member("studytess");
        other = await member("studyother");
        plain = await member("studyplain");
        await sql("UPDATE users SET is_tester = true WHERE id = ANY($1)", [[tess.id, other.id]]);
        await sql("UPDATE users SET is_tester = false WHERE id = $1", [plain.id]);
    });

    const newSubject = async (user, name) => (await call("POST", `${S}/subjects`, { name, color: "blue" }, user.token)).data;
    const newGoal = async (user, subjectId, extra = {}) => {
        const r = await call("POST", `${S}/goals`, {
            subjectId, kind: "exam", name: "Klausur", due: daysFromToday(10), planMode: "days",
            parts: [{ name: "A", estimateMinutes: 60, estimateSource: "manual" }, { name: "B", estimateMinutes: 90 }, { name: "C", estimateMinutes: 120 }],
            ...extra,
        }, user.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return (await call("GET", `${S}/goals/${r.data.id}`, null, user.token)).data;
    };
    // a planned session of a part: kind task with goal_part_id
    const session = async (user, partId, due, extra = {}) => (await sql(
        `INSERT INTO tasks (name, kind, user_id, due, duration_minutes, goal_part_id, done) VALUES ('S', 'task', $1, $2, 45, $3, $4) RETURNING id`,
        [user.id, due, partId, !!extra.done]))[0].id;

    test("for everybody with app access", async () => {
        assert.equal((await call("GET", `${S}/subjects`, null, plain.token)).status, 200);
    });

    test("study routes count against the overall /api rate limit", async () => {
        const res = await fetch(`${API}${S}/subjects`, { headers: { Authorization: `Bearer ${tess.token}` } });
        assert.equal(res.status, 200);
        assert.ok(res.headers.get("ratelimit-policy"), "the global limiter answered");
    });

    test("subjects: create, duplicate names, patch, list with next goal", async () => {
        const sub = await newSubject(tess, "Mathe");
        assert.equal(sub.name, "Mathe");
        assert.equal(sub.archived, false);
        assert.equal((await call("POST", `${S}/subjects`, { name: "  mathe " }, tess.token)).status, 400);
        assert.equal((await call("POST", `${S}/subjects`, { name: "" }, tess.token)).data.code, "invalid_input");
        assert.equal((await call("POST", `${S}/subjects`, { name: "x".repeat(61) }, tess.token)).data.code, "invalid_input");
        assert.equal((await newSubject(other, "Mathe")).name, "Mathe", "names are per user");
        const goal = await newGoal(tess, sub.id, { name: "Analysis  \n 1" });
        assert.equal(goal.name, "Analysis 1");
        const list = (await call("GET", `${S}/subjects`, null, tess.token)).data;
        const mine = list.find(s => s.id === sub.id);
        assert.equal(mine.nextGoal.id, goal.id);
        assert.equal(mine.nextGoal.progress, 0);
        assert.equal(mine.nextGoal.behindMinutes, 0);
        const r = await call("PATCH", `${S}/subjects/${sub.id}`, { name: "Mathematik", archived: true }, tess.token);
        assert.equal(r.data.name, "Mathematik");
        assert.equal(r.data.archived, true);
        assert.equal((await call("PATCH", `${S}/subjects/${sub.id}`, { color: "beige" }, tess.token)).status, 400);
    });

    test("an exam gets a review part last; validation errors", async () => {
        const sub = await newSubject(tess, "Physik");
        const goal = await newGoal(tess, sub.id);
        assert.equal(goal.parts.length, 4);
        const last = goal.parts.at(-1);
        assert.equal(last.role, "review");
        assert.equal(last.estimateMinutes, 60);
        assert.equal(last.estimateSource, "default");
        assert.deepEqual(goal.parts.map(p => p.position), [0, 1, 2, 3]);
        assert.equal(goal.parts[0].credit, 0);
        assert.equal(goal.parts[0].remaining, 60);
        assert.equal(goal.due, daysFromToday(10));
        assert.equal(goal.status, "active");

        const base = { subjectId: sub.id, kind: "assignment", name: "Hausarbeit", due: daysFromToday(5), planMode: "days", parts: [{ name: "x", estimateMinutes: 60 }] };
        assert.equal((await call("POST", `${S}/goals`, { ...base, due: daysFromToday(-1) }, tess.token)).data.code, "due_in_past");
        assert.equal((await call("POST", `${S}/goals`, { ...base, parts: [] }, tess.token)).data.code, "no_parts");
        assert.equal((await call("POST", `${S}/goals`, { ...base, parts: [{ name: "x", estimateMinutes: 5 }] }, tess.token)).data.code, "invalid_input");
        assert.equal((await call("POST", `${S}/goals`, { ...base, kind: "party" }, tess.token)).data.code, "invalid_input");
        assert.equal((await call("POST", `${S}/goals`, { ...base, parts: Array.from({ length: 41 }, () => ({ name: "x", estimateMinutes: 60 })) }, tess.token)).data.code, "invalid_input");
        const ok = await call("POST", `${S}/goals`, base, tess.token);
        assert.equal(ok.status, 201);
        assert.equal((await call("GET", `${S}/goals/${ok.data.id}`, null, tess.token)).data.parts.length, 1, "no review part for assignments");
        const filtered = (await call("GET", `${S}/goals?subject=${sub.id}`, null, tess.token)).data;
        assert.equal(filtered.length, 2);
    });

    test("another user's ids are 404 on every route", async () => {
        const sub = await newSubject(tess, "Chemie");
        const goal = await newGoal(tess, sub.id);
        const partId = goal.parts[0].id;
        const o = other.token;
        const calls = [
            ["PATCH", `/subjects/${sub.id}`, { name: "Z" }],
            ["DELETE", `/subjects/${sub.id}`],
            ["GET", `/goals/${goal.id}`],
            ["PATCH", `/goals/${goal.id}`, { name: "Z" }],
            ["DELETE", `/goals/${goal.id}?sessions=keep`],
            ["POST", `/goals/${goal.id}/parts`, { name: "Z", estimateMinutes: 30 }],
            ["PATCH", `/parts/${partId}`, { name: "Z" }],
            ["DELETE", `/parts/${partId}`],
            ["PUT", `/goals/${goal.id}/parts/order`, { ids: goal.parts.map(p => p.id) }],
        ];
        const foreignSub = await newSubject(other, "Fremd");
        const mineSub = await newSubject(tess, "Eigen");
        assert.equal((await call("PATCH", `${S}/goals/${goal.id}`, { subjectId: foreignSub.id }, tess.token)).status, 404, "move to somebody else's subject");
        assert.equal((await call("PATCH", `${S}/goals/${goal.id}`, { subjectId: mineSub.id }, tess.token)).status, 200);
        for (const [m, p, b] of calls) assert.equal((await call(m, S + p, b, o)).status, 404, `${m} ${p}`);
        assert.equal((await call("POST", `${S}/goals`, { subjectId: sub.id, kind: "other", name: "x", due: daysFromToday(3), planMode: "days", parts: [{ name: "x", estimateMinutes: 60 }] }, o)).status, 404);
        assert.equal((await call("GET", `${S}/goals?subject=${sub.id}`, null, o)).data.length, 0);
        assert.equal((await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).status, 200, "still there");
    });

    test("parts: add, edit, reorder, delete", async () => {
        const sub = await newSubject(tess, "Info");
        const goal = await newGoal(tess, sub.id);
        let r = await call("POST", `${S}/goals/${goal.id}/parts`, { name: "D", estimateMinutes: 30 }, tess.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        let g = (await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).data;
        assert.equal(g.parts.length, 5);
        const dPart = g.parts.find(p => p.name === "D");
        assert.equal(dPart.estimateSource, "manual");
        r = await call("PATCH", `${S}/parts/${dPart.id}`, { estimateMinutes: 45, name: "D2" }, tess.token);
        assert.equal(r.data.estimateMinutes, 45);
        assert.equal((await call("PATCH", `${S}/parts/${dPart.id}`, { estimateMinutes: 10 }, tess.token)).data.code, "invalid_input");
        const ids = g.parts.map(p => p.id).reverse();
        assert.equal((await call("PUT", `${S}/goals/${goal.id}/parts/order`, { ids }, tess.token)).status, 200);
        g = (await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).data;
        assert.deepEqual(g.parts.map(p => p.id), ids);
        assert.equal((await call("PUT", `${S}/goals/${goal.id}/parts/order`, { ids: ids.slice(1) }, tess.token)).data.code, "invalid_input");
        assert.equal((await call("DELETE", `${S}/parts/${dPart.id}`, null, tess.token)).status, 200);
        g = (await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).data;
        assert.equal(g.parts.length, 4);
    });

    test("goal patch and settings", async () => {
        const sub = await newSubject(tess, "Kunst");
        const goal = await newGoal(tess, sub.id);
        let r = await call("PATCH", `${S}/goals/${goal.id}`, { name: "Neu", dueTime: "10:30", planMode: "slots", status: "archived" }, tess.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        r = await call("GET", `${S}/goals/${goal.id}`, null, tess.token);
        assert.equal(r.data.dueTime, "10:30");
        assert.equal(r.data.planMode, "slots");
        assert.equal(r.data.status, "archived");

        r = await call("GET", `${S}/settings`, null, tess.token);
        assert.deepEqual(r.data.windows, []);
        assert.equal(r.data.sessionMinutes, 45);
        assert.equal(r.data.dailyMaxMinutes, 180);
        assert.equal(r.data.aiAuto, false);
        assert.equal(typeof r.data.aiAvailable, "boolean");
        const windows = [{ weekday: 1, start: "16:00", end: "18:00" }, { weekday: 1, start: "19:00", end: "20:00" }, { weekday: 3, start: "10:00", end: "11:00" }];
        r = await call("PUT", `${S}/settings`, { windows, sessionMinutes: 30, dailyMaxMinutes: 240, aiAuto: true }, tess.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        r = await call("GET", `${S}/settings`, null, tess.token);
        assert.deepEqual(r.data.windows, windows);
        assert.equal(r.data.sessionMinutes, 30);
        assert.equal(r.data.aiAuto, true);
        assert.equal((await call("PUT", `${S}/settings`, { windows: [{ weekday: 2, start: "18:00", end: "17:00" }] }, tess.token)).data.code, "invalid_window");
        assert.equal((await call("PUT", `${S}/settings`, { windows: [{ weekday: 8, start: "10:00", end: "11:00" }] }, tess.token)).data.code, "invalid_window");
        const many = Array.from({ length: 51 }, () => ({ weekday: 1, start: "10:00", end: "11:00" }));
        assert.equal((await call("PUT", `${S}/settings`, { windows: many }, tess.token)).data.code, "invalid_window");
        assert.equal((await call("PUT", `${S}/settings`, { windows, sessionMinutes: 10 }, tess.token)).data.code, "invalid_input");
        assert.equal((await call("GET", `${S}/settings`, null, tess.token)).data.windows.length, 3, "a refused PUT changes nothing");
        assert.equal((await call("GET", `${S}/settings`, null, other.token)).data.windows.length, 0);
    });

    test("deleting a goal keeps or removes its future sessions", async () => {
        const sub = await newSubject(tess, "Latein");
        for (const mode of ["keep", "delete"]) {
            const goal = await newGoal(tess, sub.id, { name: `G-${mode}` });
            const part = goal.parts[0].id;
            const future = await session(tess, part, daysFromToday(3));
            const past = await session(tess, part, daysFromToday(-3));
            const doneToday = await session(tess, part, daysFromToday(0), { done: true });
            const r = await call("DELETE", `${S}/goals/${goal.id}?sessions=${mode}`, null, tess.token);
            assert.equal(r.status, 200, JSON.stringify(r.data));
            assert.equal((await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).status, 404);
            const rows = await sql("SELECT id, goal_part_id FROM tasks WHERE id = ANY($1)", [[future, past, doneToday]]);
            const byId = Object.fromEntries(rows.map(x => [x.id, x]));
            assert.equal(byId[past].goal_part_id, null, "past stays as a plain task");
            assert.equal(byId[doneToday].goal_part_id, null);
            if (mode === "keep") assert.equal(byId[future].goal_part_id, null, "kept as plain task");
            else assert.equal(byId[future], undefined, "future session removed");
        }
        const goal = await newGoal(tess, sub.id);
        assert.equal((await call("DELETE", `${S}/goals/${goal.id}?sessions=maybe`, null, tess.token)).data.code, "invalid_input");
    });

    test("a kept session of a deleted goal is no longer pinned", async () => {
        const sub = await newSubject(tess, "Musik");
        const goal = await newGoal(tess, sub.id);
        const kept = await session(tess, goal.parts[0].id, daysFromToday(3));
        await sql("UPDATE tasks SET plan_pinned = true WHERE id = $1", [kept]);
        assert.equal((await call("DELETE", `${S}/goals/${goal.id}?sessions=keep`, null, tess.token)).status, 200);
        assert.deepEqual((await sql("SELECT goal_part_id, plan_pinned FROM tasks WHERE id = $1", [kept]))[0], { goal_part_id: null, plan_pinned: false });
    });

    test("deleting a subject removes its goals and their future sessions", async () => {
        const sub = await newSubject(tess, "Sport");
        const goal = await newGoal(tess, sub.id);
        const future = await session(tess, goal.parts[0].id, daysFromToday(2));
        const past = await session(tess, goal.parts[0].id, daysFromToday(-2));
        assert.equal((await call("DELETE", `${S}/subjects/${sub.id}`, null, tess.token)).status, 200);
        assert.equal((await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).status, 404);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [future]))[0].n, 0);
        const rows = await sql("SELECT goal_part_id FROM tasks WHERE id = $1", [past]);
        assert.equal(rows[0].goal_part_id, null);
    });

    test("finishing a part credits it and frees its replaceable sessions", async () => {
        const sub = await newSubject(tess, "Geschichte");
        const goal = await newGoal(tess, sub.id);
        const part = goal.parts[0].id; // 60 min
        const doneS = await session(tess, part, daysFromToday(-1), { done: true }); // 45 credit
        const futureS = await session(tess, part, daysFromToday(2));
        const pinnedS = await session(tess, part, daysFromToday(3));
        await sql("UPDATE tasks SET plan_pinned = true WHERE id = $1", [pinnedS]);
        const r = await call("PATCH", `${S}/parts/${part}`, { doneAt: true }, tess.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const row = (await sql("SELECT actual_minutes, done_at FROM goal_parts WHERE id = $1", [part]))[0];
        assert.equal(row.actual_minutes, 45);
        assert.ok(row.done_at);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [futureS]))[0].n, 0, "replaceable removed");
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [pinnedS]))[0].n, 1, "pinned stays");
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [doneS]))[0].n, 1);
        assert.equal((await sql("SELECT freed_minutes FROM goals WHERE id = $1", [goal.id]))[0].freed_minutes, 45);
        const g = (await call("GET", `${S}/goals/${goal.id}`, null, tess.token)).data;
        assert.equal(g.parts[0].remaining, 0);
        assert.equal(g.parts[0].credit, 45);
        assert.ok(g.parts[0].doneAt);
        assert.deepEqual(g.sessions.map(s => s.taskId).sort(), [doneS, pinnedS].sort());

        const re = await call("PATCH", `${S}/parts/${part}`, { doneAt: null }, tess.token);
        assert.equal(re.status, 200);
        const reopened = (await sql("SELECT actual_minutes, done_at FROM goal_parts WHERE id = $1", [part]))[0];
        assert.equal(reopened.done_at, null);
        assert.equal(reopened.actual_minutes, null);
    });
});

describe("study plan", () => {
    const S = "/api/tester/study";
    let count = 0;
    // a fresh tester for each test: all active goals of a user are planned together
    const tester = async () => {
        const user = await member(`planner${++count}`);
        await sql("UPDATE users SET is_tester = true WHERE id = $1", [user.id]);
        return user;
    };
    const subject = async (user, name = "Statistik", extra = {}) => {
        const r = await call("POST", `${S}/subjects`, { name, color: "green", ...extra }, user.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return r.data;
    };
    // an assignment (no review part), parts of 45, 90 and 135 min: six sessions of 45
    const goal = async (user, subjectId, extra = {}) => {
        const r = await call("POST", `${S}/goals`, {
            subjectId, kind: "assignment", name: "Hausarbeit", due: daysFromToday(10), planMode: "days",
            parts: [{ name: "A", estimateMinutes: 45 }, { name: "B", estimateMinutes: 90 }, { name: "C", estimateMinutes: 135 }],
            ...extra,
        }, user.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return (await call("GET", `${S}/goals/${r.data.id}`, null, user.token)).data;
    };
    const preview = async (user) => {
        const r = await call("GET", `${S}/plan`, null, user.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.data;
    };
    const apply = async (user) => {
        const p = await preview(user);
        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, user.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.deepEqual(r.data, { ok: true });
        return p;
    };
    const sessionsOf = (user) => sql(
        `SELECT id, name, color, kind, to_char(due, 'YYYY-MM-DD') AS due, to_char(due_time, 'HH24:MI') AS due_time,
            duration_minutes, goal_part_id, plan_pinned, done, reminders
        FROM tasks WHERE user_id = $1 AND goal_part_id IS NOT NULL ORDER BY due, due_time NULLS FIRST, id`,
        [user.id]
    );
    const snapshot = (user) => sql("SELECT * FROM tasks WHERE user_id = $1 ORDER BY id", [user.id]);
    // a planned session written straight to the database
    const session = async (user, partId, due, extra = {}) => (await sql(
        `INSERT INTO tasks (name, kind, user_id, due, duration_minutes, goal_part_id, done, plan_pinned)
        VALUES ('S', 'task', $1, $2, 45, $3, $4, $5) RETURNING id`,
        [user.id, due, partId, !!extra.done, !!extra.pinned]))[0].id;
    // PUT /api/tasks/:id as the app sends it: the whole task with some fields changed
    const putTask = async (user, id, changes) => {
        const [t] = await sql(
            `SELECT name, to_char(due, 'YYYY-MM-DD') AS due, to_char(due_time, 'HH24:MI') AS due_time,
                duration_minutes, description, prio, COALESCE(done, false) AS done
            FROM tasks WHERE id = $1`,
            [id]
        );
        return call("PUT", `/api/tasks/${id}`, { ...t, ...changes }, user.token);
    };
    const countBy = (list, key) => list.reduce((acc, x) => ({ ...acc, [x[key]]: (acc[x[key]] || 0) + 1 }), {});

    test("a new goal: the preview lists only new sessions, replan writes them and nothing else", async () => {
        const me = await tester();
        const them = await tester();
        const sub = await subject(me);
        const g = await goal(me, sub.id);
        assert.equal((await call("POST", "/api/tasks", { name: "Einkaufen", due: daysFromToday(1) }, me.token)).status, 201);
        assert.equal((await call("POST", "/api/tasks", { name: "Zahnarzt", due: daysFromToday(2), due_time: "10:00", duration_minutes: 30 }, me.token)).status, 201);
        await goal(them, (await subject(them)).id);
        await apply(them);
        const theirs = await snapshot(them);
        const mine = await snapshot(me);

        const p = await preview(me);
        assert.match(p.inputHash, /^[0-9a-f]{64}$/);
        assert.deepEqual(p.shortfall, { [g.id]: 0 });
        assert.equal(p.goals.length, 1);
        const [pg] = p.goals;
        assert.equal(pg.goalId, g.id);
        assert.equal(pg.name, "Hausarbeit");
        assert.deepEqual(pg.summary, { moved: 0, added: 6, dropped: 0, unchanged: 0 });
        assert.ok(pg.changes.every(c => c.type === "new" && c.minutes === 45 && c.to.time === null && !c.from), JSON.stringify(pg.changes));
        assert.ok(pg.changes.every(c => c.to.date >= daysFromToday(0) && c.to.date < g.due));
        assert.deepEqual(countBy(pg.changes, "partName"), { A: 1, B: 2, C: 3 });

        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token);
        assert.deepEqual([r.status, r.data], [200, { ok: true }]);
        const planned = await sessionsOf(me);
        assert.equal(planned.length, 6);
        const partName = Object.fromEntries(g.parts.map(x => [x.id, x.name]));
        for (const s of planned) {
            assert.equal(s.kind, "task");
            assert.equal(s.color, "green", "the subject's colour");
            assert.equal(s.duration_minutes, 45);
            assert.equal(s.due_time, null, "days mode has no time");
            assert.equal(s.plan_pinned, false);
            assert.equal(s.done, false);
            assert.deepEqual(s.reminders, []);
            assert.equal(s.name, partName[s.goal_part_id]);
        }
        assert.deepEqual((await snapshot(me)).filter(t => t.goal_part_id === null), mine, "my ordinary tasks are untouched");
        assert.deepEqual(await snapshot(them), theirs, "somebody else's tasks are untouched");

        const again = await preview(me);
        assert.deepEqual(again.goals[0].summary, { moved: 0, added: 0, dropped: 0, unchanged: 6 });
        assert.deepEqual(again.goals[0].changes, []);
        assert.equal((await call("POST", `${S}/replan`, {}, me.token)).data.code, "invalid_input");
        assert.equal((await call("POST", `${S}/replan`, { inputHash: "0".repeat(64) }, me.token)).status, 409);
    });

    test("an earlier goal moves the first goal's sessions in the preview", async () => {
        const me = await tester();
        const sub = await subject(me);
        const first = await goal(me, sub.id);
        await apply(me);
        // 540 min due in 3 days fill the days before it (daily max 180)
        const second = await goal(me, sub.id, {
            name: "Referat", kind: "presentation", due: daysFromToday(3),
            parts: [{ name: "X", estimateMinutes: 180 }, { name: "Y", estimateMinutes: 180 }, { name: "Z", estimateMinutes: 180 }],
        });
        const p = await preview(me);
        const a = p.goals.find(x => x.goalId === first.id);
        const b = p.goals.find(x => x.goalId === second.id);
        assert.ok(b.changes.length > 0 && b.changes.every(c => c.type === "new"), JSON.stringify(b));
        assert.ok(a.summary.moved > 0, JSON.stringify(a));
        assert.equal(a.summary.added, 0);
        assert.equal(a.summary.dropped, 0);
        assert.equal(a.summary.moved + a.summary.unchanged, 6);
        for (const c of a.changes) {
            assert.equal(c.type, "moved");
            assert.ok(c.from.date !== c.to.date || c.from.time !== c.to.time);
            assert.ok(c.to.date >= daysFromToday(3), "out of the earlier goal's days");
        }
        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const parts = new Set(first.parts.map(x => x.id));
        const firsts = (await sessionsOf(me)).filter(s => parts.has(s.goal_part_id));
        assert.equal(firsts.length, 6);
        assert.ok(firsts.every(s => s.due >= daysFromToday(3)));
    });

    test("the preview lists the whole plan with keys; a session moved there is written there, pinned", async () => {
        const me = await tester();
        const sub = await subject(me);
        await goal(me, sub.id);
        const p = await preview(me);
        const [pg] = p.goals;
        assert.equal(pg.sessions.length, 6);
        assert.ok(pg.sessions.every(s => s.change === "new" && Number.isInteger(s.key) && s.minutes === 45), JSON.stringify(pg.sessions));
        assert.deepEqual(pg.sessions.map(s => s.key).sort(), [0, 1, 2, 3, 4, 5]);

        const [first] = pg.sessions;
        const bad = async (moves) => (await call("POST", `${S}/replan`, { inputHash: p.inputHash, moves }, me.token)).data.code;
        assert.equal(await bad([{ key: first.key, date: "2026-02-30", time: null }]), "invalid_input");
        assert.equal(await bad([{ key: first.key, date: daysFromToday(3), time: "25:00" }]), "invalid_input");
        assert.equal(await bad([{ key: 99, date: daysFromToday(3), time: null }]), "invalid_input");
        assert.equal(await bad([{ key: 0, date: daysFromToday(3) }, { key: 0, date: daysFromToday(4) }]), "invalid_input");
        assert.equal((await sessionsOf(me)).length, 0, "nothing written by a refused apply");

        const target = daysFromToday(9);
        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash, moves: [{ key: first.key, date: target, time: "17:30" }] }, me.token);
        assert.deepEqual([r.status, r.data], [200, { ok: true }]);
        const planned = await sessionsOf(me);
        assert.equal(planned.length, 6);
        const pinned = planned.filter(s => s.plan_pinned);
        assert.equal(pinned.length, 1);
        assert.deepEqual([pinned[0].due, pinned[0].due_time, pinned[0].goal_part_id], [target, "17:30", first.partId]);

        // the pinned one is the user's now: the planner plans around it and never names it
        const again = await preview(me);
        assert.equal(again.goals[0].sessions.length, 5);
        assert.ok(again.goals[0].sessions.every(s => !(s.date === target && s.time === "17:30")));
    });

    test("a session ticked off after the preview: replan answers 409 with a fresh preview and changes nothing", async () => {
        const me = await tester();
        const sub = await subject(me);
        await goal(me, sub.id);
        await apply(me);
        await goal(me, sub.id, { name: "Referat", kind: "presentation", due: daysFromToday(3), parts: [{ name: "X", estimateMinutes: 360 }] });
        const p = await preview(me);
        // meanwhile, on the phone
        const [s] = await sessionsOf(me);
        assert.equal((await putTask(me, s.id, { done: true })).status, 200);
        const before = await snapshot(me);
        const goalsBefore = await sql("SELECT * FROM goals WHERE user_id = $1 ORDER BY id", [me.id]);

        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token);
        assert.equal(r.status, 409);
        assert.equal(r.data.code, "plan_changed");
        assert.match(r.data.preview.inputHash, /^[0-9a-f]{64}$/);
        assert.notEqual(r.data.preview.inputHash, p.inputHash);
        assert.equal(r.data.preview.goals.length, 2);
        assert.deepEqual(await snapshot(me), before, "no task changed");
        assert.deepEqual(await sql("SELECT * FROM goals WHERE user_id = $1 ORDER BY id", [me.id]), goalsBefore, "no goal changed");

        const ok = await call("POST", `${S}/replan`, { inputHash: r.data.preview.inputHash }, me.token);
        assert.equal(ok.status, 200, JSON.stringify(ok.data));
        const [ticked] = await sql("SELECT done FROM tasks WHERE id = $1", [s.id]);
        assert.equal(ticked.done, true, "a done session is kept");
    });

    test("a session moved to another day is pinned and survives the next replan", async () => {
        const me = await tester();
        const sub = await subject(me);
        await goal(me, sub.id);
        await apply(me);
        const pinnedOf = async (id) => (await sql("SELECT plan_pinned FROM tasks WHERE id = $1", [id]))[0].plan_pinned;
        const [ticked, moved, renamed, reminded, timed, resized] = await sessionsOf(me);

        // sending it back unchanged, or only ticking it off, is no edit
        assert.equal((await putTask(me, ticked.id, {})).status, 200);
        assert.equal(await pinnedOf(ticked.id), false);
        const tick = await putTask(me, ticked.id, { done: true });
        assert.equal(tick.status, 200, JSON.stringify(tick.data));
        assert.equal(tick.data.plan_pinned, false, "ticking done alone does not pin");

        const target = moved.due === daysFromToday(8) ? daysFromToday(7) : daysFromToday(8);
        const r = await putTask(me, moved.id, { due: target });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.plan_pinned, true);
        assert.equal(await pinnedOf(moved.id), true);

        // every other edit pins too (ruling 18): a replan would otherwise delete it, notes and all
        assert.equal((await putTask(me, renamed.id, { name: "Kapitel 1" })).data.plan_pinned, true);
        assert.equal((await putTask(me, reminded.id, { reminders: [10] })).data.plan_pinned, true);
        assert.equal((await putTask(me, timed.id, { due_time: "15:00" })).data.plan_pinned, true);
        assert.equal((await putTask(me, resized.id, { duration_minutes: 30 })).data.plan_pinned, true);
        // an ordinary task is never pinned
        const plain = (await call("POST", "/api/tasks", { name: "Wäsche", due: daysFromToday(1) }, me.token)).data;
        assert.equal((await putTask(me, plain.id, { due: daysFromToday(2) })).data.plan_pinned, false);

        await goal(me, sub.id, { name: "Referat", kind: "presentation", due: daysFromToday(3), parts: [{ name: "X", estimateMinutes: 360 }] });
        await apply(me);
        const [after] = await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due, plan_pinned FROM tasks WHERE id = $1", [moved.id]);
        assert.deepEqual(after, { due: target, plan_pinned: true }, "still on that day");
        const rows = Object.fromEntries((await sql(
            "SELECT id, name, reminders, to_char(due_time, 'HH24:MI') AS due_time, duration_minutes, done FROM tasks WHERE id = ANY($1)",
            [[ticked.id, renamed.id, reminded.id, timed.id, resized.id]]
        )).map(x => [x.id, x]));
        assert.equal(rows[ticked.id].done, true);
        assert.equal(rows[renamed.id].name, "Kapitel 1");
        assert.deepEqual(rows[reminded.id].reminders, [10]);
        assert.equal(rows[timed.id].due_time, "15:00");
        assert.equal(rows[resized.id].duration_minutes, 30);
    });

    test("a session with a note, a group, a collection or a share is kept as it is by a replan", async () => {
        const me = await tester();
        const friend = await tester();
        await befriend(me, friend, `planner${count}`);
        const sub = await subject(me);
        await goal(me, sub.id);
        await apply(me);
        const [noted, grouped, collected, shared, plain] = await sessionsOf(me);
        assert.equal((await call("POST", `/api/tasks/${noted.id}/notes`, { content: "Formeln S. 12" }, me.token)).status, 201);
        const group = (await call("POST", "/api/groups", { name: "Uni", description: "" }, me.token)).data;
        assert.ok([200, 201].includes((await call("POST", `/api/tasks/${grouped.id}/groups/${group.id}`, null, me.token)).status));
        assert.equal((await call("POST", "/api/tester/collections", { name: "Lernen", items: [{ kind: "task", id: collected.id }] }, me.token)).status, 201);
        const share = await call("POST", `/api/tasks/${shared.id}/shares`, { userIds: [friend.id] }, me.token);
        assert.ok([200, 201].includes(share.status), JSON.stringify(share.data));
        const kept = [noted.id, grouped.id, collected.id, shared.id];
        const rows = () => sql("SELECT * FROM tasks WHERE id = ANY($1) ORDER BY id", [kept]);
        const before = await rows();
        assert.ok(before.every(r => r.plan_pinned === false), "none was moved or edited");

        // a new earlier goal moves everything that is still the planner's
        await goal(me, sub.id, { name: "Referat", kind: "presentation", due: daysFromToday(3), parts: [{ name: "X", estimateMinutes: 360 }] });
        await apply(me);
        assert.deepEqual(await rows(), before, "kept with the row intact");
        assert.equal((await sql("SELECT count(*)::int AS n FROM notebook_notes WHERE task_id = $1", [noted.id]))[0].n, 1);
        assert.equal((await sql("SELECT count(*)::int AS n FROM task_groups WHERE task_id = $1", [grouped.id]))[0].n, 1);
        assert.equal((await sql("SELECT count(*)::int AS n FROM collection_items WHERE task_id = $1", [collected.id]))[0].n, 1);
        assert.equal((await sql("SELECT count(*)::int AS n FROM task_shares WHERE task_id = $1", [shared.id]))[0].n, 1);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [plain.id]))[0].n, 0, "a session without anything attached is replaced");
    });

    test("a new session length shows as moved in the preview, also on the same day", async () => {
        const me = await tester();
        await goal(me, (await subject(me)).id);
        await apply(me);
        // 45 / 90 / 135 in sessions of 50: A 45, B 50+40, C 50+50+35, on the same days as before
        assert.equal((await call("PUT", `${S}/settings`, { sessionMinutes: 50 }, me.token)).status, 200);
        const [pg] = (await preview(me)).goals;
        assert.deepEqual(pg.summary, { moved: 5, added: 0, dropped: 0, unchanged: 1 }, JSON.stringify(pg));
        for (const c of pg.changes) {
            assert.equal(c.type, "moved");
            assert.notEqual(c.partName, "A");
            assert.deepEqual(c.to, c.from, "same day, new length");
        }
        assert.deepEqual(pg.changes.map(c => c.minutes).sort(), [35, 40, 50, 50, 50]);
    });

    test("apply drops missed sessions, keeps done and pinned ones, resets freed minutes", async () => {
        const me = await tester();
        const sub = await subject(me);
        const g = await goal(me, sub.id);
        const [a, b] = g.parts;
        const missed = await session(me, a.id, daysFromToday(-2));
        const done = await session(me, a.id, daysFromToday(-1), { done: true }); // A (45) is covered
        const pinned = await session(me, b.id, daysFromToday(4), { pinned: true }); // B needs one more
        await sql("UPDATE goals SET freed_minutes = 30 WHERE id = $1", [g.id]);

        const p = await preview(me);
        const [pg] = p.goals;
        assert.deepEqual(pg.summary, { moved: 0, added: 4, dropped: 1, unchanged: 0 });
        const dropped = pg.changes.find(c => c.type === "dropped");
        assert.deepEqual(dropped, { type: "dropped", partName: "A", from: { date: daysFromToday(-2), time: null }, minutes: 45 });
        assert.deepEqual(countBy(pg.changes.filter(c => c.type === "new"), "partName"), { B: 1, C: 3 });

        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const ids = (await sessionsOf(me)).map(s => s.id);
        assert.equal(ids.length, 6);
        assert.ok(!ids.includes(missed), "missed session removed");
        assert.ok(ids.includes(done) && ids.includes(pinned));
        assert.equal((await sql("SELECT freed_minutes FROM goals WHERE id = $1", [g.id]))[0].freed_minutes, 0);
    });

    test("apply detaches a missed session that carries a note instead of deleting it (ruling 28)", async () => {
        const me = await tester();
        const g = await goal(me, (await subject(me)).id);
        const noted = await session(me, g.parts[0].id, daysFromToday(-2), { pinned: true });
        await sql("INSERT INTO notebook_notes (user_id, task_id, body) VALUES ($1, $2, 'Formeln')", [me.id, noted]);
        const plain = await session(me, g.parts[1].id, daysFromToday(-2));
        await apply(me);
        const [row] = await sql("SELECT goal_part_id, plan_pinned FROM tasks WHERE id = $1", [noted]);
        assert.deepEqual(row, { goal_part_id: null, plan_pinned: false }, "kept as a plain task");
        assert.equal((await sql("SELECT count(*)::int AS n FROM notebook_notes WHERE task_id = $1", [noted]))[0].n, 1, "the note survives");
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [plain]))[0].n, 0, "a plain missed session goes");
    });

    test("a goal whose due date is over is left out of preview, status and the subject's next goal", async () => {
        const me = await tester();
        const sub = await subject(me);
        const past = await goal(me, sub.id, { name: "Vorbei" });
        const missed = await session(me, past.parts[0].id, daysFromToday(-3));
        await sql("UPDATE goals SET due = $2 WHERE id = $1", [past.id, daysFromToday(-1)]);
        const p = await preview(me);
        assert.deepEqual(p.goals, [], JSON.stringify(p));
        assert.deepEqual(p.shortfall, {});
        const st = (await call("GET", `${S}/status`, null, me.token)).data;
        assert.deepEqual(st.goals, []);
        const mine = (await call("GET", `${S}/subjects`, null, me.token)).data.find(s => s.id === sub.id);
        assert.equal(mine.nextGoal, null);
        await apply(me);
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [missed]))[0].n, 1, "its history stays");
        // due today still counts
        const today = await goal(me, sub.id, { name: "Heute", due: daysFromToday(1) });
        await sql("UPDATE goals SET due = $2 WHERE id = $1", [today.id, daysFromToday(0)]);
        assert.deepEqual((await preview(me)).goals.map(x => x.goalId), [today.id]);
        const g = (await call("GET", `${S}/goals/${past.id}`, null, me.token)).data;
        assert.equal(g.parts.length, 3, "the goal itself is still there");
    });

    test("a new subject colour recolours that subject's planned sessions", async () => {
        const me = await tester();
        const sub = await subject(me);
        const other = await subject(me, "Andere", { color: "blue" });
        await goal(me, sub.id);
        await goal(me, other.id, { name: "Fremd" });
        await apply(me);
        const r = await call("PATCH", `${S}/subjects/${sub.id}`, { color: "pink" }, me.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const rows = await sql(
            `SELECT tasks.color, goals.subject_id FROM tasks JOIN goal_parts ON goal_parts.id = tasks.goal_part_id
            JOIN goals ON goals.id = goal_parts.goal_id WHERE tasks.user_id = $1`, [me.id]);
        assert.ok(rows.length >= 12);
        for (const row of rows) assert.equal(row.color, row.subject_id === sub.id ? "pink" : "blue");
        assert.equal((await call("PATCH", `${S}/subjects/${sub.id}`, { color: null }, me.token)).status, 200);
        const cleared = await sql(
            `SELECT tasks.color FROM tasks JOIN goal_parts ON goal_parts.id = tasks.goal_part_id
            JOIN goals ON goals.id = goal_parts.goal_id WHERE goals.subject_id = $1`, [sub.id]);
        assert.ok(cleared.every(x => x.color === null));
    });

    test("slots: timed events (with repeats) and timed tasks are busy", async () => {
        const me = await tester();
        const windows = [1, 2, 3, 4, 5, 6, 7].map(weekday => ({ weekday, start: "16:00", end: "18:00" }));
        assert.equal((await call("PUT", `${S}/settings`, { windows }, me.token)).status, 200);
        // every day 16:00-17:00 (+ 10 min buffer): only 17:10-18:00 is left
        await sql(
            "INSERT INTO tasks (name, kind, user_id, due, due_time, duration_minutes, repeat) VALUES ('Training', 'event', $1, $2, '16:00', 60, 'daily')",
            [me.id, daysFromToday(0)]
        );
        // without a length it counts as 60 minutes: 16:50-18:10 is gone that day
        assert.equal((await call("POST", "/api/tasks", { name: "Arzt", due: daysFromToday(2), due_time: "17:00" }, me.token)).status, 201);
        const sub = await subject(me);
        await goal(me, sub.id, { planMode: "slots" });
        const p = await preview(me);
        const news = p.goals[0].changes;
        assert.equal(news.length, 6, JSON.stringify(p));
        for (const c of news) {
            assert.ok(c.to.time >= "17:10" && c.to.time <= "17:15", JSON.stringify(c));
            assert.notEqual(c.to.date, daysFromToday(2));
        }
        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.ok((await sessionsOf(me)).every(s => s.due_time >= "17:10"));
    });

    test("Jetzt lernen: a pinned session for now", async () => {
        const me = await tester();
        const them = await tester();
        assert.equal((await call("PUT", `${S}/settings`, { sessionMinutes: 30 }, me.token)).status, 200);
        const sub = await subject(me, "Bio", { color: "pink", emoji: "🧬" });
        const slots = await goal(me, sub.id, { planMode: "slots" });
        const r = await call("POST", `${S}/parts/${slots.parts[1].id}/now`, null, me.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const { task } = r.data;
        assert.equal(task.plan_pinned, true);
        assert.equal(task.goal_part_id, slots.parts[1].id);
        assert.equal(task.name, "B");
        assert.equal(task.color, "pink");
        assert.equal(task.duration_minutes, 30);
        assert.equal(task.kind, "task");
        assert.equal(task.study.goalId, slots.id);
        const [row] = await sql("SELECT to_char(due, 'YYYY-MM-DD') AS due, to_char(due_time, 'HH24:MI') AS due_time FROM tasks WHERE id = $1", [task.id]);
        const [{ now }] = await sql("SELECT to_char(now() AT TIME ZONE 'Europe/Berlin', 'HH24:MI') AS now");
        const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
        assert.equal(row.due, daysFromToday(0));
        assert.equal(minutes(row.due_time) % 5, 0);
        assert.ok(minutes(now) - minutes(row.due_time) >= 0 && minutes(now) - minutes(row.due_time) < 10, `${row.due_time} vs ${now}`);

        const days = await goal(me, sub.id, { name: "Tage" });
        const d = await call("POST", `${S}/parts/${days.parts[0].id}/now`, null, me.token);
        assert.equal(d.status, 201);
        assert.equal(d.data.task.due_time, null);

        // on the day itself it still works (an exam in the afternoon); once the day is over it doesn't
        await sql("UPDATE goals SET due = $2 WHERE id = $1", [days.id, daysFromToday(0)]);
        assert.equal((await call("POST", `${S}/parts/${days.parts[0].id}/now`, null, me.token)).status, 201);
        await sql("UPDATE goals SET due = $2 WHERE id = $1", [days.id, daysFromToday(-1)]);
        const late = await call("POST", `${S}/parts/${days.parts[0].id}/now`, null, me.token);
        assert.equal(late.status, 400);
        assert.equal(late.data.code, "due_in_past");

        await call("PATCH", `${S}/goals/${days.id}`, { status: "done" }, me.token);
        assert.equal((await call("POST", `${S}/parts/${days.parts[0].id}/now`, null, me.token)).data.code, "goal_not_active");
        assert.equal((await call("POST", `${S}/parts/${slots.parts[0].id}/now`, null, them.token)).status, 404);
        assert.equal((await call("POST", `${S}/parts/abc/now`, null, me.token)).status, 404);

        // an archived subject hides its goals: no "Jetzt lernen" there
        const hidden = await subject(me, "Archiv");
        const archivedGoal = await goal(me, hidden.id);
        assert.equal((await call("PATCH", `${S}/subjects/${hidden.id}`, { archived: true }, me.token)).status, 200);
        const archived = await call("POST", `${S}/parts/${archivedGoal.parts[0].id}/now`, null, me.token);
        assert.equal(archived.status, 400);
        assert.equal(archived.data.code, "goal_not_active");
        assert.equal((await sql("SELECT count(*)::int AS n FROM tasks WHERE goal_part_id = $1", [archivedGoal.parts[0].id]))[0].n, 0);
    });

    test("deleting a goal while a plan is applied: both finish, no deadlock", async () => {
        const me = await tester();
        const sub = await subject(me);
        for (let round = 0; round < 5; round++) {
            await goal(me, sub.id, { name: `Bleibt ${round}` });
            const doomed = await goal(me, sub.id, { name: `Weg ${round}`, due: daysFromToday(6) });
            await apply(me);
            await goal(me, sub.id, { name: `Neu ${round}`, due: daysFromToday(4) });
            const p = await preview(me);
            const [replan, removal] = await Promise.all([
                call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token),
                call("DELETE", `${S}/goals/${doomed.id}?sessions=delete`, null, me.token),
            ]);
            assert.ok([200, 409].includes(replan.status), JSON.stringify(replan));
            assert.equal(removal.status, 200, JSON.stringify(removal.data));
            assert.equal((await sql("SELECT count(*)::int AS n FROM goals WHERE id = $1", [doomed.id]))[0].n, 0);
        }
    });

    test("finishing or deleting a part, or deleting a subject, while a plan is applied: no deadlock", async () => {
        const me = await tester();
        const actions = [
            (g) => call("PATCH", `${S}/parts/${g.parts[1].id}`, { doneAt: true }, me.token),
            (g) => call("DELETE", `${S}/parts/${g.parts[2].id}`, null, me.token),
            (g) => call("DELETE", `${S}/subjects/${g.subjectId}`, null, me.token),
        ];
        for (let round = 0; round < 9; round++) {
            const target = await goal(me, (await subject(me, `Fach ${round}`)).id, { name: `Ziel ${round}`, due: daysFromToday(6) });
            await apply(me);
            await goal(me, (await subject(me, `Neu ${round}`)).id, { name: `Neu ${round}`, due: daysFromToday(4) });
            const p = await preview(me);
            const [replan, other] = await Promise.all([
                call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token),
                actions[round % 3](target),
            ]);
            assert.ok([200, 409].includes(replan.status), JSON.stringify(replan));
            assert.equal(other.status, 200, JSON.stringify(other.data));
        }
    });

    test("unpin: only my own planned sessions", async () => {
        const me = await tester();
        const them = await tester();
        const g = await goal(me, (await subject(me)).id);
        const pinned = await session(me, g.parts[0].id, daysFromToday(2), { pinned: true });
        const plain = (await call("POST", "/api/tasks", { name: "Wäsche", due: daysFromToday(1) }, me.token)).data;
        assert.equal((await call("POST", `${S}/sessions/${plain.id}/unpin`, null, me.token)).status, 404);
        assert.equal((await call("POST", `${S}/sessions/${pinned}/unpin`, null, them.token)).status, 404);
        assert.equal((await call("POST", `${S}/sessions/x/unpin`, null, me.token)).status, 404);
        const r = await call("POST", `${S}/sessions/${pinned}/unpin`, null, me.token);
        assert.equal(r.status, 200);
        assert.deepEqual(r.data, { ok: true });
        assert.equal((await sql("SELECT plan_pinned FROM tasks WHERE id = $1", [pinned]))[0].plan_pinned, false);
    });

    test("own colours and goal shapes: every subject a colour, every goal a shape", async () => {
        const me = await tester();
        // without a colour a new subject takes the first of the eight not in use
        const red = (await call("POST", `${S}/subjects`, { name: "Erstes" }, me.token)).data;
        const orange = (await call("POST", `${S}/subjects`, { name: "Zweites" }, me.token)).data;
        assert.equal(red.color, "red");
        assert.equal(orange.color, "orange");
        // an own colour from the wheel is kept (lower case); anything else is refused
        const own = await call("PATCH", `${S}/subjects/${red.id}`, { color: "#2A9D8F" }, me.token);
        assert.equal(own.status, 200, JSON.stringify(own.data));
        assert.equal(own.data.color, "#2a9d8f");
        assert.equal((await call("PATCH", `${S}/subjects/${red.id}`, { color: "#12345" }, me.token)).status, 400);
        assert.equal((await call("PATCH", `${S}/subjects/${red.id}`, { color: "purple" }, me.token)).status, 400);
        // goals: a free shape each unless one is picked; a wrong one is refused
        const first = await goal(me, red.id);
        const second = await goal(me, red.id, { name: "Zweites Ziel" });
        const third = await goal(me, red.id, { name: "Drittes Ziel", shape: "star" });
        assert.deepEqual([first.shape, second.shape, third.shape], ["circle", "square", "star"]);
        const bad = await call("POST", `${S}/goals`, {
            subjectId: red.id, kind: "other", name: "X", due: daysFromToday(5), planMode: "days", shape: "moon",
            parts: [{ name: "A", estimateMinutes: 30 }],
        }, me.token);
        assert.equal(bad.status, 400);
        const changed = await call("PATCH", `${S}/goals/${first.id}`, { shape: "heart" }, me.token);
        assert.equal(changed.status, 200, JSON.stringify(changed.data));
        assert.equal((await call("GET", `${S}/goals/${first.id}`, null, me.token)).data.shape, "heart");
        // a task takes an own colour too, and only a well-formed one
        const task = await call("POST", "/api/tasks", { name: "Farbig", color: "#FFAA00" }, me.token);
        assert.equal(task.status, 201, JSON.stringify(task.data));
        assert.equal(task.data.color, "#ffaa00");
        assert.equal((await call("POST", "/api/tasks", { name: "Falsch", color: "#ffaa0" }, me.token)).status, 400);
    });

    test("task rows of sessions know their goal", async () => {
        const me = await tester();
        const sub = await subject(me, "Statistik", { emoji: "📊" });
        const g = await goal(me, sub.id);
        await apply(me);
        await call("POST", "/api/tasks", { name: "Einkaufen", due: daysFromToday(1) }, me.token);
        const tasks = (await call("GET", "/api/tasks", null, me.token)).data;
        const planned = tasks.filter(t => t.goal_part_id != null);
        assert.equal(planned.length, 6);
        for (const t of planned) {
            assert.equal(t.plan_pinned, false);
            assert.deepEqual(t.study, {
                goalId: g.id, goalName: "Hausarbeit", partName: t.name,
                subjectName: "Statistik", subjectEmoji: "📊", subjectColor: "green", goalShape: "circle",
            });
        }
        const plain = tasks.find(t => t.name === "Einkaufen");
        assert.equal(plain.study, null);
        assert.equal(plain.goal_part_id, null);
        assert.equal(plain.plan_pinned, false);
    });

    test("a goal of an archived subject is not planned and its sessions stay as they are", async () => {
        const me = await tester();
        const hidden = await subject(me, "Latein");
        const kept = await goal(me, hidden.id, { name: "Vokabeln" });
        await apply(me);
        const shown = await subject(me, "Mathe");
        const planned = await goal(me, shown.id);
        await sql("UPDATE goals SET freed_minutes = 30 WHERE id = $1", [kept.id]);
        assert.equal((await call("PATCH", `${S}/subjects/${hidden.id}`, { archived: true }, me.token)).status, 200);
        const parts = kept.parts.map(x => x.id);
        const hiddenRows = () => sql("SELECT * FROM tasks WHERE goal_part_id = ANY($1) ORDER BY id", [parts]);
        const before = await hiddenRows();
        assert.equal(before.length, 6, "replaceable sessions of the archived subject's goal");

        const p = await preview(me);
        assert.deepEqual(p.goals.map(x => x.goalId), [planned.id], "only the goal of the subject that is shown");
        assert.deepEqual(Object.keys(p.shortfall), [String(planned.id)]);
        assert.deepEqual(p.goals[0].summary, { moved: 0, added: 6, dropped: 0, unchanged: 0 });
        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, me.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.deepEqual(await hiddenRows(), before, "not touched");
        assert.equal((await sql("SELECT freed_minutes FROM goals WHERE id = $1", [kept.id]))[0].freed_minutes, 30);
        assert.equal((await sessionsOf(me)).length, 12);
    });
});

describe("study status and estimates", () => {
    const S = "/api/tester/study";
    let count = 0;
    const tester = async () => {
        const user = await member(`statuser${++count}`);
        await sql("UPDATE users SET is_tester = true WHERE id = $1", [user.id]);
        return user;
    };
    const subject = async (user, name = "Mathe") => (await call("POST", `${S}/subjects`, { name, color: "blue" }, user.token)).data;
    const goal = async (user, subjectId, extra = {}) => {
        const r = await call("POST", `${S}/goals`, {
            subjectId, kind: "assignment", name: "Hausarbeit", due: daysFromToday(10), planMode: "days",
            parts: [{ name: "A", estimateMinutes: 45 }, { name: "B", estimateMinutes: 90 }, { name: "C", estimateMinutes: 135 }],
            ...extra,
        }, user.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return (await call("GET", `${S}/goals/${r.data.id}`, null, user.token)).data;
    };
    const apply = async (user) => {
        const p = (await call("GET", `${S}/plan`, null, user.token)).data;
        const r = await call("POST", `${S}/replan`, { inputHash: p.inputHash }, user.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
    };
    const session = async (user, partId, due, extra = {}) => (await sql(
        `INSERT INTO tasks (name, kind, user_id, due, duration_minutes, goal_part_id, done, plan_pinned)
        VALUES ('S', 'task', $1, $2, 45, $3, $4, false) RETURNING id`,
        [user.id, due, partId, !!extra.done]))[0].id;
    const status = async (user) => {
        const r = await call("GET", `${S}/status`, null, user.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.data;
    };
    // a finished part of an existing goal: `actual` minutes
    const finished = async (user, goalId, name, actual) => sql(
        `INSERT INTO goal_parts (goal_id, name, position, estimate_minutes, done_at, actual_minutes)
        VALUES ($1, $2, 50, 60, now(), $3)`,
        [goalId, name, actual]
    );
    const estimate = (user, body) => call("POST", `${S}/estimate`, { subjectName: "Mathe", kind: "exam", due: daysFromToday(20), parts: ["Analysis"], ...body }, user.token);

    test("a part that reached its estimate loses its future sessions on GET /status, replan resets the freed time", async () => {
        const me = await tester();
        const g = await goal(me, (await subject(me)).id);
        await apply(me);
        const a = g.parts[0].id;
        const before = await sql("SELECT id FROM tasks WHERE goal_part_id = $1", [a]);
        assert.equal(before.length, 1);
        await session(me, a, daysFromToday(0), { done: true });
        const s = await status(me);
        assert.equal(s.aiAvailable, false);
        assert.deepEqual(s.goals, [{ goalId: g.id, name: "Hausarbeit", behindMinutes: 0, conflictTaskIds: [], freedMinutes: 45 }]);
        assert.deepEqual(s.notifiedMinutes, { [g.id]: 0 });
        assert.equal((await sql("SELECT id FROM tasks WHERE goal_part_id = $1 AND NOT done", [a])).length, 0);
        assert.equal((await status(me)).goals[0].freedMinutes, 45, "not counted twice");
        await sql("UPDATE goals SET behind_notified_minutes = 90 WHERE id = $1", [g.id]);
        await apply(me);
        assert.equal((await status(me)).goals[0].freedMinutes, 0);
        assert.deepEqual((await status(me)).notifiedMinutes, { [g.id]: 0 }, "a fresh plan starts clean");
    });

    test("GET /status frees only sessions that are still plain: pinned and noted ones stay", async () => {
        const me = await tester();
        const g = await goal(me, (await subject(me)).id);
        await apply(me);
        const a = g.parts[0].id;
        const [plainId] = (await sql("SELECT id FROM tasks WHERE goal_part_id = $1", [a])).map(r => r.id);
        const pinnedId = await session(me, a, daysFromToday(2));
        await sql("UPDATE tasks SET plan_pinned = true WHERE id = $1", [pinnedId]);
        const notedId = await session(me, a, daysFromToday(3));
        await sql("INSERT INTO notebook_notes (user_id, task_id, body) VALUES ($1, $2, 'wichtig')", [me.id, notedId]);
        await session(me, a, daysFromToday(0), { done: true });
        const s = await status(me);
        assert.equal(s.goals[0].freedMinutes, 45, "only the plain session counts");
        const left = (await sql("SELECT id FROM tasks WHERE goal_part_id = $1 AND NOT done ORDER BY id", [a])).map(r => r.id);
        assert.deepEqual(left, [pinnedId, notedId]);
        assert.ok(!left.includes(plainId));
        assert.equal((await sql("SELECT count(*)::int AS n FROM notebook_notes WHERE task_id = $1", [notedId]))[0].n, 1);
    });

    test("GET /status does not delete a session that was ticked off after it was read", async () => {
        const me = await tester();
        const g = await goal(me, (await subject(me)).id);
        await apply(me);
        const a = g.parts[0].id;
        const [plainId] = (await sql("SELECT id FROM tasks WHERE goal_part_id = $1", [a])).map(r => r.id);
        await session(me, a, daysFromToday(0), { done: true });
        const phone = new pg.Client(conn(DB));
        await phone.connect();
        try {
            await phone.query("BEGIN");
            await phone.query("UPDATE tasks SET done = true WHERE id = $1", [plainId]); // not committed: the read still sees it open
            const pending = status(me);
            await sleep(600); // the request has read the old state and waits on the row lock
            await phone.query("COMMIT");
            const s = await pending;
            assert.equal(s.goals[0].freedMinutes, 0);
        } finally {
            await phone.end();
        }
        const row = (await sql("SELECT done FROM tasks WHERE id = $1", [plainId]))[0];
        assert.ok(row && row.done, "the ticked-off session is still there");
    });

    test("behind after a missed session, 'So lassen' hides it until it grows", async () => {
        const me = await tester();
        const them = await tester();
        const g = await goal(me, (await subject(me)).id);
        const yesterday = daysFromToday(-1);
        await session(me, g.parts[1].id, yesterday);
        assert.equal((await status(me)).goals[0].behindMinutes, 45);
        assert.equal((await call("POST", `${S}/goals/${g.id}/dismiss`, null, them.token)).status, 404);
        const d = await call("POST", `${S}/goals/${g.id}/dismiss`, null, me.token);
        assert.deepEqual([d.status, d.data], [200, { ok: true, notifiedMinutes: 45 }]);
        const s = await status(me);
        assert.deepEqual(s.notifiedMinutes, { [g.id]: 45 });
        assert.equal(s.goals[0].behindMinutes, 45, "the deficit is still reported; the app compares it with notifiedMinutes");
        await session(me, g.parts[2].id, yesterday);
        const grown = await status(me);
        assert.equal(grown.goals[0].behindMinutes, 90);
        assert.equal(grown.notifiedMinutes[g.id], 45);
    });

    test("estimate: history, pages, default", async () => {
        const me = await tester();
        const sub = await subject(me);
        const g = await goal(me, sub.id, { kind: "exam" });
        for (const m of [90, 100, 200]) await finished(me, g.id, "Thema", m);
        let r = await estimate(me, { subjectId: sub.id });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.deepEqual(r.data, { estimates: [{ minutes: 100, source: "history" }], aiUsed: false, aiFailed: false });
        assert.equal((await estimate(me, { subjectId: 2147483000 })).status, 404);

        const pager = await tester();
        const pg = await goal(pager, (await subject(pager)).id, { kind: "presentation" });
        for (const n of [1, 2, 3]) await finished(pager, pg.id, `Kapitel ${n}, S. 10–30`, 40);
        r = await estimate(pager, { parts: ["Kapitel 4, S. 120–160", "Rest"] });
        assert.deepEqual(r.data.estimates, [{ minutes: 80, source: "pages" }, { minutes: 120, source: "default" }]);

        const fresh = await tester();
        r = await estimate(fresh, { parts: ["x"], kind: "presentation", ai: true });
        assert.deepEqual(r.data, { estimates: [{ minutes: 90, source: "default" }], aiUsed: false, aiFailed: false }, "no key: no AI, not a failure");

        await sql("UPDATE users SET study_ai_auto = true WHERE id = $1", [fresh.id]);
        r = await estimate(fresh, { parts: ["x"], kind: "presentation", ai: false });
        assert.deepEqual(r.data, { estimates: [{ minutes: 90, source: "default" }], aiUsed: false, aiFailed: false }, "ai:false with aiAuto: no AI");
        assert.equal((await estimate(fresh, { ai: "no" })).data.code, "invalid_input", "ai is a boolean");
    });

    test("estimate: input checks", async () => {
        const me = await tester();
        const ok = (await estimate(me, { parts: Array.from({ length: 40 }, (_, i) => `P${i}`) }));
        assert.equal(ok.status, 200);
        assert.equal(ok.data.estimates.length, 40);
        for (const body of [
            { parts: Array.from({ length: 41 }, (_, i) => `P${i}`) }, { parts: [] }, { parts: ["  "] }, { parts: [3] },
            { parts: ["x".repeat(201)] }, { kind: "party" }, { subjectName: "" },
        ]) {
            const r = await estimate(me, body);
            assert.deepEqual([r.status, r.data.code], [400, "invalid_input"], JSON.stringify(body));
        }
    });
});

describe("study push (kind study)", () => {
    const S = "/api/tester/study";
    let count = 0;
    let pool;
    let pushStudyBehind;
    let zone; // a time zone where it is night right now, so the server's own schedule never sends to these users
    const lines = [];
    const realLog = console.log;
    const pushes = (user) => lines.filter(l => l.startsWith(`[DEV] Push to user ${user.id} (study): `));

    before(async () => {
        // the module sends for real when VAPID keys are set (.env): not here, it only logs
        process.env.VAPID_PUBLIC_KEY = "";
        process.env.VAPID_PRIVATE_KEY = "";
        process.env.FIREBASE_SERVICE_ACCOUNT_FILE = "";
        ({ pushStudyBehind } = createRequire(import.meta.url)("../../utils/push.js"));
        pool = new pg.Pool(conn(DB));
        const hour = new Date().getUTCHours();
        const offset = (((3 - hour) % 24) + 36) % 24 - 12; // -12 … 11: the zone's local hour is 3 now
        zone = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
        console.log = (...args) => { lines.push(args.join(" ")); };
        // goals of the earlier tests would be notified too
        await sql("UPDATE goals SET status = 'archived'");
    });
    after(async () => {
        console.log = realLog;
        await pool?.end();
    });

    const tester = async () => {
        const user = await member(`studypush${++count}`);
        await sql("UPDATE users SET is_tester = true, timezone = $2 WHERE id = $1", [user.id, zone]);
        return user;
    };
    const today = async () => (await sql("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d", [zone]))[0].d;
    const plusDays = async (day, n) => (await sql("SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d", [day, n]))[0].d;
    // that day at hh:mm in the user's zone, as an instant
    const at = async (day, time) => (await sql("SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t", [day, time, zone]))[0].t;
    const makeGoal = async (user) => {
        const subject = (await call("POST", `${S}/subjects`, { name: "Mathe", color: "blue" }, user.token)).data;
        const r = await call("POST", `${S}/goals`, {
            subjectId: subject.id, kind: "assignment", name: "Hausarbeit", due: await plusDays(await today(), 10), planMode: "days",
            parts: [{ name: "A", estimateMinutes: 45 }, { name: "B", estimateMinutes: 90 }],
        }, user.token);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return (await call("GET", `${S}/goals/${r.data.id}`, null, user.token)).data;
    };
    const missed = async (user, partId, due) => sql(
        `INSERT INTO tasks (name, kind, user_id, due, duration_minutes, goal_part_id, done, plan_pinned)
        VALUES ('S', 'task', $1, $2, 45, $3, false, false)`, [user.id, due, partId]);
    const device = async (user, n, kinds) => {
        const r = await call("PUT", "/api/push/subscription", { endpoint: `https://push.example.com/send/study-${user.id}-${n}`, keys: { p256dh: `BKeyS${user.id}${n}`, auth: `authS${user.id}${n}` }, kinds }, user.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.data;
    };

    test("PUT /api/push/subscription accepts kinds.study", async () => {
        const me = await tester();
        const on = await device(me, 1, { study: false });
        assert.equal(on.kinds.study, false);
        assert.equal((await device(me, 1, { study: true })).kinds.study, true);
        assert.equal((await sql("SELECT study FROM push_subscriptions WHERE user_id = $1", [me.id]))[0].study, true);
    });

    test("one push a day at 09:00 for a missed session, none at 07:30, a new one when the deficit grew by a session", async () => {
        const me = await tester();
        const g = await makeGoal(me);
        await device(me, 1);
        const day = await today();
        await missed(me, g.parts[0].id, await plusDays(day, -1));

        assert.equal(await pushStudyBehind(pool, await at(day, "07:30")), 0, "too early");
        assert.equal(pushes(me).length, 0);

        assert.equal(await pushStudyBehind(pool, await at(day, "09:00")), 1);
        assert.equal(pushes(me).length, 1);
        assert.match(pushes(me)[0], /Hausarbeit liegt 0,8 h zurück/);
        const row = (await sql("SELECT behind_notified_minutes, to_char(behind_notified_on, 'YYYY-MM-DD') AS on FROM goals WHERE id = $1", [g.id]))[0];
        assert.deepEqual(row, { behind_notified_minutes: 45, on: day });

        assert.equal(await pushStudyBehind(pool, await at(day, "10:00")), 0, "once a day");
        assert.equal(await pushStudyBehind(pool, await at(await plusDays(day, 1), "09:00")), 0, "same deficit as notified");
        assert.equal(pushes(me).length, 1);

        await missed(me, g.parts[1].id, day); // over by tomorrow: one more session behind
        assert.equal(await pushStudyBehind(pool, await at(await plusDays(day, 1), "19:00")), 0, "not after 19:00");
        assert.equal(await pushStudyBehind(pool, await at(await plusDays(day, 1), "09:00")), 1);
        assert.equal(pushes(me).length, 2);
        assert.equal((await sql("SELECT behind_notified_minutes FROM goals WHERE id = $1", [g.id]))[0].behind_notified_minutes, 90);
    });

    test("a goal that is not behind is reset to 0", async () => {
        const me = await tester();
        const g = await makeGoal(me);
        await device(me, 1);
        await sql("UPDATE goals SET behind_notified_minutes = 45 WHERE id = $1", [g.id]);
        assert.equal(await pushStudyBehind(pool, await at(await today(), "09:00")), 0);
        assert.equal((await sql("SELECT behind_notified_minutes FROM goals WHERE id = $1", [g.id]))[0].behind_notified_minutes, 0);
        assert.equal(pushes(me).length, 0);
    });

    test("nothing for a device with study off, nor for an account without app access", async () => {
        const off = await tester();
        const goalOff = await makeGoal(off);
        await device(off, 1, { study: false });
        await missed(off, goalOff.parts[0].id, await plusDays(await today(), -1));

        const plain = await tester();
        const goalPlain = await makeGoal(plain);
        await device(plain, 1);
        await missed(plain, goalPlain.parts[0].id, await plusDays(await today(), -1));
        await sql("UPDATE users SET is_tester = false, is_pro = false, is_admin = false WHERE id = $1", [plain.id]);

        await pushStudyBehind(pool, await at(await today(), "09:00"));
        assert.equal(pushes(off).length, 0);
        assert.equal(pushes(plain).length, 0);
        assert.equal((await sql("SELECT behind_notified_minutes FROM goals WHERE id = $1", [goalOff.id]))[0].behind_notified_minutes, 0, "not marked: nothing was delivered");
    });
});

describe("usage statistics", () => {
    // counts after the answer are written a moment later: read until `ok` holds (or time is up)
    async function until(read, ok = (rows) => rows.length > 0, ms = 3000) {
        let rows;
        for (let i = 0; i < ms / 50; i++) {
            rows = await read();
            if (ok(rows)) return rows;
            await sleep(50);
        }
        return rows;
    }
    const hourly = (metric) => sql("SELECT platform, plan, events, people, value_sum::int AS value_sum FROM usage_hourly WHERE metric = $1", [metric]);
    const marks = (who) => sql("SELECT * FROM usage_seen WHERE user_id = $1", [who.id]);
    const reset = () => sql("TRUNCATE usage_hourly, usage_people");
    const consent = (who, granted = true) => call("PUT", "/api/profile/usage-consent", { granted }, who.token);
    const beacon = (who, events, headers) => call("POST", "/api/usage", { platform: "web", events }, who.token, headers);
    let n = 0;
    const person = (options) => member(`ustat${++n}`, options);

    test("consent: unanswered at first, then stored with its time and version", async () => {
        const u = await person();
        assert.deepEqual((await call("GET", "/api/me", null, u.token)).data.usageConsent, { choice: null, at: null, version: null });
        const r = await consent(u);
        assert.equal(r.status, 200);
        assert.equal(r.data.choice, "granted");
        assert.equal(r.data.version, 1);
        assert.ok(Date.now() - new Date(r.data.at).getTime() < 60e3);
        const me = (await call("GET", "/api/me", null, u.token)).data.usageConsent;
        assert.deepEqual([me.choice, me.version], ["granted", 1]);
        for (const body of [{ granted: "yes" }, {}, { granted: null }]) {
            const bad = await call("PUT", "/api/profile/usage-consent", body, u.token);
            assert.equal(bad.status, 400);
            assert.equal(bad.data.code, "INVALID_INPUT");
        }
        assert.equal((await call("PUT", "/api/profile/usage-consent", { granted: true })).status, 401);
    });

    test("accounts waiting for beta access may consent and send the beacon too", async () => {
        const u = await person({ pro: false });
        assert.equal((await call("GET", "/api/tasks", null, u.token)).status, 403, "no app access");
        assert.equal((await consent(u)).status, 200);
        await reset();
        assert.equal((await beacon(u, [{ metric: "app_open" }])).status, 204);
        const rows = await hourly("app_open");
        assert.deepEqual(rows.map((r) => [r.events, r.plan]), [[1, "free"]]);
    });

    test("beacon without consent: 204, nothing stored", async () => {
        const u = await person();
        await reset();
        assert.equal((await beacon(u, [{ metric: "app_open" }, { metric: "view:calendar" }])).status, 204);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
        assert.equal((await marks(u)).length, 0);
    });

    test("beacon keeps known client metrics only", async () => {
        const u = await person();
        await consent(u);
        await reset();
        const r = await beacon(u, [{ metric: "view:calendar" }, { metric: "task_done" }, { metric: "nope" }]);
        assert.equal(r.status, 204);
        const metrics = (await sql("SELECT DISTINCT metric FROM usage_hourly ORDER BY metric")).map((row) => row.metric);
        assert.deepEqual(metrics, ["active", "view:calendar"]);
    });

    test("active_minute: once per minute, worth one", async () => {
        const u = await person();
        await consent(u);
        await reset();
        const at = new Date().toISOString();
        await beacon(u, [{ metric: "active_minute", at, value: 99 }, { metric: "active_minute", at }]);
        await beacon(u, [{ metric: "active_minute", at }]);
        const rows = await hourly("active_minute");
        assert.deepEqual(rows.map((row) => [row.events, row.value_sum]), [[1, 1]]);
        // other metrics carry no value
        await beacon(u, [{ metric: "app_open", value: 50 }]);
        assert.equal((await hourly("app_open"))[0].value_sum, 0);
    });

    test("events too old or in the future are dropped; too many is a bad request", async () => {
        const u = await person();
        await consent(u);
        await reset();
        const twoDaysAgo = new Date(Date.now() - 2 * 86400e3).toISOString();
        const later = new Date(Date.now() + 5 * 60e3).toISOString();
        assert.equal((await beacon(u, [{ metric: "app_open", at: twoDaysAgo }, { metric: "app_open", at: later }, { metric: "app_open", at: "soon" }])).status, 204);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
        const many = Array.from({ length: 201 }, () => ({ metric: "app_open" }));
        const r = await beacon(u, many);
        assert.equal(r.status, 400);
        assert.equal(r.data.code, "INVALID_INPUT");
        assert.equal((await call("POST", "/api/usage", { events: "app_open" }, u.token)).status, 400);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
    });

    test("tasks: created and done are counted by the server", async () => {
        const u = await person();
        await consent(u);
        await reset();
        const task = (await call("POST", "/api/tasks", { name: "Lesen" }, u.token)).data;
        assert.deepEqual((await until(() => hourly("task_created"))).map((r) => r.events), [1]);
        assert.equal((await call("PUT", `/api/tasks/${task.id}`, { name: "Lesen", done: true }, u.token)).status, 200);
        assert.deepEqual((await until(() => hourly("task_done"))).map((r) => r.events), [1]);
        // changing something else doesn't count again; undone and done again does
        await call("PUT", `/api/tasks/${task.id}`, { name: "Lesen!", done: true }, u.token);
        await call("PUT", `/api/tasks/${task.id}`, { name: "Lesen", done: false }, u.token);
        await call("PUT", `/api/tasks/${task.id}`, { name: "Lesen", done: true }, u.token);
        const rows = await until(() => hourly("task_done"), (r) => r[0]?.events === 2);
        assert.deepEqual(rows.map((r) => [r.events, r.people]), [[2, 1]]);
        await sleep(200);
        assert.equal((await hourly("task_done"))[0].events, 2);
    });

    test("calendar events are not created tasks (they are never ticked off by hand)", async () => {
        const u = await person();
        await consent(u);
        await reset();
        const day = daysFromToday(1);
        assert.equal((await call("POST", "/api/tasks", { name: "Arzt", kind: "event", due: day }, u.token)).status, 201);
        const sessionId = (await call("POST", "/api/shared-sessions", { name: "Termine" }, u.token)).data.id;
        assert.equal((await call("POST", `/api/shared-sessions/${sessionId}/tasks`, { name: "Treffen", kind: "event", due: day }, u.token)).status, 201);
        const familyId = (await call("POST", "/api/families", { name: "Kalender" }, u.token)).data.id;
        assert.equal((await call("POST", `/api/families/${familyId}/tasks`, { name: "Elternabend", kind: "event", due: day }, u.token)).status, 201);
        // a task afterwards is counted: once it is there, the events before it would be too
        await call("POST", "/api/tasks", { name: "Packen" }, u.token);
        const rows = await until(() => hourly("task_created"));
        await sleep(200);
        assert.deepEqual((await hourly("task_created")).map((r) => r.events), [1]);
        assert.deepEqual(rows.map((r) => r.events), [1]);
    });

    test("shared session and family entries are counted too", async () => {
        const u = await person();
        await consent(u);
        await reset();
        const sessionId = (await call("POST", "/api/shared-sessions", { name: "Allein" }, u.token)).data.id;
        const session = (await call("POST", `/api/shared-sessions/${sessionId}/tasks`, { name: "Folien" }, u.token)).data;
        await call("PATCH", `/api/shared-sessions/${sessionId}/tasks/${session.tasks[0].id}`, { done: true }, u.token);
        const familyId = (await call("POST", "/api/families", { name: "Daheim" }, u.token)).data.id;
        const family = (await call("POST", `/api/families/${familyId}/tasks`, { name: "Milch" }, u.token)).data;
        await call("PATCH", `/api/families/${familyId}/tasks/${family.tasks[0].id}`, { done: true }, u.token);
        await call("PATCH", `/api/families/${familyId}/tasks/${family.tasks[0].id}`, { done: true }, u.token);
        assert.deepEqual((await until(() => hourly("task_created"), (r) => r[0]?.events === 2)).map((r) => r.events), [2]);
        assert.deepEqual((await until(() => hourly("task_done"), (r) => r[0]?.events === 2)).map((r) => r.events), [2]);
        await sleep(200);
        assert.equal((await hourly("task_done"))[0].events, 2, "done twice in a row counts once");
    });

    test("focus_done: the seconds, and the platform from the header", async () => {
        const u = await person();
        await consent(u);
        await reset();
        assert.equal((await call("POST", "/api/sessions", { totalTime: 1500, workedTasks: [] }, u.token, { "X-Quidey-Platform": "android" })).status, 201);
        const rows = await until(() => hourly("focus_done"));
        assert.deepEqual(rows.map((r) => [r.platform, r.value_sum]), [["android", 1500]]);
        await call("POST", "/api/sessions", { totalTime: 60, workedTasks: [] }, u.token, { "X-Quidey-Platform": "evil" });
        const web = await until(() => sql("SELECT value_sum::int AS value_sum FROM usage_hourly WHERE metric = 'focus_done' AND platform = 'web'"));
        assert.deepEqual(web.map((r) => r.value_sum), [60]);
    });

    test("withdrawing the consent drops the marks at once and stops counting", async () => {
        const u = await person();
        await consent(u);
        await beacon(u, [{ metric: "app_open" }]);
        assert.ok((await marks(u)).length > 0);
        const r = await consent(u, false);
        assert.equal(r.status, 200);
        assert.deepEqual([r.data.choice, r.data.version], ["denied", 1]);
        assert.equal((await marks(u)).length, 0);
        await reset();
        assert.equal((await beacon(u, [{ metric: "view:home" }])).status, 204);
        await call("POST", "/api/tasks", { name: "Nach dem Nein" }, u.token);
        await sleep(300);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
        assert.equal((await marks(u)).length, 0);
    });

    test("a failing count doesn't break the request", async () => {
        const u = await person();
        await consent(u);
        const task = (await call("POST", "/api/tasks", { name: "Trotzdem" }, u.token)).data;
        await until(() => hourly("task_created"));
        await sql("ALTER TABLE usage_hourly RENAME TO usage_hourly_x");
        try {
            const r = await call("PUT", `/api/tasks/${task.id}`, { name: "Trotzdem", done: true }, u.token);
            assert.equal(r.status, 200);
            assert.equal(r.data.done, true);
            for (let i = 0; i < 60 && !log.includes("Counting usage failed"); i++) await sleep(50);
            assert.ok(log.includes("Counting usage failed"));
        } finally {
            await sql("ALTER TABLE usage_hourly_x RENAME TO usage_hourly");
        }
    });

    test("deleting the account removes its marks, the totals stay", async () => {
        const u = await person();
        await consent(u);
        await reset();
        await beacon(u, [{ metric: "app_open" }]);
        assert.ok((await marks(u)).length > 0);
        assert.equal((await call("DELETE", "/api/users", { password: PW }, u.token)).status, 200);
        assert.equal((await marks(u)).length, 0);
        assert.deepEqual((await hourly("app_open")).map((r) => r.events), [1]);
    });
});

describe("admin usage", () => {
    let pool, countUsage, localParts;
    let boss, ann, ben;
    let day1, day2, hour1, weekday1;
    const stamp = (daysAgo, hour = 12) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - daysAgo); d.setUTCHours(hour, 30, 0, 0); return d; };
    const get = (path, who = boss) => call("GET", `/api/admin/usage${path}`, null, who.token);
    const dayRow = (data, date) => data.daily.find((d) => d.date === date);

    before(async () => {
        ({ countUsage, localParts } = createRequire(import.meta.url)("../../utils/usage.js"));
        pool = new pg.Pool(conn(DB));
        boss = await member("uadmin", { admin: true });
        ann = await member("uann");
        ben = await member("uben");
        for (const u of [ann, ben]) await call("PUT", "/api/profile/usage-consent", { granted: true }, u.token);
        const nope = await member("unope");
        await call("PUT", "/api/profile/usage-consent", { granted: false }, nope.token);
        await sql("TRUNCATE usage_hourly, usage_people");
        const t1 = stamp(3), t2 = stamp(2);
        ({ day: day1, localHour: hour1, weekday: weekday1 } = localParts(t1, "Europe/Berlin"));
        day2 = localParts(t2, "Europe/Berlin").day;
        // day 1: both people, ann on android, ben on web; day 2: ann only
        await countUsage(pool, ann.id, "task_done", { platform: "android", at: t1 });
        await countUsage(pool, ben.id, "task_done", { platform: "web", at: t1 });
        await countUsage(pool, ann.id, "task_created", { platform: "android", at: t1 });
        await countUsage(pool, ann.id, "focus_done", { value: 1800, platform: "android", at: t1 });
        await countUsage(pool, ben.id, "focus_done", { value: 1800, platform: "web", at: t1 });
        await countUsage(pool, ann.id, "active_minute", { value: 1, platform: "android", at: t1 });
        await countUsage(pool, ben.id, "active_minute", { value: 1, platform: "web", at: t1 });
        await countUsage(pool, ben.id, "active_minute", { value: 1, platform: "web", at: t1 });
        await countUsage(pool, ann.id, "task_done", { platform: "android", at: t2 });
        await countUsage(pool, ann.id, "view:calendar", { platform: "android", at: t2 });
    });
    after(async () => { await pool?.end(); await sql("TRUNCATE usage_hourly, usage_people"); });

    test("admins only", async () => {
        const r = await get("", ann);
        assert.equal(r.status, 403);
        assert.equal(r.data.code, "ADMIN_REQUIRED");
        assert.equal((await get("/raw", ann)).data.code, "ADMIN_REQUIRED");
    });

    test("report: summary, consent counts, daily, heatmap", async () => {
        const r = await get(`?from=${day1}&to=${day2}`);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.deepEqual(r.data.range, { from: day1, to: day2 });
        const users = (await sql("SELECT usage_consent AS c, count(*)::int AS n FROM users GROUP BY 1")).reduce((o, x) => ({ ...o, [x.c ?? "none"]: x.n }), {});
        assert.deepEqual(r.data.summary.consent, { granted: users.granted, denied: users.denied, notAsked: users.none });
        assert.equal(r.data.daily.length, 2);
        const d1 = dayRow(r.data, day1);
        assert.deepEqual([d1.active, d1.tasksDone, d1.tasksCreated, d1.focusMinutes], [2, 2, 1, 60]);
        assert.equal(d1.activeMinutesPerPerson, 1.5);
        const d2 = dayRow(r.data, day2);
        assert.deepEqual([d2.active, d2.tasksDone, d2.focusMinutes], [1, 1, 0]);
        assert.equal(r.data.summary.avgActivePerDay, 1.5);
        assert.deepEqual(r.data.summary.busiestDay, { date: day1, people: 2 });
        assert.equal(r.data.summary.focusHours, 1);
        const cell = r.data.heatmap.task_done.find((c) => c.hour === hour1 && c.weekday === weekday1);
        assert.equal(cell.people, 2);
        assert.equal(cell.events, 2);
        assert.deepEqual(Object.keys(r.data.heatmap).sort(), ["active", "focus_start", "task_done"]);
        assert.ok(r.data.weekly.length >= 1);
        assert.ok(r.data.weekly[0].weekStart <= day1);
    });

    test("report: features and splits", async () => {
        const r = await get(`?from=${day1}&to=${day2}`);
        const done = r.data.features.find((f) => f.metric === "task_done");
        assert.deepEqual([done.personDays, done.events, done.perPersonDay, done.spark.length], [3, 3, 1, 14]);
        assert.ok(!r.data.features.some((f) => f.metric === "active"));
        assert.ok(r.data.features.some((f) => f.metric === "view:calendar"));
        const personDays = r.data.features.map((f) => f.personDays);
        assert.deepEqual(personDays, [...personDays].sort((a, b) => b - a));
        const byKey = Object.fromEntries(r.data.splits.platform.map((p) => [p.key, p.personDays]));
        assert.deepEqual(byKey, { android: 2, web: 1 });
        assert.ok(r.data.splits.language.length >= 1 && r.data.splits.plan.length >= 1);
    });

    test("platform filter narrows the numbers", async () => {
        const r = await get(`?from=${day1}&to=${day2}&platform=android`);
        assert.equal(dayRow(r.data, day1).active, 1);
        assert.equal(dayRow(r.data, day1).tasksDone, 1);
        assert.equal(r.data.heatmap.task_done.reduce((a, c) => a + c.people, 0), 2);
        assert.equal(r.data.summary.focusHours, 0.5);
    });

    test("default range is the last 30 days, zeros are filled", async () => {
        const r = await get("");
        assert.equal(r.data.daily.length, 30);
        assert.equal(r.data.daily[29].date, localParts(new Date(), "Europe/Berlin").day);
        assert.equal(dayRow(r.data, day1).active, 2);
        assert.equal(r.data.daily.filter((d) => d.active === 0).length, 28);
    });

    test("bad ranges and filters are refused", async () => {
        for (const q of [`?from=${day2}&to=${day1}`, "?from=2000-01-01&to=2010-01-01", "?from=nope", "?from=2026-02-31&to=2026-03-01"]) {
            const r = await get(q);
            assert.equal(r.status, 400, q);
            assert.equal(r.data.code, "INVALID_RANGE", q);
        }
        for (const q of ["?platform=ios", "?language=fr", "?plan=gold"]) {
            const r = await get(q);
            assert.equal(r.status, 400, q);
            assert.equal(r.data.code, "INVALID_INPUT", q);
        }
    });

    test("raw rows, and a range over the cap is refused", async () => {
        const r = await call("GET", `/api/admin/usage/raw?from=${day1}&to=${day2}&platform=web`, null, boss.token);
        assert.equal(r.status, 200);
        const focus = r.data.rows.find((x) => x.metric === "focus_done");
        assert.deepEqual([focus.platform, focus.valueSum, focus.events, focus.people, focus.localHour], ["web", 1800, 1, 1, hour1]);
        // the day, not the exact UTC hour
        assert.deepEqual(Object.keys(focus).sort(), ["date", "events", "language", "localHour", "metric", "people", "plan", "platform", "valueSum", "weekday"]);
        assert.equal(focus.date, day1);
        // more than USAGE_RAW_MAX (50) rows: 4 metrics (with active) over 15 hours
        for (let h = 0; h < 15; h++) {
            const at = stamp(1, h);
            for (const m of ["task_done", "task_created", "app_open"]) await countUsage(pool, ann.id, m, { at });
        }
        const big = await call("GET", "/api/admin/usage/raw", null, boss.token);
        assert.equal(big.status, 400);
        assert.equal(big.data.code, "USAGE_RANGE_TOO_BIG");
    });
});

describe("AI help: daily limits and reading a quick-entry line", () => {
    test("everybody starts the day with 1 scan and 5 AI helps", async () => {
        const ana = await member("quotaana");
        const r = await call("GET", "/api/ai/quota", null, ana.token);
        assert.equal(r.status, 200);
        assert.deepEqual({ available: r.data.available, scan: r.data.scan, aiLine: r.data.aiLine }, { available: true, scan: { used: 0, max: 1 }, aiLine: { used: 0, max: 5 } });
        assert.ok(Date.parse(r.data.resetsAt) > Date.now());
    });

    test("a line read by the AI comes back checked: the type found among my own, nothing out of range", async () => {
        const ben = await member("quotaben");
        const type = await call("POST", "/api/event-types", { name: "Schule" }, ben.token);
        await call("POST", "/api/event-types", { name: "School" }, ben.token);
        const r = await call("POST", "/api/ai/parse-entry", { text: "Study 19.11. 13:00 - 15:00 blue type: school, reminder 15 mins prior." }, ben.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const types = (await call("GET", "/api/event-types", null, ben.token)).data;
        const school = (Array.isArray(types) ? types : types.eventTypes ?? types.types).find(t => t.name === "School");
        assert.deepEqual(r.data.entry, {
            kind: "event", name: "Study", due: "2026-11-19", time: "13:00", durationMinutes: 120,
            color: "blue", eventTypeId: school.id, reminders: [15], prio: null,
        });
        assert.equal(type.status, 201);
        assert.deepEqual(r.data.quota.aiLine, { used: 1, max: 5 });
    });

    test("the sixth AI help of the day is refused with when it comes back", async () => {
        const cleo = await member("quotacleo");
        for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/ai/parse-entry", { text: `Lernen ${i}` }, cleo.token)).status, 200);
        const sixth = await call("POST", "/api/ai/parse-entry", { text: "Lernen 6" }, cleo.token);
        assert.equal(sixth.status, 429);
        assert.equal(sixth.data.code, "QUOTA_REACHED");
        assert.equal(sixth.data.kind, "aiLine");
        assert.ok(Date.parse(sixth.data.resetsAt) > Date.now());
    });

    test("a failed AI answer doesn't use up a help", async () => {
        const dora = await member("quotadora");
        const r = await call("POST", "/api/ai/parse-entry", { text: "AI_FAIL bitte" }, dora.token);
        assert.equal(r.status, 502);
        assert.equal(r.data.code, "AI_FAILED");
        assert.equal((await call("GET", "/api/ai/quota", null, dora.token)).data.aiLine.used, 0);
    });

    test("an empty or overlong line and accounts without access are refused", async () => {
        const emil = await member("quotaemil");
        assert.equal((await call("POST", "/api/ai/parse-entry", { text: "  " }, emil.token)).status, 400);
        assert.equal((await call("POST", "/api/ai/parse-entry", { text: "x".repeat(501) }, emil.token)).status, 400);
        const nobeta = await member("quotanobeta", { pro: false });
        assert.equal((await call("GET", "/api/ai/quota", null, nobeta.token)).status, 403);
        assert.equal((await call("GET", "/api/ai/quota")).status, 401);
    });
});

describe("AI scan: a document, photos or a note into a plan, notes and entries", () => {
    const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF").toString("base64");
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

    test("reads pasted text into what was asked for, checked, and uses the day's scan", async () => {
        const ina = await member("scanina");
        const r = await call("POST", "/api/ai/scan", { wants: ["plan", "notes", "entries"], source: { kind: "text", text: "Klausur Biologie am 2.3. ..." } }, ina.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.deepEqual(r.data.result.plan, {
            name: "Biologie Klausur", kind: "exam", due: "2099-03-02", subject: "Biologie",
            parts: [{ name: "Zellatmung", minutes: 90 }, { name: "Fotosynthese", minutes: 15 }],
        });
        assert.deepEqual(r.data.result.notes, { title: "Zellatmung", body: "# Zellatmung\n- Glykolyse\n- [ ] Schaubild" });
        assert.deepEqual(r.data.result.entries.map(e => [e.kind, e.name, e.due, e.time, e.durationMinutes]), [
            ["event", "Klausur Biologie", "2099-03-02", "08:00", 90],
            ["task", "Abgabe Protokoll", "2099-02-27", null, null],
            ["task", "kaputt", null, null, null],
        ]);
        assert.deepEqual(r.data.quota.scan, { used: 1, max: 1 });
        const again = await call("POST", "/api/ai/scan", { wants: ["notes"], source: { kind: "text", text: "noch was" } }, ina.token);
        assert.equal(again.status, 429);
        assert.equal(again.data.kind, "scan");
    });

    test("only what was asked for comes back", async () => {
        const jan = await member("scanjan");
        const r = await call("POST", "/api/ai/scan", { wants: ["notes"], source: { kind: "pdf", data: PDF, name: "skript.pdf" } }, jan.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.result.plan, null);
        assert.deepEqual(r.data.result.entries, []);
        assert.equal(r.data.result.notes.title, "Zellatmung");
    });

    test("one of my own notes can be scanned, nobody else's", async () => {
        const kai = await member("scankai");
        const lou = await member("scanlou");
        const note = await call("POST", "/api/notebook", { title: "Bio", body: "Zellatmung, Fotosynthese" }, kai.token);
        assert.equal((await call("POST", "/api/ai/scan", { wants: ["plan"], source: { kind: "note", noteId: note.data.id } }, lou.token)).status, 404);
        assert.equal((await call("GET", "/api/ai/quota", null, lou.token)).data.scan.used, 0);
        assert.equal((await call("POST", "/api/ai/scan", { wants: ["plan"], source: { kind: "note", noteId: note.data.id } }, kai.token)).status, 200);
    });

    test("what isn't a PDF or a picture, too many pictures, or nothing asked for is refused, and costs nothing", async () => {
        const mo = await member("scanmo");
        const bad = [
            { wants: [], source: { kind: "text", text: "x" } },
            { wants: ["notes"], source: { kind: "pdf", data: Buffer.from("<html>").toString("base64") } },
            { wants: ["notes"], source: { kind: "images", images: Array.from({ length: 6 }, () => ({ data: PNG })) } },
            { wants: ["notes"], source: { kind: "images", images: [{ data: Buffer.from("GIF89a").toString("base64") }] } },
            { wants: ["notes"], source: { kind: "text", text: "" } },
            { wants: ["essay"], source: { kind: "text", text: "x" } },
        ];
        for (const body of bad) assert.equal((await call("POST", "/api/ai/scan", body, mo.token)).status, 400, JSON.stringify(body).slice(0, 80));
        assert.equal((await call("GET", "/api/ai/quota", null, mo.token)).data.scan.used, 0);
        assert.equal((await call("POST", "/api/ai/scan", { wants: ["notes"], source: { kind: "images", images: [{ data: PNG }] } }, mo.token)).status, 200);
    });

    test("a failed scan gives the day's scan back", async () => {
        const nia = await member("scannia");
        const r = await call("POST", "/api/ai/scan", { wants: ["notes"], source: { kind: "text", text: "AI_FAIL" } }, nia.token);
        assert.equal(r.status, 502);
        assert.equal((await call("GET", "/api/ai/quota", null, nia.token)).data.scan.used, 0);
    });
});

describe("Untis: the timetable in the calendar", () => {
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = iso(new Date());
    const LOGIN = { mode: "login", server: "neilo.webuntis.com", school: "gym-muster", schoolLabel: "Gymnasium Musterstadt", username: "lena", password: "richtig" };

    test("not connected at first; schools are found, only on webuntis.com", async () => {
        const ole = await member("untisole");
        const status = await call("GET", "/api/untis", null, ole.token);
        assert.equal(status.status, 200);
        assert.deepEqual(status.data, { available: true, connected: false });
        assert.equal((await call("GET", "/api/untis/schools?q=ab", null, ole.token)).status, 400);
        const found = await call("GET", "/api/untis/schools?q=Muster", null, ole.token);
        assert.deepEqual(found.data, [{ server: "neilo.webuntis.com", school: "gym-muster", label: "Gymnasium Musterstadt", address: "Musterstadt" }]);
    });

    test("a wrong password stores nothing", async () => {
        const pia = await member("untispia");
        const r = await call("PUT", "/api/untis", { ...LOGIN, password: "falsch" }, pia.token);
        assert.equal(r.status, 400);
        assert.equal(r.data.code, "UNTIS_LOGIN_FAILED");
        assert.equal((await sql("SELECT count(*)::int AS n FROM untis_accounts WHERE user_id = $1", [pia.id]))[0].n, 0);
    });

    test("signed in: the lessons are there (a double lesson as one, a cancelled one marked), the password only encrypted", async () => {
        const quinn = await member("untisquinn");
        const r = await call("PUT", "/api/untis", LOGIN, quinn.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.connected, true);
        assert.equal(r.data.mode, "login");
        assert.equal(r.data.schoolLabel, "Gymnasium Musterstadt");
        assert.equal(r.data.username, "lena");
        assert.ok(r.data.lastSyncAt);
        const [row] = await sql("SELECT secret FROM untis_accounts WHERE user_id = $1", [quinn.id]);
        assert.ok(!row.secret.includes("richtig"));
        const lessons = await call("GET", `/api/untis/lessons?from=${today}&to=${today}`, null, quinn.token);
        assert.equal(lessons.status, 200);
        assert.deepEqual(lessons.data.lessons.map(l => [l.day, l.start, l.end, l.subject, l.room, l.status]), [
            [today, "08:00", "09:35", "M", "R12", "normal"],
            [today, "09:55", "10:40", "E", "R3", "cancelled"],
        ]);
        assert.equal(lessons.data.lessons[0].subjectLong, "Mathematik");
        // the session was ended again
        assert.ok(fakeUntis.calls.some(c => c.method === "logout"));
        // nobody else sees them
        const rae = await member("untisrae");
        assert.deepEqual((await call("GET", `/api/untis/lessons?from=${today}&to=${today}`, null, rae.token)).data.lessons, []);
    });

    test("the iCal link: only https on webuntis.com", async () => {
        const sam = await member("untissam");
        for (const url of ["http://neilo.webuntis.com/WebUntis/Ical.do?key=abc", "https://evil.example.com/x.ics", "https://127.0.0.1/x.ics"]) {
            assert.equal((await call("PUT", "/api/untis", { mode: "ical", url }, sam.token)).status, 400, url);
        }
        const wrong = await call("PUT", "/api/untis", { mode: "ical", url: "https://neilo.webuntis.com/WebUntis/Ical.do?key=nope" }, sam.token);
        assert.equal(wrong.status, 400);
        const r = await call("PUT", "/api/untis", { mode: "ical", url: "https://neilo.webuntis.com/WebUntis/Ical.do?key=abc" }, sam.token);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.mode, "ical");
        const lessons = await call("GET", `/api/untis/lessons?from=${today}&to=${today}`, null, sam.token);
        assert.deepEqual(lessons.data.lessons.map(l => [l.subject, l.start, l.end, l.room]), [["Biologie", "10:00", "10:45", "Lab"]]);
    });

    test("disconnecting deletes the login and every lesson", async () => {
        const tom = await member("untistom");
        await call("PUT", "/api/untis", LOGIN, tom.token);
        assert.equal((await call("DELETE", "/api/untis", null, tom.token)).status, 204);
        assert.equal((await sql("SELECT count(*)::int AS n FROM untis_accounts WHERE user_id = $1", [tom.id]))[0].n, 0);
        assert.equal((await sql("SELECT count(*)::int AS n FROM untis_lessons WHERE user_id = $1", [tom.id]))[0].n, 0);
        assert.deepEqual((await call("GET", "/api/untis", null, tom.token)).data, { available: true, connected: false });
    });

    test("homework in Untis becomes a task with the day, the lesson's time and the text, once", async () => {
        const wes = await member("untiswes");
        const status = (await call("PUT", "/api/untis", LOGIN, wes.token)).data;
        assert.equal(status.homeworkToTasks, true);
        const tomorrow = daysFromToday(1);
        const tasks = () => call("GET", "/api/tasks", null, wes.token).then(r => r.data.filter(t => t.name.startsWith("D:")));
        const made = await tasks();
        assert.equal(made.length, 1);
        assert.equal(made[0].name, "D: Hausaufgabe");
        assert.equal(String(made[0].due).slice(0, 10) === tomorrow || iso(new Date(made[0].due)) === tomorrow, true);
        assert.equal(made[0].due_time, "08:00");
        assert.equal(made[0].description, "Aufsatz Seite 12\nbitte tippen");
        // fetched again: no second one; deleted by hand: not made again
        await call("POST", "/api/untis/sync", null, wes.token);
        await sql("UPDATE untis_accounts SET last_sync_at = now() - interval '2 minutes' WHERE user_id = $1", [wes.id]);
        await call("POST", "/api/untis/sync", null, wes.token);
        assert.equal((await tasks()).length, 1);
        await call("DELETE", `/api/tasks/${made[0].id}`, null, wes.token);
        await sql("UPDATE untis_accounts SET last_sync_at = now() - interval '2 minutes' WHERE user_id = $1", [wes.id]);
        await call("POST", "/api/untis/sync", null, wes.token);
        assert.equal((await tasks()).length, 0);
    });

    test("switched off, no homework task is made", async () => {
        const xan = await member("untisxan");
        const off = await call("PUT", "/api/untis/settings", { homeworkToTasks: false }, xan.token);
        assert.equal(off.status, 404);
        await call("PUT", "/api/untis", LOGIN, xan.token);
        await call("DELETE", "/api/untis", null, xan.token);
        await call("PUT", "/api/untis", { ...LOGIN }, xan.token);
        const r = await call("PUT", "/api/untis/settings", { homeworkToTasks: false }, xan.token);
        assert.equal(r.status, 200);
        assert.equal(r.data.homeworkToTasks, false);
        await sql("DELETE FROM tasks WHERE user_id = $1", [xan.id]);
        await sql("DELETE FROM untis_homework_tasks WHERE user_id = $1", [xan.id]);
        await sql("UPDATE untis_accounts SET last_sync_at = now() - interval '2 minutes' WHERE user_id = $1", [xan.id]);
        await call("POST", "/api/untis/sync", null, xan.token);
        assert.equal((await call("GET", "/api/tasks", null, xan.token)).data.filter(t => t.name.startsWith("D:")).length, 0);
        assert.equal((await call("PUT", "/api/untis/settings", { homeworkToTasks: "x" }, xan.token)).status, 400);
    });

    test("only with app access, and a long range is refused", async () => {
        const uma = await member("untisuma", { pro: false });
        assert.equal((await call("GET", "/api/untis", null, uma.token)).status, 403);
        const vic = await member("untisvic");
        assert.equal((await call("GET", "/api/untis/lessons?from=2026-01-01&to=2026-12-31", null, vic.token)).status, 400);
    });
});
