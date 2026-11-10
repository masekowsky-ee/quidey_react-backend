// Checks the migration files themselves: scripts/migrate.sh refuses to run when these rules are
// broken, so catch it here before it reaches the server. The file checks need no database; the 044
// test needs PostgreSQL (connection from .env like api.test.mjs) and is skipped without DB_USER.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import dotenv from "dotenv";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const ROOT = join(DIR, "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });
const NO_DB = !process.env.DB_USER && "no database configured (DB_* in .env)";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

test("migration file names are NNN_lower_case_name.sql", () => {
    const bad = files.filter((f) => !/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(f));
    assert.deepEqual(bad, []);
});

test("every migration number is used only once", () => {
    const byNumber = new Map();
    for (const f of files) {
        const n = f.slice(0, 3);
        byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
    }
    const duplicates = [...byNumber.values()].filter((list) => list.length > 1);
    assert.deepEqual(duplicates, []);
});

test("no migration is empty", () => {
    const empty = files.filter((f) => readFileSync(join(DIR, f), "utf8").trim() === "");
    assert.deepEqual(empty, []);
});

// migrate.sh runs each file inside one transaction (psql -1); these can't run in one.
test("no migration needs to run outside a transaction", () => {
    const forbidden = /\b(CONCURRENTLY|VACUUM)\b|^\s*(COMMIT|ROLLBACK)\s*;/im;
    const bad = files.filter((f) => {
        const sql = readFileSync(join(DIR, f), "utf8").replace(/--.*$/gm, "");
        return forbidden.test(sql);
    });
    assert.deepEqual(bad, []);
});

// 044 needs a real database: a throwaway one built from schema.sql (connection from .env, DB_NAME is ignored)
test("044 adds the consent columns and the usage tables, runs twice without harm, checks the consent value", { skip: NO_DB }, async () => {
    const conn = (database) => ({
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
    });
    const name = `quidey_mig044_${process.pid}`;
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const db = new pg.Client(conn(name));
    try {
        await db.connect();
        await db.query(readFileSync(join(ROOT, "schema.sql"), "utf8"));
        await db.query("SET search_path = public");
        // back to the schema before 044
        await db.query("DROP TABLE IF EXISTS usage_seen, usage_people, usage_hourly");
        await db.query("ALTER TABLE users DROP COLUMN IF EXISTS usage_consent, DROP COLUMN IF EXISTS usage_consent_at, DROP COLUMN IF EXISTS usage_consent_version");

        const migration = readFileSync(join(DIR, "044_usage_statistics.sql"), "utf8");
        await db.query(migration);
        await db.query(migration); // a second run is a no-op

        const cols = async (table) => (await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]
        )).rows.map((r) => r.column_name);
        assert.deepEqual((await cols("users")).filter((c) => c.startsWith("usage_")).sort(),
            ["usage_consent", "usage_consent_at", "usage_consent_version"]);
        assert.deepEqual((await cols("usage_hourly")).sort(),
            ["events", "hour", "language", "local_hour", "metric", "people", "plan", "platform", "value_sum", "weekday"]);
        assert.deepEqual((await cols("usage_seen")).sort(), ["metric", "period", "scope", "user_id"]);
        assert.deepEqual((await cols("usage_people")).sort(),
            ["language", "metric", "people", "period", "plan", "platform", "scope"]);

        const idx = (await db.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'usage_%'")).rows.map((r) => r.indexname);
        assert.ok(idx.includes("usage_seen_user_idx"), "index for withdrawing by user");
        assert.ok(idx.includes("usage_hourly_hour_idx"), "index on hour");

        const u = (await db.query(
            "INSERT INTO users (username, password_hash, email) VALUES ('mig044', 'x', 'mig044@example.com') RETURNING id")).rows[0].id;
        await db.query("UPDATE users SET usage_consent = 'granted' WHERE id = $1", [u]);
        await db.query("UPDATE users SET usage_consent = NULL WHERE id = $1", [u]);
        await assert.rejects(db.query("UPDATE users SET usage_consent = 'maybe' WHERE id = $1", [u]), /usage_consent_check|check constraint/i);
    } finally {
        await db.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.end();
    }
});

test("047 keeps the tips seen per account; who saw the old tour has the basics seen, others none", { skip: NO_DB }, async () => {
    const conn = (database) => ({
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
    });
    const name = `quidey_mig047_${process.pid}`;
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const db = new pg.Client(conn(name));
    try {
        await db.connect();
        await db.query(readFileSync(join(ROOT, "schema.sql"), "utf8"));
        await db.query("SET search_path = public");
        // back to the schema before 047
        await db.query("ALTER TABLE users DROP COLUMN IF EXISTS tips_seen, DROP COLUMN IF EXISTS tips_off");
        const add = async (username, tourSeen) => (await db.query(
            `INSERT INTO users (username, password_hash, email, tour_seen_at) VALUES ($1, 'x', $1 || '@example.com', $2) RETURNING id`,
            [username, tourSeen ? new Date() : null])).rows[0].id;
        const old = await add("mig047old", true);
        const fresh = await add("mig047new", false);

        const migration = readFileSync(join(DIR, "047_feature_tips.sql"), "utf8");
        await db.query(migration);
        await db.query(migration); // a second run changes nothing

        const seen = async (id) => (await db.query("SELECT tips_seen, tips_off FROM users WHERE id = $1", [id])).rows[0];
        const oldRow = await seen(old);
        assert.ok(oldRow.tips_seen.includes("navHome") && oldRow.tips_seen.includes("calendarDrag"), JSON.stringify(oldRow));
        assert.ok(!oldRow.tips_seen.includes("notesNew") && !oldRow.tips_seen.includes("studyGoal"), "new features stay to be seen");
        assert.equal(new Set(oldRow.tips_seen).size, oldRow.tips_seen.length, "each once, also after a second run");
        assert.equal(oldRow.tips_off, false);
        assert.deepEqual(await seen(fresh), { tips_seen: [], tips_off: false });
        await assert.rejects(db.query("UPDATE users SET tips_seen = $1 WHERE id = $2",
            [Array.from({ length: 301 }, (_, i) => `t${i}`), fresh]), /tips_seen_check|check constraint/i);
    } finally {
        await db.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.end();
    }
});
