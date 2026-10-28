-- 032: the Fokusraum's alarm, routines and the notebook.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   focus_alarms     one per account: when the running countdown / Pomodoro phase ends. The app
--                    sets it on start and takes it away on pause or stop; the server pushes "time's
--                    up" then, so a phone that is off hears about it (it runs no JavaScript).
--   routines         my routines: a name, an emoji and steps [{ title, minutes }] the app guides me
--                    through one after the other. Planned on weekdays (days: 1 = Monday … 7 =
--                    Sunday) at a time of day (at_time, optional); reminded_on = the day the push
--                    reminder went out (once per day).
--   routine_runs     each time a routine was gone through: when, how many steps of how many, how long
--   notebook_notes   notes in the Fokusraum, on their own or about a task: title, text (lines
--                    starting with "- [ ]" are a checklist), pinned, and attachments: links
--                    { kind: 'link', url, title } and small pasted pictures { kind: 'image', data, name }
--                    (a data: URL, made small by the app). Everything goes with the account.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.focus_alarms (
    user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    fire_at timestamp with time zone NOT NULL,
    phase text NOT NULL CHECK (phase IN ('timer', 'focus', 'short', 'long'))
);
CREATE INDEX IF NOT EXISTS focus_alarms_fire_at ON public.focus_alarms (fire_at);

CREATE TABLE IF NOT EXISTS public.routines (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL,
    emoji text,
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    days smallint[] NOT NULL DEFAULT '{}'::smallint[],
    at_time time without time zone,
    remind boolean NOT NULL DEFAULT true,
    reminded_on date,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routines_user_id ON public.routines (user_id);

CREATE TABLE IF NOT EXISTS public.routine_runs (
    id serial PRIMARY KEY,
    routine_id integer NOT NULL REFERENCES public.routines(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL DEFAULT now(),
    steps_done smallint NOT NULL,
    steps_total smallint NOT NULL,
    seconds integer NOT NULL
);
CREATE INDEX IF NOT EXISTS routine_runs_user_finished ON public.routine_runs (user_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS public.notebook_notes (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    task_id integer REFERENCES public.tasks(id) ON DELETE SET NULL,
    title text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    pinned boolean NOT NULL DEFAULT false,
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notebook_notes_user_updated ON public.notebook_notes (user_id, updated_at DESC);
