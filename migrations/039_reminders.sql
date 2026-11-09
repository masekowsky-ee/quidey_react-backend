-- 039: reminders (testers only for now): a text and a time, no task. Once (at) or on weekdays
-- (days, 1 = Monday) at at_time in the owner's time zone. Pushed at their time (utils/focus.js);
-- the Android app rings them itself as an alarm clock.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   reminders            snoozed_until: "10 min später" (rings then instead); done_at: a once
--                        reminder was confirmed (weekly ones never end); fired_for: the time
--                        last pushed for, so each time goes out once.
--   push_subscriptions   alarms: this device (the Android app) rings reminders itself, the
--                        server pushes none of them to it.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.reminders (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
    at timestamp with time zone,
    days smallint[],
    at_time time without time zone,
    snoozed_until timestamp with time zone,
    done_at timestamp with time zone,
    fired_for timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT reminders_once_or_weekly CHECK (
        (at IS NOT NULL AND days IS NULL AND at_time IS NULL)
        OR (at IS NULL AND at_time IS NOT NULL AND cardinality(days) BETWEEN 1 AND 7)
    )
);
CREATE INDEX IF NOT EXISTS reminders_user ON public.reminders (user_id);
CREATE INDEX IF NOT EXISTS reminders_open ON public.reminders (user_id) WHERE done_at IS NULL;

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS alarms boolean NOT NULL DEFAULT false;
