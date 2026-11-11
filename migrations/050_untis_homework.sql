-- 050: homework from Untis becomes tasks (untis.js, branch pro-features). The switch per account
-- (on by default) and a record of which homework already became a task, so it isn't made twice
-- (also not again after the task was deleted by hand).
ALTER TABLE public.untis_accounts ADD COLUMN IF NOT EXISTS homework_to_tasks boolean DEFAULT true NOT NULL;

CREATE TABLE IF NOT EXISTS public.untis_homework_tasks (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    homework_id bigint NOT NULL,
    task_id integer REFERENCES public.tasks(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, homework_id)
);
