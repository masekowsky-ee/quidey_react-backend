// Selling Max (utils/billing.js): the four Stripe prices, the Play products, the tier every saved
// subscription carries, and a Pro subscriber buying Max (no second charge). Stripe and Google are
// mocks (billing._deps), so no real payment can happen. The database is a throwaway one built from
// schema.sql (connection from .env like max-access.test.mjs), skipped without DB_USER.
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
Object.assign(process.env, {
    STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: "whsec_dummy",
    STRIPE_PRICE_MONTHLY: "price_pro_m", STRIPE_PRICE_YEARLY: "price_pro_y",
    STRIPE_PRICE_MAX_MONTHLY: "price_max_m", STRIPE_PRICE_MAX_YEARLY: "price_max_y",
    PLAY_PRODUCT_ID: "quidey_pro", PLAY_PRODUCT_ID_MAX: "quidey_max", PLAY_PACKAGE_NAME: "com.quidey.app",
    JWT_SECRET: process.env.JWT_SECRET || "test-secret",
});
const require = createRequire(import.meta.url);
const billing = require("../../utils/billing.js");

const DAY = 24 * 60 * 60 * 1000;
const NO_DB = !process.env.DB_USER && "no database configured (DB_* in .env)";
const secs = (ms) => Math.floor(ms / 1000);

test("planOfPrice maps the four prices and nothing else", () => {
    assert.deepEqual(billing.planOfPrice("price_pro_m"), { tier: "pro", plan: "monthly" });
    assert.deepEqual(billing.planOfPrice("price_pro_y"), { tier: "pro", plan: "yearly" });
    assert.deepEqual(billing.planOfPrice("price_max_m"), { tier: "max", plan: "monthly" });
    assert.deepEqual(billing.planOfPrice("price_max_y"), { tier: "max", plan: "yearly" });
    assert.equal(billing.planOfPrice("price_other"), null);
    assert.equal(billing.planOfPrice(undefined), null);
    assert.equal(billing.planOfPrice(""), null);
});

test("saveSubscription refuses a call without a valid tier (it would overwrite the row's tier)", async () => {
    const db = { query: async () => { throw new Error("must not reach the database"); } };
    const base = { userId: 1, provider: "stripe", providerId: "sub_x", plan: "monthly", status: "active", periodEnd: new Date(), cancelAtPeriodEnd: false };
    await assert.rejects(billing.saveSubscription(db, base), /tier/);
    await assert.rejects(billing.saveSubscription(db, { ...base, tier: "gold" }), /tier/);
});

let admin, db, uid, calls;
const dbName = `quidey_maxbill_${process.pid}`;
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

// a stripe subscription object as Stripe sends / returns it
const stripeSub = (id, priceId, extra = {}) => ({
    id, status: "active", customer: "cus_1", metadata: { userId: String(uid) }, cancel_at_period_end: false,
    items: { data: [{ id: `si_${id}`, price: { id: priceId }, current_period_end: secs(Date.now() + 30 * DAY) }] }, ...extra,
});

beforeEach(async () => {
    if (NO_DB) return;
    await db.query("DELETE FROM subscriptions");
    await db.query("DELETE FROM users");
    uid = (await db.query("INSERT INTO users (username, password_hash, email, stripe_customer_id) VALUES ('maxb', 'x', 'maxb@example.com', 'cus_1') RETURNING id")).rows[0].id;
    calls = { stripeUpdate: [], stripeCheckout: [], play: [] };
    let current = {};
    billing._deps.stripe = {
        webhooks: { constructEvent: (body) => JSON.parse(body) },
        subscriptions: {
            retrieve: async (id) => current[id],
            update: async (id, params) => {
                calls.stripeUpdate.push([id, params]);
                const sub = structuredClone(current[id]);
                if (params.items) sub.items.data[0].price = { id: params.items[0].price };
                if ("cancel_at_period_end" in params) sub.cancel_at_period_end = params.cancel_at_period_end;
                current[id] = sub;
                return sub;
            },
        },
        checkout: { sessions: { create: async (p) => { calls.stripeCheckout.push(p); return { url: "https://checkout.test/x" }; } } },
        customers: { create: async () => ({ id: "cus_1" }) },
    };
    billing._deps.stripe.__serve = (sub) => { current[sub.id] = sub; };
    billing._deps.stripe.__has = (id) => id in current;
    billing._deps.playRequest = async (method, url) => {
        calls.play.push([method, url]);
        return billing._deps.playAnswers.get(url.replace(/.*tokens\//, "").replace(/:.*/, "")) ?? {};
    };
    billing._deps.playAnswers = new Map();
});

const row = async (provider, providerId) => (await db.query("SELECT * FROM subscriptions WHERE provider = $1 AND provider_id = $2", [provider, providerId])).rows[0];
const user = async () => (await db.query("SELECT pro_until, max_until FROM users WHERE id = $1", [uid])).rows[0];
// Stripe knows the subscription: unless a test served its state already, the event carries it
const webhook = (type, object) => {
    if (!billing._deps.stripe.__has(object.id)) billing._deps.stripe.__serve(object);
    return billing.stripeWebhook(db, JSON.stringify({ type, data: { object } }), "sig");
};

test("a Stripe webhook for a Max price saves tier max and sets max_until", { skip: NO_DB }, async () => {
    const owner = await webhook("customer.subscription.created", stripeSub("sub_m", "price_max_y"));
    assert.equal(owner, uid);
    const saved = await row("stripe", "sub_m");
    assert.equal(saved.tier, "max");
    assert.equal(saved.plan, "yearly");
    assert.ok((await user()).max_until);
    // a later update of the same subscription keeps it Max
    await webhook("customer.subscription.updated", stripeSub("sub_m", "price_max_y", { cancel_at_period_end: true }));
    assert.equal((await row("stripe", "sub_m")).tier, "max");
});

test("a Stripe webhook for a Pro price saves tier pro and leaves max_until empty", { skip: NO_DB }, async () => {
    await webhook("customer.subscription.created", stripeSub("sub_p", "price_pro_m"));
    assert.equal((await row("stripe", "sub_p")).tier, "pro");
    const u = await user();
    assert.ok(u.pro_until);
    assert.equal(u.max_until, null);
});

const playPurchase = (productId, extra = {}) => ({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    lineItems: [{ productId, expiryTime: new Date(Date.now() + 30 * DAY).toISOString(), offerDetails: { basePlanId: "yearly" }, autoRenewingPlan: { autoRenewEnabled: true } }],
    ...extra,
});

test("a Play purchase of quidey_max saves tier max; a notification keeps the tier", { skip: NO_DB }, async () => {
    billing._deps.playAnswers.set("tok_max_000001", playPurchase("quidey_max"));
    assert.equal(await billing.savePlayPurchase(db, "tok_max_000001", uid), uid);
    let saved = await row("play", "tok_max_000001");
    assert.equal(saved.tier, "max");
    assert.equal(saved.plan, "yearly");
    assert.ok((await user()).max_until);
    // Google's real-time notification (no user id) for the same token
    const data = Buffer.from(JSON.stringify({ packageName: "com.quidey.app", subscriptionNotification: { purchaseToken: "tok_max_000001" } })).toString("base64");
    await billing.playNotification(db, { message: { data } });
    saved = await row("play", "tok_max_000001");
    assert.equal(saved.tier, "max");
});

test("a Play purchase of quidey_pro saves tier pro; an unknown product is refused", { skip: NO_DB }, async () => {
    billing._deps.playAnswers.set("tok_pro_000001", playPurchase("quidey_pro"));
    await billing.savePlayPurchase(db, "tok_pro_000001", uid);
    assert.equal((await row("play", "tok_pro_000001")).tier, "pro");
    billing._deps.playAnswers.set("tok_bad_000001", playPurchase("something_else"));
    await assert.rejects(billing.savePlayPurchase(db, "tok_bad_000001", uid), { status: 400 });
});

test("Play acknowledges a new Max purchase with the Max product id", { skip: NO_DB }, async () => {
    billing._deps.playAnswers.set("tok_ack_000001", playPurchase("quidey_max", { acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }));
    await billing.savePlayPurchase(db, "tok_ack_000001", uid);
    assert.ok(calls.play.some(([m, url]) => m === "POST" && url.includes("/subscriptions/quidey_max/tokens/tok_ack_000001:acknowledge")));
});

test("Pro to Max on Stripe changes the running subscription (prorated, invoiced now), no second subscription", { skip: NO_DB }, async () => {
    const pro = stripeSub("sub_up", "price_pro_m");
    billing._deps.stripe.__serve(pro);
    await webhook("customer.subscription.created", pro);
    const result = await billing.stripeCheckout(db, { userId: uid, tier: "max", plan: "yearly", language: "en", frontendUrl: "https://app.test" });
    assert.deepEqual(result, { upgraded: true });
    assert.equal(calls.stripeCheckout.length, 0, "no new checkout: that would charge twice");
    assert.equal(calls.stripeUpdate.length, 1);
    const [id, params] = calls.stripeUpdate[0];
    assert.equal(id, "sub_up");
    assert.deepEqual(params.items, [{ id: "si_sub_up", price: "price_max_y" }]);
    assert.equal(params.proration_behavior, "always_invoice");
    assert.equal(params.payment_behavior, "error_if_incomplete");
    assert.equal(params.cancel_at_period_end, false);
    const rows = (await db.query("SELECT tier, plan FROM subscriptions WHERE user_id = $1", [uid])).rows;
    assert.deepEqual(rows, [{ tier: "max", plan: "yearly" }]);
    assert.ok((await user()).max_until);
});

test("a Max checkout without a Pro subscription is a normal Stripe Checkout with the Max price", { skip: NO_DB }, async () => {
    const result = await billing.stripeCheckout(db, { userId: uid, tier: "max", plan: "monthly", language: "de", frontendUrl: "https://app.test" });
    assert.deepEqual(result, { url: "https://checkout.test/x" });
    assert.equal(calls.stripeCheckout[0].line_items[0].price, "price_max_m");
    assert.equal(calls.stripeCheckout[0].subscription_data.metadata.userId, String(uid));
    const pro = await billing.stripeCheckout(db, { userId: uid, plan: "yearly", language: "de", frontendUrl: "https://app.test" });
    assert.equal(calls.stripeCheckout[1].line_items[0].price, "price_pro_y");
    assert.deepEqual(pro, { url: "https://checkout.test/x" });
});

test("Max bought on Play ends a running Stripe Pro at the period end", { skip: NO_DB }, async () => {
    const pro = stripeSub("sub_pro_s", "price_pro_m");
    billing._deps.stripe.__serve(pro);
    await webhook("customer.subscription.created", pro);
    billing._deps.playAnswers.set("tok_max_000002", playPurchase("quidey_max"));
    await billing.savePlayPurchase(db, "tok_max_000002", uid);
    assert.deepEqual(calls.stripeUpdate, [["sub_pro_s", { cancel_at_period_end: true }]]);
    const p = await row("stripe", "sub_pro_s");
    assert.equal(p.tier, "pro");
    assert.equal(p.cancel_at_period_end, true);
});

test("Max bought on Stripe ends a running Play Pro (renewal cancelled, paid time stays)", { skip: NO_DB }, async () => {
    billing._deps.playAnswers.set("tok_pro_000002", playPurchase("quidey_pro"));
    await billing.savePlayPurchase(db, "tok_pro_000002", uid);
    await webhook("customer.subscription.created", stripeSub("sub_max_s", "price_max_m"));
    assert.ok(calls.play.some(([m, url]) => m === "POST" && url.includes("/subscriptions/quidey_pro/tokens/tok_pro_000002:cancel")));
    // a repeated webhook does not cancel again
    const before = calls.play.length;
    await db.query("UPDATE subscriptions SET cancel_at_period_end = true WHERE provider_id = 'tok_pro_000002'");
    await webhook("customer.subscription.updated", stripeSub("sub_max_s", "price_max_m"));
    assert.equal(calls.play.length, before);
});

test("a replace purchase on Play (Pro to Max) leaves one running Max", { skip: NO_DB }, async () => {
    billing._deps.playAnswers.set("tok_pro_000003", playPurchase("quidey_pro"));
    await billing.savePlayPurchase(db, "tok_pro_000003", uid);
    billing._deps.playAnswers.set("tok_max_000003", playPurchase("quidey_max", { linkedPurchaseToken: "tok_pro_000003" }));
    await billing.savePlayPurchase(db, "tok_max_000003", uid);
    assert.equal((await row("play", "tok_pro_000003")).status, "replaced");
    assert.equal((await row("play", "tok_max_000003")).tier, "max");
    assert.equal(calls.play.filter(([, url]) => url.endsWith(":cancel")).length, 0, "nothing left to cancel");
    assert.ok((await user()).max_until);
});

test("proStatus reports the tier and plan of the current subscription", { skip: NO_DB }, async () => {
    let status = await billing.proStatus(db, uid);
    assert.equal(status.tier, null);
    assert.equal(status.subscription, null);
    await webhook("customer.subscription.created", stripeSub("sub_s1", "price_pro_y"));
    status = await billing.proStatus(db, uid);
    assert.equal(status.tier, "pro");
    assert.equal(status.subscription.tier, "pro");
    assert.equal(status.subscription.plan, "yearly");
    assert.equal(status.maxUntil, null);
    await webhook("customer.subscription.created", stripeSub("sub_s2", "price_max_m"));
    status = await billing.proStatus(db, uid);
    assert.equal(status.tier, "max");
    assert.equal(status.subscription.tier, "max");
    assert.equal(status.subscription.plan, "monthly");
    assert.ok(status.maxUntil);
    assert.equal(status.active, true);
    assert.equal(status.stripeMax, true);
});

test("a stale or retried Pro-era webhook after the upgrade to Max does not downgrade the row", { skip: NO_DB }, async () => {
    const pro = stripeSub("sub_late", "price_pro_m");
    billing._deps.stripe.__serve(pro);
    await webhook("customer.subscription.created", pro);
    await billing.stripeCheckout(db, { userId: uid, tier: "max", plan: "yearly", language: "en", frontendUrl: "https://app.test" });
    assert.equal((await row("stripe", "sub_late")).tier, "max");
    // Stripe delivers the old created / updated events (payload: still the Pro price) late
    await webhook("customer.subscription.updated", stripeSub("sub_late", "price_pro_m"));
    await webhook("customer.subscription.created", pro);
    const saved = await row("stripe", "sub_late");
    assert.equal(saved.tier, "max");
    assert.equal(saved.plan, "yearly");
    assert.ok((await user()).max_until);
});
