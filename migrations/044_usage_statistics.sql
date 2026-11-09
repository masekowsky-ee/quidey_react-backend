-- 044: usage statistics, only with consent.
-- Adds the person's consent (users.usage_consent: granted / denied, NULL = not asked yet, with the time
-- and the version of the text they saw) and three tables for anonymous usage totals: usage_hourly
-- (counts per hour and dimension, no user id, this is what stays), usage_seen (short-lived marks so
-- people are counted once, deleted when their period is over, cascades with the user) and usage_people
-- (distinct people per day / week). The index on usage_seen (user_id) makes withdrawing consent cheap.
-- Safe to run again (IF NOT EXISTS; migrate.sh runs it in one transaction).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS usage_consent text CHECK (usage_consent IN ('granted', 'denied')),  -- NULL = not asked yet
  ADD COLUMN IF NOT EXISTS usage_consent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS usage_consent_version smallint;

-- the only analytics data that stays: totals, no user id
CREATE TABLE IF NOT EXISTS public.usage_hourly (
  hour        timestamp with time zone NOT NULL,   -- UTC, truncated to the hour
  local_hour  smallint    NOT NULL CHECK (local_hour BETWEEN 0 AND 23),   -- in the person's timezone
  weekday     smallint    NOT NULL CHECK (weekday BETWEEN 1 AND 7),       -- ISO, 1 = Monday, local
  metric      text        NOT NULL CHECK (metric ~ '^[a-z0-9_:]{1,48}$'),
  platform    text        NOT NULL CHECK (platform IN ('web', 'pwa', 'android')),
  language    text        NOT NULL CHECK (language IN ('de', 'en')),
  plan        text        NOT NULL CHECK (plan IN ('free', 'tester', 'pro')),
  events      integer     NOT NULL DEFAULT 0,
  people      integer     NOT NULL DEFAULT 0,  -- distinct people in this hour for this row's dimensions
  value_sum   bigint      NOT NULL DEFAULT 0,  -- e.g. focus seconds, active minutes
  PRIMARY KEY (hour, local_hour, weekday, metric, platform, language, plan)
);
CREATE INDEX IF NOT EXISTS usage_hourly_hour_idx ON public.usage_hourly USING btree (hour);

-- short-lived "already counted" marks so people are distinct; deleted when their period is over
CREATE TABLE IF NOT EXISTS public.usage_seen (
  scope     text        NOT NULL CHECK (scope IN ('hour', 'day', 'week')),
  period    timestamp with time zone NOT NULL,   -- start of the hour / local day / ISO week
  metric    text        NOT NULL,   -- '*' = "active at all"
  user_id   integer     NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  PRIMARY KEY (scope, period, metric, user_id)
);
CREATE INDEX IF NOT EXISTS usage_seen_user_idx ON public.usage_seen USING btree (user_id);

-- distinct people per day and week (across all hours), also totals only
CREATE TABLE IF NOT EXISTS public.usage_people (
  scope    text        NOT NULL CHECK (scope IN ('day', 'week')),
  period   date        NOT NULL,
  metric   text        NOT NULL,
  platform text        NOT NULL,
  language text        NOT NULL,
  plan     text        NOT NULL,
  people   integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period, metric, platform, language, plan)
);
