-- 052: the trial version (branch trial-version): an account without beta access can choose
-- "continue with the trial version" on the beta screen: all features, the free plan's limits.
-- trial_at is when it chose; a tester / Pro / admin account has no limits whatever this says.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS trial_at timestamp with time zone;

-- the task a homework suggestion became (tasks from Untis homework don't count toward the task limit)
ALTER TABLE public.untis_homework_suggestions ADD COLUMN IF NOT EXISTS task_id integer REFERENCES public.tasks(id) ON DELETE SET NULL;
