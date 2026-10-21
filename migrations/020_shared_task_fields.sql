-- 020: tasks in a shared session can have the same details as one's own tasks
-- Already part of schema.sql. Run this only on a database created before it.
--
-- All optional (NULL = not set), with the same rules as on tasks: a day (due) with an optional
-- time of day, priority, duration, location, link, extra info and colour. Reminders, repeating
-- and groups stay personal, they are only on one's own tasks.

\set ON_ERROR_STOP on

ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS due date;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS due_time time without time zone;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS prio integer;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS link text;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS details text;
ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE shared_session_tasks DROP CONSTRAINT IF EXISTS shared_session_tasks_due_time_needs_due_check;
ALTER TABLE shared_session_tasks ADD CONSTRAINT shared_session_tasks_due_time_needs_due_check
    CHECK (due_time IS NULL OR due IS NOT NULL);
ALTER TABLE shared_session_tasks DROP CONSTRAINT IF EXISTS shared_session_tasks_duration_minutes_check;
ALTER TABLE shared_session_tasks ADD CONSTRAINT shared_session_tasks_duration_minutes_check
    CHECK (duration_minutes IS NULL OR (duration_minutes >= 1 AND duration_minutes <= 10080));
ALTER TABLE shared_session_tasks DROP CONSTRAINT IF EXISTS shared_session_tasks_color_check;
ALTER TABLE shared_session_tasks ADD CONSTRAINT shared_session_tasks_color_check
    CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'));
