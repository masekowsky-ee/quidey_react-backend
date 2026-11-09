-- 047: the timetable from WebUntis (utils/untis.js, untis.js; branch pro-features).
-- untis_accounts: one per account; secret = the WebUntis password or the iCal link, encrypted
-- (AES-256-GCM, key UNTIS_SECRET). untis_lessons: the fetched lessons in the school's local time.
-- Both go with the account, and disconnecting deletes them.
CREATE TABLE IF NOT EXISTS public.untis_accounts (
    user_id integer NOT NULL PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    mode text NOT NULL,
    server text,
    school text,
    school_label text,
    username text,
    secret text NOT NULL,
    last_sync_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT untis_accounts_mode_check CHECK ((mode = ANY (ARRAY['login'::text, 'ical'::text])))
);

CREATE TABLE IF NOT EXISTS public.untis_lessons (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    external_id text NOT NULL,
    day date NOT NULL,
    start_min integer NOT NULL,
    end_min integer NOT NULL,
    subject text NOT NULL,
    subject_long text DEFAULT ''::text NOT NULL,
    room text DEFAULT ''::text NOT NULL,
    class_name text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'normal'::text NOT NULL,
    info text DEFAULT ''::text NOT NULL,
    CONSTRAINT untis_lessons_status_check CHECK ((status = ANY (ARRAY['normal'::text, 'cancelled'::text, 'irregular'::text]))),
    CONSTRAINT untis_lessons_times_check CHECK (((start_min >= 0) AND (end_min <= 1440) AND (start_min < end_min)))
);

CREATE INDEX IF NOT EXISTS untis_lessons_user_day ON public.untis_lessons (user_id, day);
