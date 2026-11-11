// Who may do what, from a users row (needs is_pro, pro_until, is_tester, is_admin).
//
// ACCESS_MODE (env): 'beta' (default) or 'open'.
//   beta  the closed beta: testers (beta access given by an admin), Pro (paid, or given as a gift)
//         and admins get in; admins always, so they can't lock themselves out of the admin panel.
//         Taking tester away takes the access away.
//   open  after the beta: everybody gets in. Without Pro, tester or admin the free plan's limits
//         apply (utils/limits.js).
// Pro = users.is_pro (a gift: admin panel / CLI) or a subscription that runs (users.pro_until
// ahead, kept by utils/billing.js). Pro never sees what is in test: that is for testers only.
const ACCESS_MODE = process.env.ACCESS_MODE === "open" ? "open" : "beta";

// PRO_BILLING (env): 'on' sells Quidey Pro (Stripe / Google Play, utils/billing.js); anything else
// (the default) keeps it switched off: the routes that show or sell it answer 404 BILLING_OFF and
// the free plan has no limits (there would be nothing to lift them with). Gifted Pro (is_pro) still
// counts. Webhooks and the cancel button stay on, so a subscription that exists is never stuck.
// The frontend has its own switch for what it shows (VITE_PRO=on); turn both on together.
const PRO_BILLING = process.env.PRO_BILLING === "on";

// The routes that sell Pro, while PRO_BILLING is off
const requireProBilling = (req, res, next) => {
    if (PRO_BILLING) return next();
    res.status(404).json({ error: "Quidey Pro isn't available yet", code: "BILLING_OFF" });
};

const hasPro = (account) => Boolean(account.is_pro || (account.pro_until && new Date(account.pro_until) > new Date()));

const hasAppAccess = (account) => ACCESS_MODE === "open" || Boolean(hasPro(account) || account.is_tester || account.is_admin);

// The AI features (utils/ai.js, ai.js, the study estimates, the homework time estimate): Pro (a gift or a
// running subscription) and admins; testers get no AI unless they are Pro too.
const hasAiAccess = (account) => Boolean(account && (hasPro(account) || account.is_admin));

// Features not released to everyone yet: testers, and admins always.
const hasTesterAccess = (account) => Boolean(account.is_tester || account.is_admin);

// No limits: Pro, testers and admins (the free plan only matters in the 'open' mode)
const hasNoLimits = (account) => Boolean(hasPro(account) || account.is_tester || account.is_admin);

// The same as hasPro / hasAppAccess, for SQL on the users table
const PRO_SQL = "(users.is_pro OR users.pro_until > now())";
const APP_ACCESS_SQL = ACCESS_MODE === "open" ? "true" : `(${PRO_SQL} OR users.is_tester OR users.is_admin)`;

// The same as hasTesterAccess, for SQL on the users table
const TESTER_ACCESS_SQL = "(users.is_tester OR users.is_admin)";

module.exports = { ACCESS_MODE, PRO_BILLING, requireProBilling, hasPro, hasAiAccess, hasAppAccess, hasTesterAccess, hasNoLimits, PRO_SQL, APP_ACCESS_SQL, TESTER_ACCESS_SQL };
