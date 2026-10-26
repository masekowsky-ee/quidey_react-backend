-- 029: several reminders per task, and reminders for tasks without a time.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   tasks.reminders             minutes before the start, each 0 (at the start) … a week, at most
--                               5, sorted; empty: no reminder. Replaces tasks.reminder_minutes.
--                               Before this, every open task with a time was pushed at its start
--                               when it had no reminder: those get "at the start" (0), so nothing
--                               goes quiet.
--   users.allday_reminder_time  where a task without a time of day "starts" for its reminders
--                               (in the user's time zone): "at the start" of an all-day task is
--                               that time on its day, "1 day before" that time the day before.

\set ON_ERROR_STOP on

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminders integer[] DEFAULT '{}' NOT NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'reminder_minutes') THEN
        UPDATE tasks SET reminders = ARRAY[reminder_minutes] WHERE reminder_minutes IS NOT NULL;
        UPDATE tasks SET reminders = '{0}' WHERE reminder_minutes IS NULL AND due_time IS NOT NULL AND NOT done;
        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_reminder_minutes_check;
        ALTER TABLE tasks DROP COLUMN reminder_minutes;
    END IF;
END $$;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_reminders_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_reminders_check
    CHECK (cardinality(reminders) <= 5 AND array_position(reminders, NULL) IS NULL
        AND 0 <= ALL (reminders) AND 10080 >= ALL (reminders));

ALTER TABLE users ADD COLUMN IF NOT EXISTS allday_reminder_time time DEFAULT '12:00' NOT NULL;
