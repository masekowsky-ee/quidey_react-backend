-- 055: Lernen: a goal as a date only, and a study window per goal.
--   goals.plan_mode      gets 'none': no parts, nothing planned, only the date (Lernen + a calendar event)
--   goals.study_from/to  optional window (both days included) the planner stays inside
--   goals.event_task_id  the calendar event a date-only goal made (null once the event is deleted)
-- Safe to run again (migrate.sh runs it in one transaction).

ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_plan_mode_check;
ALTER TABLE public.goals ADD CONSTRAINT goals_plan_mode_check CHECK (plan_mode IN ('slots', 'days', 'none'));
ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS study_from date;
ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS study_to date;
ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS event_task_id integer REFERENCES public.tasks(id) ON DELETE SET NULL;
ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_study_window_check;
ALTER TABLE public.goals ADD CONSTRAINT goals_study_window_check CHECK (study_from IS NULL OR study_to IS NULL OR study_from <= study_to);
