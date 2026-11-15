// Quidey Pro (2,99 € a month or 25 € a year) and Quidey Max (5,99 € / 49 €, a superset of Pro):
// the subscriptions that support the development. Two ways to pay:
//
//   Stripe (web app)   Checkout for the first payment, the customer portal to change or cancel,
//                      a webhook that reports every change (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//                      STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY: the two prices of Pro; Max sells
//                      only with STRIPE_PRICE_MAX_MONTHLY and STRIPE_PRICE_MAX_YEARLY too).
//   Google Play (app)  the app buys through Google Play Billing and hands the purchase token over;
//                      the server checks it with the Play Developer API, acknowledges it and keeps
//                      it up to date from Google's real-time notifications (Pub/Sub push).
//                      PLAY_PACKAGE_NAME (com.quidey.app), PLAY_SERVICE_ACCOUNT_FILE (JSON key of a
//                      service account with access to the Play Console's financial data),
//                      PLAY_RTDN_TOKEN (a secret in the push subscription's URL). Product
//                      PLAY_PRODUCT_ID (quidey_pro) and PLAY_PRODUCT_ID_MAX (quidey_max), each with the
//                      base plans "monthly" and "yearly".
//
// Every change ends in refreshProUntil: users.pro_until = the latest end of a subscription that
// still runs (also when cancelled: paid is paid). Without the settings a way is simply off
// (the app then doesn't offer it).

const { readFileSync } = require("node:fs");
const crypto = require("node:crypto");
const { JWT } = require("google-auth-library");

const PLANS = ["monthly", "yearly"];
const TIERS = ["pro", "max"];
// statuses that still give Pro until the period's end (past_due / grace: Stripe / Google retry the payment)
const RUNNING = ["active", "trialing", "past_due", "canceled_pending", "grace", "on_hold_grace"];
// a running Stripe Pro in one of these is bought up to Max in place; one in any other running status
// (past_due: an open invoice Stripe is still retrying) blocks Max at Stripe, since a new Checkout
// would start a second subscription beside it (PAYMENT_PAST_DUE)
const UPGRADES_IN_PLACE = ["active", "trialing"];
const BLOCKS_MAX = RUNNING.filter((status) => !UPGRADES_IN_PLACE.includes(status));

// ---------- Stripe ----------
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICES = {
    pro: { monthly: process.env.STRIPE_PRICE_MONTHLY || "", yearly: process.env.STRIPE_PRICE_YEARLY || "" },
    max: { monthly: process.env.STRIPE_PRICE_MAX_MONTHLY || "", yearly: process.env.STRIPE_PRICE_MAX_YEARLY || "" },
};
// Pro only installations keep working: Max needs its own two prices
const STRIPE_ENABLED = Boolean(STRIPE_KEY && STRIPE_PRICES.pro.monthly && STRIPE_PRICES.pro.yearly && process.env.STRIPE_WEBHOOK_SECRET);
const STRIPE_MAX_ENABLED = Boolean(STRIPE_ENABLED && STRIPE_PRICES.max.monthly && STRIPE_PRICES.max.yearly);
// the clients a test replaces (no real payment in tests)
const deps = { stripe: STRIPE_KEY ? new (require("stripe"))(STRIPE_KEY) : null, playRequest: null };
// a Stripe price id -> { tier, plan } (null when it is none of ours)
function planOfPrice(priceId) {
    if (!priceId) return null;
    for (const tier of TIERS) {
        const plan = PLANS.find((p) => STRIPE_PRICES[tier][p] === priceId);
        if (plan) return { tier, plan };
    }
    return null;
}

// ---------- Google Play ----------
const PLAY_PACKAGE = process.env.PLAY_PACKAGE_NAME || "com.quidey.app";
const PLAY_PRODUCT = process.env.PLAY_PRODUCT_ID || "quidey_pro";
const PLAY_PRODUCT_MAX = process.env.PLAY_PRODUCT_ID_MAX || "quidey_max";
const PLAY_PRODUCTS = { pro: PLAY_PRODUCT, max: PLAY_PRODUCT_MAX };
const tierOfPlayProduct = (productId) => TIERS.find((tier) => PLAY_PRODUCTS[tier] === productId) ?? null;
let playAccount = null;
if (process.env.PLAY_SERVICE_ACCOUNT_FILE) {
    try {
        playAccount = JSON.parse(readFileSync(process.env.PLAY_SERVICE_ACCOUNT_FILE, "utf8"));
    } catch (err) {
        console.error(`PLAY_SERVICE_ACCOUNT_FILE can't be read (${err.message}): no purchases in the Android app.`);
    }
}
const PLAY_ENABLED = Boolean(playAccount?.client_email && playAccount?.private_key);
const playClient = PLAY_ENABLED
    ? new JWT({ email: playAccount.client_email, key: playAccount.private_key, scopes: ["https://www.googleapis.com/auth/androidpublisher"] })
    : null;
const PLAY_API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PLAY_PACKAGE)}/purchases`;

async function realPlayRequest(method, url) {
    const { token } = await playClient.getAccessToken();
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(body?.error?.message || `Google Play answered ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return body;
}

deps.playRequest = realPlayRequest;
const playRequest = (method, url) => deps.playRequest(method, url);

// ---------- the account's Pro ----------

// users.pro_until from the account's running subscriptions (null when none; Max counts for Pro too),
// users.max_until from the running Max ones
async function refreshProUntil(db, userId) {
    if (!userId) return;
    await db.query(
        `UPDATE users SET pro_until = (
            SELECT max(current_period_end) FROM subscriptions
            WHERE user_id = $1 AND status = ANY($2::text[]) AND current_period_end > now()
        ), max_until = (
            SELECT max(current_period_end) FROM subscriptions
            WHERE user_id = $1 AND tier = 'max' AND status = ANY($2::text[]) AND current_period_end > now()
        ) WHERE id = $1`,
        [userId, RUNNING]
    );
}

// tier: 'pro' | 'max', always given by the caller: the upsert overwrites the row's tier, so a call
// that left it out would turn a Max subscription into Pro
async function saveSubscription(db, { userId, provider, providerId, plan, tier, status, periodEnd, cancelAtPeriodEnd }) {
    if (!TIERS.includes(tier)) throw new Error(`saveSubscription needs a tier (pro | max), got ${tier}`);
    const saved = await db.query(
        `INSERT INTO subscriptions (user_id, provider, provider_id, plan, tier, status, current_period_end, cancel_at_period_end)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (provider, provider_id) DO UPDATE SET
            user_id = COALESCE(subscriptions.user_id, EXCLUDED.user_id), plan = EXCLUDED.plan, tier = EXCLUDED.tier, status = EXCLUDED.status,
            current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now()
        RETURNING user_id`,
        [userId ?? null, provider, providerId, plan, tier, status, periodEnd, cancelAtPeriodEnd]
    );
    const owner = saved.rows[0]?.user_id;
    await refreshProUntil(db, owner);
    return owner;
}

// Whether the account has a running Stripe Pro whose payment is overdue (or in another running status
// the in-place upgrade doesn't take): Max can't be bought at Stripe until it is settled in the portal
async function stripeProPastDue(db, userId) {
    const { rows } = await db.query(
        `SELECT 1 FROM subscriptions WHERE user_id = $1 AND provider = 'stripe' AND tier = 'pro'
            AND status = ANY($2::text[]) AND current_period_end > now() LIMIT 1`,
        [userId, BLOCKS_MAX]
    );
    return rows.length > 0;
}

// What the app shows: { active, gift, until, tier: 'max' | 'pro' | null, maxUntil, subscription: {
// provider, tier, plan, status, periodEnd, cancelAtPeriodEnd } | null, paymentPastDue, stripe, stripeMax, play }
// (stripe / stripeMax / play: whether that way is open; paymentPastDue: a running Stripe Pro waits for a
// payment, so the web offers no Max upgrade until it is settled, see stripeProPastDue)
async function proStatus(db, userId) {
    const user = (await db.query("SELECT is_pro, pro_until, is_max, max_until, stripe_customer_id FROM users WHERE id = $1", [userId])).rows[0];
    const sub = (await db.query(
        `SELECT provider, tier, plan, status, current_period_end, cancel_at_period_end FROM subscriptions
        WHERE user_id = $1 ORDER BY (status = ANY($2::text[]) AND current_period_end > now()) DESC, (tier = 'max') DESC, current_period_end DESC NULLS LAST LIMIT 1`,
        [userId, RUNNING]
    )).rows[0];
    const maxActive = Boolean(user?.is_max || (user?.max_until && new Date(user.max_until) > new Date()));
    const proActive = maxActive || Boolean(user?.is_pro || (user?.pro_until && new Date(user.pro_until) > new Date()));
    return {
        active: proActive,
        gift: Boolean(user?.is_pro || user?.is_max),
        until: user?.pro_until ?? null,
        tier: maxActive ? "max" : proActive ? "pro" : null,
        maxUntil: user?.max_until ?? null,
        subscription: sub ? {
            provider: sub.provider, tier: sub.tier, plan: sub.plan, status: sub.status,
            periodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end,
        } : null,
        paymentPastDue: await stripeProPastDue(db, userId),
        canManageStripe: Boolean(STRIPE_ENABLED && user?.stripe_customer_id),
        stripe: STRIPE_ENABLED,
        stripeMax: STRIPE_MAX_ENABLED,
        play: PLAY_ENABLED,
    };
}

// ---------- Stripe: checkout, portal, webhook ----------

// Checkout for a tier and plan. A running Stripe Pro that is bought up to Max is changed in place
// (one subscription, the unused Pro time credited, the difference invoiced now, nothing happens if
// that payment fails): answers { upgraded: true }. Otherwise { url } of a Checkout session.
// A running Stripe Pro in a status the in-place change doesn't take (past_due) is refused with an
// error { status: 409, code: 'PAYMENT_PAST_DUE' } before anything is created at Stripe.
async function stripeCheckout(db, { userId, tier = "pro", plan, language, frontendUrl }) {
    const price = STRIPE_PRICES[tier]?.[plan];
    if (!price) throw new Error(`No Stripe price for ${tier} ${plan}`);
    if (tier === "max") {
        if (await stripeProPastDue(db, userId)) {
            throw Object.assign(new Error("The Pro subscription has an unpaid invoice"), { status: 409, code: "PAYMENT_PAST_DUE" });
        }
        const running = (await db.query(
            "SELECT provider_id FROM subscriptions WHERE user_id = $1 AND provider = 'stripe' AND tier = 'pro' AND status = ANY($2::text[]) AND current_period_end > now() ORDER BY current_period_end DESC LIMIT 1",
            [userId, UPGRADES_IN_PLACE]
        )).rows[0];
        if (running) {
            const sub = await deps.stripe.subscriptions.retrieve(running.provider_id);
            const updated = await deps.stripe.subscriptions.update(running.provider_id, {
                items: [{ id: sub.items.data[0].id, price }],
                proration_behavior: "always_invoice",
                payment_behavior: "error_if_incomplete",
                cancel_at_period_end: false,
            });
            await saveStripeSubscription(db, updated);
            return { upgraded: true };
        }
    }
    const user = (await db.query("SELECT email, stripe_customer_id FROM users WHERE id = $1", [userId])).rows[0];
    let customer = user.stripe_customer_id;
    if (!customer) {
        customer = (await deps.stripe.customers.create({ email: user.email, metadata: { userId: String(userId) } })).id;
        await db.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customer, userId]);
    }
    const en = language === "en";
    const session = await deps.stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        client_reference_id: String(userId),
        line_items: [{ price, quantity: 1 }],
        subscription_data: { metadata: { userId: String(userId) } },
        locale: en ? "en" : "de",
        success_url: `${frontendUrl}/pro?checkout=done`,
        cancel_url: `${frontendUrl}/pro?checkout=cancelled`,
        custom_text: {
            submit: {
                message: en
                    ? `Quidey ${tier === "max" ? "Max" : "Pro"} supports the development. It renews automatically until you cancel; you can cancel at any time to the end of the period. No VAT is charged (small business, § 19 UStG).`
                    : `Quidey ${tier === "max" ? "Max" : "Pro"} unterstützt die Entwicklung. Es verlängert sich automatisch, bis du kündigst; kündigen kannst du jederzeit zum Ende des Zeitraums. Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.`,
            },
        },
    });
    return { url: session.url };
}

async function stripePortal(db, { userId, frontendUrl }) {
    const user = (await db.query("SELECT stripe_customer_id FROM users WHERE id = $1", [userId])).rows[0];
    if (!user?.stripe_customer_id) return null;
    const session = await deps.stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${frontendUrl}/pro` });
    return session.url;
}

// A Stripe subscription as a row: the period's end sits on its item in newer API versions
async function saveStripeSubscription(db, sub) {
    const item = sub.items?.data?.[0];
    const priced = planOfPrice(item?.price?.id);
    if (!priced) return null;
    let userId = Number(sub.metadata?.userId) || null;
    if (!userId && sub.customer) {
        userId = (await db.query("SELECT id FROM users WHERE stripe_customer_id = $1", [String(sub.customer)])).rows[0]?.id ?? null;
    }
    const periodEnd = item?.current_period_end ?? sub.current_period_end;
    const owner = await saveSubscription(db, {
        userId,
        provider: "stripe",
        providerId: sub.id,
        plan: priced.plan,
        tier: priced.tier,
        status: sub.status,
        periodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    });
    if (priced.tier === "max" && RUNNING.includes(sub.status)) await retireOtherPro(db, owner, "stripe", sub.id);
    return owner;
}

// A running Max makes the account's other running Pro subscriptions pointless (Max includes Pro):
// their renewal is cancelled, the time already paid runs out. Never throws: a failure is logged and
// tried again with the next change of the Max subscription.
async function retireOtherPro(db, userId, keepProvider, keepProviderId) {
    if (!userId) return;
    const others = (await db.query(
        `SELECT provider, provider_id FROM subscriptions
        WHERE user_id = $1 AND tier = 'pro' AND status = ANY($2::text[]) AND cancel_at_period_end = false
            AND NOT (provider = $3 AND provider_id = $4)`,
        [userId, RUNNING, keepProvider, keepProviderId]
    )).rows;
    for (const other of others) {
        try {
            if (other.provider === "stripe") {
                // stores the new cancel_at_period_end of that (Pro) subscription
                await saveStripeSubscription(db, await deps.stripe.subscriptions.update(other.provider_id, { cancel_at_period_end: true }));
            } else if (other.provider === "play") {
                await playRequest("POST", `${PLAY_API}/subscriptions/${encodeURIComponent(PLAY_PRODUCT)}/tokens/${encodeURIComponent(other.provider_id)}:cancel`);
                await db.query("UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE provider = 'play' AND provider_id = $1", [other.provider_id]);
            }
        } catch (err) {
            console.error(`Ending the Pro subscription (${other.provider}) of user ${userId} after Max failed:`, err.message);
        }
    }
}

// The webhook: (raw body, signature header) → the user whose Pro changed (or null)
async function stripeWebhook(db, rawBody, signature) {
    const event = deps.stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type.startsWith("customer.subscription.")) {
        // Stripe doesn't keep the order of events and retries old ones for days: the payload may
        // describe the subscription as it was (a Pro price after the upgrade to Max), so the
        // current state is asked for. Only a subscription Stripe no longer knows keeps its payload.
        let current = event.data.object;
        try {
            current = await deps.stripe.subscriptions.retrieve(current.id);
        } catch (err) {
            if (err.code !== "resource_missing") throw err;
        }
        return saveStripeSubscription(db, current ?? event.data.object);
    }
    if (event.type === "checkout.session.completed" && event.data.object.subscription) {
        const sub = await deps.stripe.subscriptions.retrieve(String(event.data.object.subscription));
        return saveStripeSubscription(db, sub);
    }
    return null;
}

// Cancel at the end of the period (the cancel button, § 312k BGB): the account's running Stripe
// subscriptions. Answers how many there were.
async function stripeCancelAtPeriodEnd(db, userId) {
    if (!deps.stripe) return 0;
    const subs = (await db.query(
        "SELECT provider_id FROM subscriptions WHERE user_id = $1 AND provider = 'stripe' AND status = ANY($2::text[])",
        [userId, RUNNING]
    )).rows;
    for (const { provider_id: id } of subs) {
        await saveStripeSubscription(db, await deps.stripe.subscriptions.update(id, { cancel_at_period_end: true }));
    }
    return subs.length;
}

// ---------- Google Play ----------

// subscriptionsv2 → our status
function playStatus(state) {
    switch (state) {
        case "SUBSCRIPTION_STATE_ACTIVE": return "active";
        case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD": return "grace";
        case "SUBSCRIPTION_STATE_CANCELED": return "canceled_pending"; // cancelled, runs to its end
        case "SUBSCRIPTION_STATE_ON_HOLD": return "on_hold";
        case "SUBSCRIPTION_STATE_PAUSED": return "paused";
        case "SUBSCRIPTION_STATE_PENDING": return "pending";
        default: return "expired";
    }
}

// Checks a purchase token with Google and saves it; userId given when the app hands it over
// (then it must have been bought for this account: obfuscatedExternalAccountId), null from a
// notification. Answers the account it belongs to.
async function savePlayPurchase(db, purchaseToken, userId = null) {
    const purchase = await playRequest("GET", `${PLAY_API}/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
    const line = (purchase.lineItems ?? []).find((item) => tierOfPlayProduct(item.productId));
    if (!line) throw Object.assign(new Error("Not a Quidey purchase"), { status: 400 });
    const tier = tierOfPlayProduct(line.productId);
    const plan = line.offerDetails?.basePlanId === "yearly" ? "yearly" : "monthly";
    const boughtFor = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (userId && boughtFor && boughtFor !== playAccountId(userId)) throw Object.assign(new Error("Bought for another account"), { status: 403 });
    // an upgrade / renewal with a new token replaces the old one
    if (purchase.linkedPurchaseToken) {
        await db.query("UPDATE subscriptions SET status = 'replaced', updated_at = now() WHERE provider = 'play' AND provider_id = $1", [purchase.linkedPurchaseToken]);
    }
    const owner = await saveSubscription(db, {
        userId,
        provider: "play",
        providerId: purchaseToken,
        plan,
        tier,
        status: playStatus(purchase.subscriptionState),
        periodEnd: line.expiryTime ? new Date(line.expiryTime) : null,
        cancelAtPeriodEnd: line.autoRenewingPlan ? line.autoRenewingPlan.autoRenewEnabled === false : true,
    });
    if (tier === "max" && RUNNING.includes(playStatus(purchase.subscriptionState))) await retireOtherPro(db, owner, "play", purchaseToken);
    // a purchase that isn't acknowledged within 3 days is refunded by Google
    if (purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && ["active", "grace"].includes(playStatus(purchase.subscriptionState))) {
        await playRequest("POST", `${PLAY_API}/subscriptions/${encodeURIComponent(line.productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`);
    }
    return owner;
}

// The id the app hands to Google Play with a purchase (setObfuscatedAccountId), so a token can
// only be claimed by the account that bought it: a hash of the user id, nothing personal
function playAccountId(userId) {
    return crypto.createHmac("sha256", process.env.JWT_SECRET).update(`play:${userId}`).digest("hex").slice(0, 64);
}

// A real-time developer notification (Pub/Sub push): { message: { data: base64 JSON } }.
// Answers the account whose Pro changed (or null).
async function playNotification(db, body) {
    let data;
    try {
        data = JSON.parse(Buffer.from(body?.message?.data ?? "", "base64").toString("utf8"));
    } catch {
        return null;
    }
    const token = data?.subscriptionNotification?.purchaseToken;
    if (!token || data.packageName !== PLAY_PACKAGE) return null;
    return savePlayPurchase(db, token, null);
}

// Ends the account's subscriptions right away (deleting the account): Stripe at once, Google
// Play's renewal is cancelled (it runs to its paid end, Google refunds nothing by itself)
async function cancelAllSubscriptions(db, userId) {
    const subs = (await db.query(
        "SELECT provider, provider_id, tier FROM subscriptions WHERE user_id = $1 AND status = ANY($2::text[])",
        [userId, RUNNING]
    )).rows;
    for (const sub of subs) {
        try {
            if (sub.provider === "stripe" && deps.stripe) await deps.stripe.subscriptions.cancel(sub.provider_id);
            if (sub.provider === "play" && PLAY_ENABLED) {
                await playRequest("POST", `${PLAY_API}/subscriptions/${encodeURIComponent(PLAY_PRODUCTS[sub.tier] ?? PLAY_PRODUCT)}/tokens/${encodeURIComponent(sub.provider_id)}:cancel`);
            }
        } catch (err) {
            console.error(`Cancelling subscription (${sub.provider}) of user ${userId} failed:`, err.message);
        }
    }
}

module.exports = {
    PLANS, TIERS, STRIPE_ENABLED, STRIPE_MAX_ENABLED, PLAY_ENABLED, PLAY_PRODUCT, PLAY_PRODUCT_MAX,
    planOfPrice, _deps: deps,
    proStatus, refreshProUntil, saveSubscription,
    stripeCheckout, stripePortal, stripeWebhook, stripeCancelAtPeriodEnd,
    savePlayPurchase, playAccountId, playNotification, cancelAllSubscriptions,
};
