// The assistant's daily allowance (20 a day, quota kind `assistant`) and its token totals
// (utils/quota.js, migration 054). The database is a throwaway one built from schema.sql
// (connection from .env like max-billing.test.mjs), skipped without DB_USER.
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
const quota = require("../../utils/quota.js");

const NO_DB = !process.env.DB_USER && "no database configured (DB_* in .env)";
let admin, db, uid;
const dbName = `quidey_asstquota_${process.pid}`;
const conn = (database) => new pg.Client({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database,
});

before(async () => {
    if (NO_DB) return;
    admin = conn("postgres");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    db = conn(dbName);
    await db.connect();
    await db.query(readFileSync(join(here, "..", "..", "schema.sql"), "utf8"));
    await db.query("SET search_path = public");
});

after(async () => {
    await db?.end().catch(() => {});
    if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
        await admin.end().catch(() => {});
    }
});

beforeEach(async () => {
    if (NO_DB) return;
    await db.query("DELETE FROM users");
    uid = (await db.query("INSERT INTO users (username, password_hash, email) VALUES ('aq', 'x', 'aq@example.com') RETURNING id")).rows[0].id;
});

test("twenty assistant messages a day, the twenty-first is refused", { skip: NO_DB }, async () => {
    assert.equal(quota.DAILY.assistant, 20);
    for (let i = 1; i <= 20; i++) {
        const r = await quota.take(db, uid, "assistant");
        assert.equal(r.ok, true);
        assert.equal(r.used, i);
    }
    const over = await quota.take(db, uid, "assistant");
    assert.equal(over.ok, false);
    assert.equal(over.max, 20);
    assert.equal(over.used, 20);
});

test("giveBack restores one", { skip: NO_DB }, async () => {
    let last;
    for (let i = 0; i < 20; i++) last = await quota.take(db, uid, "assistant");
    assert.equal((await quota.take(db, uid, "assistant")).ok, false);
    await quota.giveBack(db, uid, "assistant", last.day);
    const again = await quota.take(db, uid, "assistant");
    assert.equal(again.ok, true);
    assert.equal(again.used, 20);
});

test("the assistant allowance is separate from scan", { skip: NO_DB }, async () => {
    await quota.take(db, uid, "assistant");
    assert.equal((await quota.take(db, uid, "scan")).used, 1);
});

test("recordUsage adds up tokens and calls", { skip: NO_DB }, async () => {
    const { day } = await quota.take(db, uid, "assistant");
    await quota.recordUsage(db, uid, day, { inputTokens: 100, outputTokens: 40 });
    await quota.recordUsage(db, uid, day, { inputTokens: 50, outputTokens: 10 });
    const { rows } = await db.query("SELECT calls, input_tokens::int AS i, output_tokens::int AS o FROM assistant_usage WHERE user_id = $1", [uid]);
    assert.deepEqual(rows, [{ calls: 2, i: 150, o: 50 }]);
});

test("status includes assistant", { skip: NO_DB }, async () => {
    assert.deepEqual((await quota.status(db, uid)).assistant, { used: 0, max: 20 });
    await quota.take(db, uid, "assistant");
    assert.deepEqual((await quota.status(db, uid)).assistant, { used: 1, max: 20 });
});

test("forgetOldDays removes old assistant_usage rows and keeps recent ones", { skip: NO_DB }, async () => {
    await db.query("INSERT INTO assistant_usage (user_id, day, calls, input_tokens, output_tokens) VALUES ($1, current_date - 30, 1, 1, 1), ($1, current_date, 1, 1, 1)", [uid]);
    await quota.forgetOldDays(db);
    assert.equal((await db.query("SELECT 1 FROM assistant_usage WHERE user_id = $1", [uid])).rowCount, 1);
});
