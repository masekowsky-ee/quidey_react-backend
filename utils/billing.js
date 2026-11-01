// Quidey Pro: the subscription that supports the development, 2,99 € a month or 25 € a year.
// Two ways to pay, one Pro:
//
//   Stripe (web app)   Checkout for the first payment, the customer portal to change or cancel,
//                      a webhook that reports every change (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//                      STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY: the two prices of one product).
//   Google Play (app)  the app buys through Google Play Billing and hands the purchase token over;
//                      the server checks it with the Play Developer API, acknowledges it and keeps
//                      it up to date from Google's real-time notifications (Pub/Sub push).
//                      PLAY_PACKAGE_NAME (com.quidey.app), PLAY_SERVICE_ACCOUNT_FILE (JSON key of a
//                      service account with access to the Play Console's financial data),
//                      PLAY_RTDN_TOKEN (a secret in the push subscription's URL). Product
//                      PLAY_PRODUCT_ID (quidey_pro) with the base plans "monthly" and "yearly".
//
// Every change ends in refreshProUntil: users.pro_until = the latest end of a subscription that
// still runs (also when cancelled: paid is paid). Without the settings a way is simply off
// (the app then doesn't offer it).

const { readFileSync } = require("node:fs");
const crypto = require("node:crypto");
const { JWT } = require("google-auth-library");

const PLANS = ["monthly", "yearly"];
// statuses that still give Pro until the period's end (past_due / grace: Stripe / Google retry the payment)
const RUNNING = ["active", "trialing", "past_due", "canceled_pending", "grace", "on_hold_grace"];

// ---------- Stripe ----------
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICES = { monthly: process.env.STRIPE_PRICE_MONTHLY || "", yearly: process.env.STRIPE_PRICE_YEARLY || "" };
const STRIPE_ENABLED = Boolean(STRIPE_KEY && STRIPE_PRICES.monthly && STRIPE_PRICES.yearly && process.env.STRIPE_WEBHOOK_SECRET);
const stripe = STRIPE_KEY ? new (require("stripe"))(STRIPE_KEY) : null;
const planOfPrice = (priceId) => PLANS.find((plan) => STRIPE_PRICES[plan] === priceId) ?? null;

// ---------- Google Play ----------
const PLAY_PACKAGE = process.env.PLAY_PACKAGE_NAME || "com.quidey.app";
const PLAY_PRODUCT = process.env.PLAY_PRODUCT_ID || "quidey_pro";
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

async function playRequest(method, url) {
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

// ---------- the account's Pro ----------

// users.pro_until from the account's running subscriptions (null when none)
async function refreshProUntil(db, userId) {
    if (!userId) return;
    await db.query(
        `UPDATE users SET pro_until = (
            SELECT max(current_period_end) FROM subscriptions
            WHERE user_id = $1 AND status = ANY($2::text[]) AND current_period_end > now()
        ) WHERE id = $1`,
        [userId, RUNNING]
    );
}

async function saveSubscription(db, { userId, provider, providerId, plan, status, periodEnd, cancelAtPeriodEnd }) {
    const saved = await db.query(
        `INSERT INTO subscriptions (user_id, provider, provider_id, plan, status, current_period_end, cancel_at_period_end)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, provider_id) DO UPDATE SET
            user_id = COALESCE(subscriptions.user_id, EXCLUDED.user_id), plan = EXCLUDED.plan, status = EXCLUDED.status,
            current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now()
        RETURNING user_id`,
        [userId ?? null, provider, providerId, plan, status, periodEnd, cancelAtPeriodEnd]
    );
    const owner = saved.rows[0]?.user_id;
    await refreshProUntil(db, owner);
    return owner;
}

// What the app shows: { active, gift, until, subscription: { provider, plan, status, periodEnd,
// cancelAtPeriodEnd } | null, stripe, play } (stripe / play: whether that way is open)
async function proStatus(db, userId) {
    const user = (await db.query("SELECT is_pro, pro_until, stripe_customer_id FROM users WHERE id = $1", [userId])).rows[0];
    const sub = (await db.query(
        `SELECT provider, plan, status, current_period_end, cancel_at_period_end FROM subscriptions
        WHERE user_id = $1 ORDER BY (status = ANY($2::text[]) AND current_period_end > now()) DESC, current_period_end DESC NULLS LAST LIMIT 1`,
        [userId, RUNNING]
    )).rows[0];
    return {
        active: Boolean(user?.is_pro || (user?.pro_until && new Date(user.pro_until) > new Date())),
        gift: Boolean(user?.is_pro),
        until: user?.pro_until ?? null,
        subscription: sub ? {
            provider: sub.provider, plan: sub.plan, status: sub.status,
            periodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end,
        } : null,
        canManageStripe: Boolean(STRIPE_ENABLED && user?.stripe_customer_id),
        stripe: STRIPE_ENABLED,
        play: PLAY_ENABLED,
    };
}

// ---------- Stripe: checkout, portal, webhook ----------

async function stripeCheckout(db, { userId, plan, language, frontendUrl }) {
    const user = (await db.query("SELECT email, stripe_customer_id FROM users WHERE id = $1", [userId])).rows[0];
    let customer = user.stripe_customer_id;
    if (!customer) {
        customer = (await stripe.customers.create({ email: user.email, metadata: { userId: String(userId) } })).id;
        await db.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customer, userId]);
    }
    const en = language === "en";
    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        client_reference_id: String(userId),
        line_items: [{ price: STRIPE_PRICES[plan], quantity: 1 }],
        subscription_data: { metadata: { userId: String(userId) } },
        locale: en ? "en" : "de",
        success_url: `${frontendUrl}/pro?checkout=done`,
        cancel_url: `${frontendUrl}/pro?checkout=cancelled`,
        custom_text: {
            submit: {
                message: en
                    ? "Quidey Pro supports the development. It renews automatically until you cancel; you can cancel at any time to the end of the period. No VAT is charged (small business, § 19 UStG)."
                    : "Quidey Pro unterstützt die Entwicklung. Es verlängert sich automatisch, bis du kündigst; kündigen kannst du jederzeit zum Ende des Zeitraums. Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
            },
        },
    });
    return session.url;
}

async function stripePortal(db, { userId, frontendUrl }) {
    const user = (await db.query("SELECT stripe_customer_id FROM users WHERE id = $1", [userId])).rows[0];
    if (!user?.stripe_customer_id) return null;
    const session = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${frontendUrl}/pro` });
    return session.url;
}

// A Stripe subscription as a row: the period's end sits on its item in newer API versions
async function saveStripeSubscription(db, sub) {
    const item = sub.items?.data?.[0];
    const plan = planOfPrice(item?.price?.id);
    if (!plan) return null;
    let userId = Number(sub.metadata?.userId) || null;
    if (!userId && sub.customer) {
        userId = (await db.query("SELECT id FROM users WHERE stripe_customer_id = $1", [String(sub.customer)])).rows[0]?.id ?? null;
    }
    const periodEnd = item?.current_period_end ?? sub.current_period_end;
    return saveSubscription(db, {
        userId,
        provider: "stripe",
        providerId: sub.id,
        plan,
        status: sub.status,
        periodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    });
}

// The webhook: (raw body, signature header) → the user whose Pro changed (or null)
async function stripeWebhook(db, rawBody, signature) {
    const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type.startsWith("customer.subscription.")) return saveStripeSubscription(db, event.data.object);
    if (event.type === "checkout.session.completed" && event.data.object.subscription) {
        const sub = await stripe.subscriptions.retrieve(String(event.data.object.subscription));
        return saveStripeSubscription(db, sub);
    }
    return null;
}

// Cancel at the end of the period (the cancel button, § 312k BGB): the account's running Stripe
// subscriptions. Answers how many there were.
async function stripeCancelAtPeriodEnd(db, userId) {
    if (!stripe) return 0;
    const subs = (await db.query(
        "SELECT provider_id FROM subscriptions WHERE user_id = $1 AND provider = 'stripe' AND status = ANY($2::text[])",
        [userId, RUNNING]
    )).rows;
    for (const { provider_id: id } of subs) {
        await saveStripeSubscription(db, await stripe.subscriptions.update(id, { cancel_at_period_end: true }));
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
    const line = (purchase.lineItems ?? []).find((item) => item.productId === PLAY_PRODUCT);
    if (!line) throw Object.assign(new Error("Not a Quidey Pro purchase"), { status: 400 });
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
        status: playStatus(purchase.subscriptionState),
        periodEnd: line.expiryTime ? new Date(line.expiryTime) : null,
        cancelAtPeriodEnd: line.autoRenewingPlan ? line.autoRenewingPlan.autoRenewEnabled === false : true,
    });
    // a purchase that isn't acknowledged within 3 days is refunded by Google
    if (purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && ["active", "grace"].includes(playStatus(purchase.subscriptionState))) {
        await playRequest("POST", `${PLAY_API}/subscriptions/${encodeURIComponent(PLAY_PRODUCT)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`);
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
        "SELECT provider, provider_id FROM subscriptions WHERE user_id = $1 AND status = ANY($2::text[])",
        [userId, RUNNING]
    )).rows;
    for (const sub of subs) {
        try {
            if (sub.provider === "stripe" && stripe) await stripe.subscriptions.cancel(sub.provider_id);
            if (sub.provider === "play" && PLAY_ENABLED) {
                await playRequest("POST", `${PLAY_API}/subscriptions/${encodeURIComponent(PLAY_PRODUCT)}/tokens/${encodeURIComponent(sub.provider_id)}:cancel`);
            }
        } catch (err) {
            console.error(`Cancelling subscription (${sub.provider}) of user ${userId} failed:`, err.message);
        }
    }
}

module.exports = {
    PLANS, STRIPE_ENABLED, PLAY_ENABLED, PLAY_PRODUCT,
    proStatus, refreshProUntil, saveSubscription,
    stripeCheckout, stripePortal, stripeWebhook, stripeCancelAtPeriodEnd,
    savePlayPurchase, playAccountId, playNotification, cancelAllSubscriptions,
};
