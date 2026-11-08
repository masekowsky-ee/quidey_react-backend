// Unit tests of the usage counting core (utils/usage.js) against a throwaway PostgreSQL database.
// Same setup as api.test.mjs: a database from schema.sql (connection from .env), dropped afterwards. No server.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import pg from "pg";
import dotenv from "dotenv";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });
const require = createRequire(import.meta.url);
const { countUsage, planOf, isMetric, cleanupUsage, startUsageCleanup, withdrawUsage, forgetUsageAccount, localParts, cleanPlatform } = require("../../utils/usage.js");

const DB = `quidey_test_usage_${process.pid}`;
const conn = (database) => ({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
});
let pool;
const sql = async (text, params) => (await pool.query(text, params)).rows;

let n = 0;
// a user, consent granted by default
async function user({ consent = "granted", timezone = "Europe/Berlin", language = "de", tester = false } = {}) {
    n++;
    const [row] = await sql(
        "INSERT INTO users (username, password_hash, email, usage_consent, timezone, language, is_tester) VALUES ($1,'x',$2,$3,$4,$5,$6) RETURNING id",
        [`u${n}`, `u${n}@example.com`, consent, timezone, language, tester]);
    forgetUsageAccount(row.id);
    return row.id;
}
const T0 = new Date("2026-11-10T12:10:00Z");
const hours = (d, h) => new Date(d.getTime() + h * 3600e3);

before(async () => {
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    // schema.sql empties the search_path of its connection, so it gets a connection of its own
    const loader = new pg.Client(conn(DB));
    await loader.connect();
    await loader.query(readFileSync(join(ROOT, "schema.sql"), "utf8"));
    await loader.end();
    pool = new pg.Pool(conn(DB));
});
after(async () => {
    await pool?.end();
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
});
beforeEach(async () => {
    await sql("TRUNCATE usage_hourly, usage_seen, usage_people");
});

describe("usage counting core", () => {
    test("no consent -> nothing stored", async () => {
        const u = await user({ consent: null });
        assert.equal(await countUsage(pool, u, "task_done", { at: T0 }), false);
        const d = await user({ consent: "denied" });
        assert.equal(await countUsage(pool, d, "task_done", { at: T0 }), false);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
        assert.equal((await sql("SELECT * FROM usage_seen")).length, 0);
    });

    test("same person twice in one hour", async () => {
        const u = await user();
        assert.equal(await countUsage(pool, u, "task_done", { at: T0 }), true);
        assert.equal(await countUsage(pool, u, "task_done", { at: hours(T0, 0.1) }), true);
        const [row] = await sql("SELECT events, people FROM usage_hourly WHERE metric = 'task_done'");
        assert.deepEqual([row.events, row.people], [2, 1]);
        const [act] = await sql("SELECT events, people FROM usage_hourly WHERE metric = 'active'");
        assert.equal(act.people, 1);
    });

    test("next hour counts the person again", async () => {
        const u = await user();
        await countUsage(pool, u, "task_done", { at: T0 });
        await countUsage(pool, u, "task_done", { at: hours(T0, 1) });
        const rows = await sql("SELECT people FROM usage_hourly WHERE metric = 'task_done' ORDER BY hour");
        assert.deepEqual(rows.map((r) => r.people), [1, 1]);
        const day = await sql("SELECT people FROM usage_people WHERE scope = 'day' AND metric = 'task_done'");
        assert.deepEqual(day.map((r) => r.people), [1]);
    });

    test("two people", async () => {
        const a = await user(), b = await user();
        await countUsage(pool, a, "task_done", { at: T0 });
        await countUsage(pool, b, "task_done", { at: T0 });
        const day = await sql("SELECT people FROM usage_people WHERE scope = 'day' AND metric = 'task_done'");
        assert.deepEqual(day.map((r) => r.people), [2]);
        const week = await sql("SELECT people FROM usage_people WHERE scope = 'week' AND metric = 'active'");
        assert.deepEqual(week.map((r) => r.people), [2]);
    });

    test("value is summed", async () => {
        const u = await user();
        await countUsage(pool, u, "focus_done", { at: T0, value: 600 });
        await countUsage(pool, u, "focus_done", { at: T0, value: 900 });
        const [row] = await sql("SELECT value_sum FROM usage_hourly WHERE metric = 'focus_done'");
        assert.equal(Number(row.value_sum), 1500);
    });

    test("local time", async () => {
        const u = await user({ timezone: "America/New_York" });
        await countUsage(pool, u, "app_open", { at: new Date("2026-11-10T01:30:00Z") });
        const [h] = await sql("SELECT local_hour, weekday FROM usage_hourly WHERE metric = 'app_open'");
        assert.deepEqual([h.local_hour, h.weekday], [20, 1]);
        const [p] = await sql("SELECT period::text FROM usage_people WHERE scope = 'day' AND metric = 'app_open'");
        assert.equal(p.period, "2026-11-09");
        const [w] = await sql("SELECT period::text FROM usage_people WHERE scope = 'week' AND metric = 'app_open'");
        assert.equal(w.period, "2026-11-09");
        const at = new Date("2026-11-10T01:30:00Z");
        assert.deepEqual(localParts(at, "Nowhere/Land"), localParts(at, "Europe/Berlin"));
    });

    test("dimensions", async () => {
        const u = await user({ tester: true, language: "en" });
        await countUsage(pool, u, "app_open", { at: T0, platform: "pwa" });
        const [row] = await sql("SELECT plan, language, platform FROM usage_hourly WHERE metric = 'app_open'");
        assert.deepEqual({ ...row }, { plan: "tester", language: "en", platform: "pwa" });
        const future = new Date(Date.now() + 86400e3);
        assert.equal(planOf({ is_pro: false, pro_until: future, is_tester: false, is_admin: false }), "pro");
        assert.equal(planOf({ is_pro: false, pro_until: null, is_tester: false, is_admin: false }), "free");
        assert.equal(cleanPlatform("ios"), "web");
        assert.equal(cleanPlatform("android"), "android");
    });

    test("metric whitelist", async () => {
        const u = await user();
        assert.equal(await countUsage(pool, u, "bogus", { at: T0 }), false);
        assert.equal(await countUsage(pool, u, "active", { at: T0 }), false);
        assert.equal(isMetric("view:calendar"), true);
        assert.equal(isMetric("view:u/anna"), false);
        assert.equal(isMetric("task_done"), true);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
    });

    test("cleanup", async () => {
        const now = new Date();
        const u = await user();
        // marks whose period started this long ago (inserted directly: a week mark's start depends on the weekday)
        const mark = (scope, ms) => sql("INSERT INTO usage_seen (scope, period, metric, user_id) VALUES ($1, $2, 'app_open', $3)", [scope, new Date(now.getTime() - ms), u]);
        // hour marks live 26 h (the beacon takes events up to 24 h late), day marks 2 days, week marks 8 days
        await mark("hour", 27 * 3600e3); await mark("hour", 3 * 3600e3);
        await mark("day", 3 * 86400e3); await mark("day", 86400e3);
        await mark("week", 9 * 86400e3); await mark("week", 6 * 86400e3);
        await countUsage(pool, u, "task_done", { at: now });
        assert.equal(await cleanupUsage(pool, now), 3);
        const left = async (scope, ms) => (await sql("SELECT 1 FROM usage_seen WHERE scope = $1 AND period = $2 AND metric = 'app_open'", [scope, new Date(now.getTime() - ms)])).length;
        assert.equal(await left("hour", 27 * 3600e3), 0);
        assert.equal(await left("hour", 3 * 3600e3), 1);
        assert.equal(await left("day", 3 * 86400e3), 0);
        assert.equal(await left("day", 86400e3), 1);
        assert.equal(await left("week", 9 * 86400e3), 0);
        assert.equal(await left("week", 6 * 86400e3), 1);
        // marks of the current moment and the totals stay
        assert.ok((await sql("SELECT 1 FROM usage_seen WHERE metric = 'task_done'")).length > 0);
        assert.ok((await sql("SELECT 1 FROM usage_hourly")).length > 0);
    });

    test("the cleanup runs once at start, then on its interval; a failure is only logged", async () => {
        const u = await user();
        await sql("INSERT INTO usage_seen (scope, period, metric, user_id) VALUES ('hour', $1, 'app_open', $2)", [new Date(Date.now() - 30 * 3600e3), u]);
        const timer = startUsageCleanup(pool, 60 * 60 * 1000);
        try {
            for (let i = 0; i < 50 && (await sql("SELECT 1 FROM usage_seen WHERE user_id = $1", [u])).length; i++) await new Promise((r) => setTimeout(r, 20));
            assert.equal((await sql("SELECT 1 FROM usage_seen WHERE user_id = $1", [u])).length, 0);
        } finally {
            clearInterval(timer);
        }
        const logged = [];
        const original = console.error;
        console.error = (...args) => logged.push(args.join(" "));
        const broken = { query: async () => { throw new Error("db down"); } };
        const second = startUsageCleanup(broken, 60 * 60 * 1000);
        try {
            await new Promise((r) => setTimeout(r, 20));
            assert.deepEqual(logged, ["Cleaning up usage marks failed: db down"]);
        } finally {
            clearInterval(second);
            console.error = original;
        }
    });

    test("one person, two metrics in one hour: active counts them once", async () => {
        const u = await user();
        await countUsage(pool, u, "app_open", { at: T0 });
        await countUsage(pool, u, "task_done", { at: hours(T0, 0.1) });
        const [h] = await sql("SELECT people FROM usage_hourly WHERE metric = 'active'");
        assert.equal(h.people, 1);
        const [d] = await sql("SELECT people FROM usage_people WHERE scope = 'day' AND metric = 'active'");
        assert.equal(d.people, 1);
    });

    test("a count racing a withdrawal writes nothing", async () => {
        const u = await user();
        assert.equal(await countUsage(pool, u, "app_open", { at: T0 }), true); // the account (granted) is cached now
        // withdrawn in the database, the cache hasn't heard of it yet
        await sql("UPDATE users SET usage_consent = 'denied' WHERE id = $1", [u]);
        await sql("DELETE FROM usage_seen WHERE user_id = $1", [u]);
        await sql("TRUNCATE usage_hourly, usage_people");
        assert.equal(await countUsage(pool, u, "task_done", { at: T0 }), false);
        assert.equal((await sql("SELECT * FROM usage_seen WHERE user_id = $1", [u])).length, 0);
        assert.equal((await sql("SELECT * FROM usage_hourly")).length, 0);
        assert.equal((await sql("SELECT * FROM usage_people")).length, 0);
    });

    test("withdraw", async () => {
        const u = await user(), o = await user();
        await countUsage(pool, u, "task_done", { at: T0 });
        await countUsage(pool, o, "task_done", { at: T0 });
        await withdrawUsage(pool, u);
        assert.equal((await sql("SELECT * FROM usage_seen WHERE user_id = $1", [u])).length, 0);
        assert.ok((await sql("SELECT * FROM usage_seen WHERE user_id = $1", [o])).length > 0);
    });
});
