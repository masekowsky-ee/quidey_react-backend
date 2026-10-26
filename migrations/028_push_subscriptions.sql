-- 028: push notifications on the phone / desktop (Web Push, the app's settings → App).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   push_subscriptions   one row per device (browser) that turned notifications on: the push
--                        service's address (endpoint) and the keys the message is encrypted with.
--                        Which kinds the device wants: plan (my tasks and events at their time:
--                        at the reminder if one is set, else when they start), digest (the
--                        morning overview of the day), messages (direct messages), social
--                        (friend requests, invites, shared and assigned tasks, news from the team).
--                        An endpoint belongs to the account signed in on that device last; it goes
--                        when the device turns it off, signs out, or the push service says it's gone.
--   tasks.push_sent_for  the time a task was pushed for (its reminder or its start), so it is
--                        pushed once, and again after moving it
--   users.push_digest_on the day the morning overview was pushed

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    plan boolean DEFAULT true NOT NULL,
    digest boolean DEFAULT true NOT NULL,
    messages boolean DEFAULT true NOT NULL,
    social boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_subscriptions_endpoint_check CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1000),
    CONSTRAINT push_subscriptions_keys_check CHECK (char_length(p256dh) BETWEEN 1 AND 200 AND char_length(auth) BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS push_sent_for timestamp with time zone;
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_digest_on date;
