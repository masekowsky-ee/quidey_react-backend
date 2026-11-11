-- 051: Lernen as school life (branch pro-features): grades on goals, the account's grade scale,
-- Untis subjects / exams / homework suggestions. Grades are stored as points 0-15 (marks 1-6 are
-- converted: points = 17 - 3 * mark), so an average is one mean.
ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS grade numeric(4,2);
ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS graded_at timestamp with time zone;
ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_grade_check;
ALTER TABLE public.goals ADD CONSTRAINT goals_grade_check CHECK (grade IS NULL OR (grade >= 0 AND grade <= 15));

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS grade_scale text DEFAULT 'points' NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_grade_scale_check;
ALTER TABLE public.users ADD CONSTRAINT users_grade_scale_check CHECK (grade_scale IN ('points', 'marks'));

-- the Untis subject (its long name) a subject was made from or matched with
ALTER TABLE public.subjects ADD COLUMN IF NOT EXISTS untis_name text;

-- which Untis exam became which goal (never again once the user deleted the goal)
CREATE TABLE IF NOT EXISTS public.untis_exams (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    untis_id bigint NOT NULL,
    goal_id integer REFERENCES public.goals(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, untis_id)
);

-- homework from Untis offered as a task (taken or dismissed ones are kept so they don't come back)
CREATE TABLE IF NOT EXISTS public.untis_homework_suggestions (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    untis_homework_id bigint NOT NULL,
    subject_id integer REFERENCES public.subjects(id) ON DELETE SET NULL,
    subject_name text DEFAULT ''::text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    remark text DEFAULT ''::text NOT NULL,
    due date NOT NULL,
    due_time time without time zone,
    estimate_minutes integer,
    estimate_source text,
    state text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT untis_homework_suggestions_state_check CHECK (state IN ('open', 'taken', 'dismissed')),
    CONSTRAINT untis_homework_suggestions_source_check CHECK (estimate_source IS NULL OR estimate_source IN ('ai', 'default')),
    CONSTRAINT untis_homework_suggestions_minutes_check CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 5 AND 600),
    UNIQUE (user_id, untis_homework_id)
);
CREATE INDEX IF NOT EXISTS untis_homework_suggestions_open ON public.untis_homework_suggestions (user_id, state);
