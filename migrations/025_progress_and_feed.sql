-- 025: levels, challenges and the feed ("Gemeinschaft").
-- Already part of schema.sql. Run this only on a database created before it.
--
--   users.level            the highest level reached so far (XP itself is never stored: it
--                          follows from focus time, tasks done and challenges, utils/progress.js).
--                          Rising past it is announced once in the feed; unlocks never go away.
--   users.avatar_frame     ring around the avatar (unlocked by level), NULL = none
--   users.profile_title    a title under the name (unlocked by level), NULL = none
--   users.showcase_badges  up to three earned badges pinned to the profile
--   users.share_activity   friends see my focus days, challenges and levels in their feed
--   shared_time_days       team stopwatch time per user and day (in the user's time zone);
--                          shared_session_time only has the total per task
--   challenge_completions  a daily or weekly challenge done, once per period, with its XP
--   feed_events            what friends see in the feed: a day's focus, a challenge, a level,
--                          a streak, or a short post
--   feed_cheers            "cheer on": one per person and feed entry

\set ON_ERROR_STOP on

ALTER TABLE users ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_frame text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_title text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS showcase_badges text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_activity boolean NOT NULL DEFAULT true;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_banner_check;
ALTER TABLE users ADD CONSTRAINT users_banner_check CHECK (banner IS NULL OR banner = ANY (ARRAY[
    'gradient', 'aurora', 'dots', 'stripes', 'grid', 'glow', 'rings', 'topo', 'sky']));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_level_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_level_check CHECK (level >= 1 AND level <= 1000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_frame_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_avatar_frame_check
            CHECK (avatar_frame IS NULL OR avatar_frame = ANY (ARRAY['ring', 'double', 'dotted', 'orbit']));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_profile_title_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_profile_title_check
            CHECK (profile_title IS NULL OR length(profile_title) <= 24);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_showcase_badges_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_showcase_badges_check CHECK (cardinality(showcase_badges) <= 3);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS shared_time_days (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day date NOT NULL,
    time_ms bigint DEFAULT 0 NOT NULL CHECK (time_ms >= 0),
    PRIMARY KEY (user_id, day)
);

-- the time booked so far, on the day of its last report (the best there is)
INSERT INTO shared_time_days (user_id, day, time_ms)
SELECT t.user_id, (t.updated_at AT TIME ZONE COALESCE(u.timezone, 'Europe/Berlin'))::date, sum(t.time_ms)
FROM shared_session_time AS t JOIN users AS u ON u.id = t.user_id
WHERE t.time_ms > 0
GROUP BY 1, 2
ON CONFLICT (user_id, day) DO NOTHING;

CREATE TABLE IF NOT EXISTS challenge_completions (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge text NOT NULL CHECK (length(challenge) <= 40),
    period date NOT NULL,
    xp integer NOT NULL CHECK (xp > 0 AND xp <= 10000),
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, challenge, period)
);

CREATE TABLE IF NOT EXISTS feed_events (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('day', 'challenge', 'level', 'streak', 'post')),
    day date,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feed_events_day_needs_day_check CHECK (kind NOT IN ('day', 'streak') OR day IS NOT NULL)
);

-- one "day" entry and one streak per person and day; the day's entry is updated as it grows
CREATE UNIQUE INDEX IF NOT EXISTS feed_events_one_per_day ON feed_events (user_id, kind, day) WHERE kind IN ('day', 'streak');
CREATE INDEX IF NOT EXISTS feed_events_user_updated ON feed_events (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS feed_cheers (
    event_id integer NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS feed_cheers_user_created ON feed_cheers (user_id, created_at);
