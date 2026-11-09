-- 041: study goals (subjects, goals with parts, study windows, planned sessions), push kind "study".
-- Already part of schema.sql. Run this only on a database created before it.
--
--   subjects               a user's subjects (name, emoji, colour, archived).
--   goals                  kind exam / assignment / presentation / other, due date (+ time), plan_mode
--                          slots or days, status active / done / archived; behind_notified_*: the last
--                          "behind" push; freed_minutes: minutes of sessions dropped because a part got
--                          ahead (reset to 0 when a plan is applied).
--   goal_parts             the steps of a goal: estimate (15-1200 min) and where it came from, role part
--                          or review, done_at, actual_minutes (the credit when it was finished).
--   study_windows          when the user studies: weekday 1-7 (1 = Monday), start_time < end_time;
--                          several per weekday are allowed.
--   tasks                  goal_part_id: marks a planned session (the part going away keeps the task);
--                          plan_pinned: the user changed it, the planner keeps it.
--   users                  study_session_minutes (15-180), study_daily_max_minutes (15-720),
--                          study_ai_auto (estimate with AI without asking).
--   push_subscriptions     study: reminders about study sessions (on for every device).

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.subjects (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    emoji text,
    color text,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT subjects_color_check
        CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'))
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_user_name ON public.subjects (user_id, lower(name));

CREATE TABLE IF NOT EXISTS public.goals (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    subject_id integer NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    kind text NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    due date NOT NULL,
    due_time time without time zone,
    plan_mode text NOT NULL DEFAULT 'slots',
    status text NOT NULL DEFAULT 'active',
    behind_notified_minutes integer NOT NULL DEFAULT 0,
    behind_notified_on date,
    freed_minutes integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT goals_kind_check CHECK (kind IN ('exam', 'assignment', 'presentation', 'other')),
    CONSTRAINT goals_plan_mode_check CHECK (plan_mode IN ('slots', 'days')),
    CONSTRAINT goals_status_check CHECK (status IN ('active', 'done', 'archived'))
);
CREATE INDEX IF NOT EXISTS goals_user_status ON public.goals (user_id, status);

CREATE TABLE IF NOT EXISTS public.goal_parts (
    id serial PRIMARY KEY,
    goal_id integer NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    position integer NOT NULL DEFAULT 0,
    estimate_minutes integer NOT NULL,
    estimate_source text NOT NULL DEFAULT 'default',
    role text NOT NULL DEFAULT 'part',
    done_at timestamp with time zone,
    actual_minutes integer,
    CONSTRAINT goal_parts_estimate_check CHECK (estimate_minutes BETWEEN 15 AND 1200),
    CONSTRAINT goal_parts_source_check CHECK (estimate_source IN ('history', 'pages', 'ai', 'default', 'manual')),
    CONSTRAINT goal_parts_role_check CHECK (role IN ('part', 'review'))
);
CREATE INDEX IF NOT EXISTS goal_parts_goal ON public.goal_parts (goal_id);

CREATE TABLE IF NOT EXISTS public.study_windows (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    weekday smallint NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    CONSTRAINT study_windows_weekday_check CHECK (weekday BETWEEN 1 AND 7),
    CONSTRAINT study_windows_time_check CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS study_windows_user ON public.study_windows (user_id);

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS goal_part_id integer REFERENCES public.goal_parts(id) ON DELETE SET NULL;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS plan_pinned boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS tasks_goal_part ON public.tasks (goal_part_id) WHERE goal_part_id IS NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS study_session_minutes integer NOT NULL DEFAULT 45;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS study_daily_max_minutes integer NOT NULL DEFAULT 180;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS study_ai_auto boolean NOT NULL DEFAULT false;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_study_session_minutes_check;
ALTER TABLE public.users ADD CONSTRAINT users_study_session_minutes_check CHECK (study_session_minutes BETWEEN 15 AND 180);
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_study_daily_max_minutes_check;
ALTER TABLE public.users ADD CONSTRAINT users_study_daily_max_minutes_check CHECK (study_daily_max_minutes BETWEEN 15 AND 720);

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS study boolean NOT NULL DEFAULT true;
