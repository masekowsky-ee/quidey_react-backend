// The Max tier (a superset of Pro): hasMax / hasPro on a users row, and refreshProUntil keeping
// pro_until and max_until from the subscriptions. No database: refreshProUntil runs on a fake db.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const { hasMax, hasPro, MAX_SQL } = require("../../utils/access.js");
const { refreshProUntil } = require("../../utils/billing.js");

const DAY = 24 * 60 * 60 * 1000;
const future = new Date(Date.now() + 30 * DAY);
const past = new Date(Date.now() - DAY);

test("hasMax: a gift, a running subscription or an admin", () => {
    assert.equal(hasMax({ is_max: true }), true);
    assert.equal(hasMax({ max_until: future }), true);
    assert.equal(hasMax({ is_admin: true }), true);
});

test("hasMax: not for a Pro-only, expired or empty account", () => {
    assert.equal(hasMax({ is_pro: true, pro_until: future }), false);
    assert.equal(hasMax({ max_until: past }), false);
    assert.equal(hasMax({}), false);
    assert.equal(hasMax(null), false);
});

test("hasPro is true for a Max-only account", () => {
    assert.equal(hasPro({ is_max: true }), true);
    assert.equal(hasPro({ max_until: future }), true);
    assert.equal(hasPro({ max_until: past }), false);
});

test("MAX_SQL is a users-table condition", () => {
    assert.match(MAX_SQL, /users\.is_max/);
    assert.match(MAX_SQL, /users\.max_until > now\(\)/);
});

// refreshProUntil against a real database: a throwaway one built from schema.sql (connection from .env
// like migrations.test.mjs), skipped without DB_USER.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env"), quiet: true });
const NO_DB = !process.env.DB_USER && "no database configured (DB_* in .env)";

test("refreshProUntil: one running max and one expired pro", { skip: NO_DB }, async () => {
    const conn = (database) => new pg.Client({
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
    });
    const name = `quidey_max053_${process.pid}`;
    const admin = conn("postgres");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const db = conn(name);
    try {
        await db.connect();
        await db.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema.sql"), "utf8"));
        await db.query("SET search_path = public");
        const uid = (await db.query("INSERT INTO users (username, password_hash, email) VALUES ('maxu', 'x', 'maxu@example.com') RETURNING id")).rows[0].id;
        const maxEnd = new Date(Date.now() + 20 * DAY);
        const proEnd = new Date(Date.now() - DAY);
        const add = (id, tier, end) => db.query(
            "INSERT INTO subscriptions (user_id, provider, provider_id, plan, tier, status, current_period_end) VALUES ($1, 'stripe', $2, 'monthly', $3, 'active', $4)",
            [uid, id, tier, end]);
        await add("s_max", "max", maxEnd);
        await add("s_pro", "pro", proEnd);
        await refreshProUntil(db, uid);
        let row = (await db.query("SELECT pro_until, max_until FROM users WHERE id = $1", [uid])).rows[0];
        assert.equal(row.max_until.getTime(), maxEnd.getTime());
        assert.equal(row.pro_until.getTime(), maxEnd.getTime()); // the later of the two
        // a running pro only: max_until is cleared
        await db.query("DELETE FROM subscriptions WHERE provider_id = 's_max'");
        const proRunning = new Date(Date.now() + 10 * DAY);
        await add("s_pro2", "pro", proRunning);
        await refreshProUntil(db, uid);
        row = (await db.query("SELECT pro_until, max_until FROM users WHERE id = $1", [uid])).rows[0];
        assert.equal(row.max_until, null);
        assert.equal(row.pro_until.getTime(), proRunning.getTime());
    } finally {
        await db.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
        await admin.end().catch(() => {});
    }
});
