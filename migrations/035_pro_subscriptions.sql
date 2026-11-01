-- 035: Quidey Pro, the subscription that supports the development (2,99 € a month or 25 € a year),
-- paid through Stripe (web) or Google Play (Android app). See utils/billing.js.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   subscriptions          one row per subscription at Stripe (provider_id = its sub_… id) or
--                          Google Play (provider_id = the purchase token): plan, status, the end of
--                          the period paid for, and whether it ends there (cancelled).
--   users.pro_until        the latest end of a running subscription of the account (kept by
--                          utils/billing.js after every change): Pro while it lies ahead.
--   users.stripe_customer_id  the account's customer at Stripe (made at the first checkout)
--
-- Access from now on: beta access given by an admin makes a TESTER (sees what is in test), Pro is
-- what somebody pays for (or is given as a gift: users.is_pro). Until now there was nothing to pay,
-- so everybody with is_pro got it as beta access: they become testers.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS subscriptions (
    id serial PRIMARY KEY,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    provider text NOT NULL,
    provider_id text NOT NULL,
    plan text NOT NULL,
    status text NOT NULL,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_provider_check CHECK (provider IN ('stripe', 'play')),
    CONSTRAINT subscriptions_plan_check CHECK (plan IN ('monthly', 'yearly')),
    CONSTRAINT subscriptions_provider_id_check CHECK (char_length(provider_id) BETWEEN 1 AND 1000),
    CONSTRAINT subscriptions_status_check CHECK (char_length(status) BETWEEN 1 AND 40),
    CONSTRAINT subscriptions_provider_key UNIQUE (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until timestamp with time zone;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_key ON users (stripe_customer_id);

UPDATE users SET is_tester = true, is_pro = false WHERE is_pro;
