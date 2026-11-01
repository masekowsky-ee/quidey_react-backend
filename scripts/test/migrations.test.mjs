// Checks the migration files themselves (no database needed): scripts/migrate.sh refuses to run
// when these rules are broken, so catch it here before it reaches the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
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
