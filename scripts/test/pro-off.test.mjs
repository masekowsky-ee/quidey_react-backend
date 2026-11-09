// Quidey Pro switched off (PRO_BILLING not "on", the default): nothing is sold, and even after the
// beta (ACCESS_MODE=open) nobody has the free plan's limits. Without a database, like limits.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.ACCESS_MODE = "open";
delete process.env.PRO_BILLING;
const require = createRequire(import.meta.url);
const { PRO_BILLING, requireProBilling, hasAppAccess } = require("../../utils/access.js");
const { limited, limitReached } = require("../../utils/limits.js");

const free = { id: 1, is_pro: false, pro_until: null, is_tester: false, is_admin: false };

test("off by default: no limits, everybody still gets in after the beta", async () => {
    assert.equal(PRO_BILLING, false);
    assert.equal(hasAppAccess(free), true);
    assert.equal(limited(free), false);
    assert.equal(await limitReached({ query: async () => ({ rows: [{ n: 500 }] }) }, free, "tasks"), null);
});

test("the selling routes answer 404 BILLING_OFF", () => {
    let sent = null;
    let passed = false;
    const res = { status(code) { sent = { code }; return this; }, json(body) { sent.body = body; } };
    requireProBilling({}, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(sent.code, 404);
    assert.equal(sent.body.code, "BILLING_OFF");
});
