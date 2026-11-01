// The free plan (utils/limits.js) in ACCESS_MODE=open, without a database: the counts come from
// a stand-in. (api.test.mjs runs the server in the beta mode, where nobody has limits.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.ACCESS_MODE = "open";
const require = createRequire(import.meta.url);
const { FREE_LIMITS, limited, limitReached, refuseOverLimit, usage } = require("../utils/limits.js");
const { hasAppAccess } = require("../utils/access.js");

// answers every count with `n`
const db = (n) => ({ query: async () => ({ rows: [{ n }] }) });
const free = { id: 1, is_pro: false, pro_until: null, is_tester: false, is_admin: false };

test("after the beta everybody gets in; the free plan has limits, Pro / testers / admins none", () => {
    assert.equal(hasAppAccess(free), true);
    assert.equal(limited(free), true);
    assert.equal(limited({ ...free, is_pro: true }), false);
    assert.equal(limited({ ...free, pro_until: new Date(Date.now() + 86400000) }), false);
    assert.equal(limited({ ...free, pro_until: new Date(Date.now() - 86400000) }), true, "an ended subscription");
    assert.equal(limited({ ...free, is_tester: true }), false);
    assert.equal(limited({ ...free, is_admin: true }), false);
    assert.deepEqual(FREE_LIMITS, { tasks: 10, events: 5, groups: 3, sessions: 1, friends: 3 });
});

test("one more is fine below the limit, refused at it", async () => {
    assert.equal(await limitReached(db(9), free, "tasks"), null);
    assert.deepEqual(await limitReached(db(10), free, "tasks"), { limit: "tasks", max: 10 });
    assert.deepEqual(await limitReached(db(1), free, "sessions"), { limit: "sessions", max: 1 });
    assert.equal(await limitReached(db(500), { ...free, is_pro: true }, "tasks"), null);
});

test("the refusal is a 403 LIMIT_REACHED with what and how many", async () => {
    let sent = null;
    const res = { status(code) { sent = { code }; return this; }, json(body) { sent.body = body; } };
    assert.equal(await refuseOverLimit(db(3), res, free, "friends"), true);
    assert.equal(sent.code, 403);
    assert.equal(sent.body.code, "LIMIT_REACHED");
    assert.equal(sent.body.limit, "friends");
    assert.equal(sent.body.max, 3);
    assert.equal(await refuseOverLimit(db(0), res, free, "groups"), false);
});

test("usage counts each thing", async () => {
    assert.deepEqual(await usage(db(2), 1), { tasks: 2, events: 2, groups: 2, sessions: 2, friends: 2 });
});
