-- 016: a colour per task, and reminders by mail
-- Already part of schema.sql. Run this only on a database created before it.
--
-- tasks.color: one of the app's task colours ('red', 'orange', 'yellow', 'green', 'teal',
-- 'blue', 'violet', 'pink') or NULL (the default look).
-- tasks.reminder_email: the owner also gets the reminder by mail (needs due, due_time and
-- reminder_minutes; the in-app reminder works as before).
-- tasks.reminder_mailed_at: the reminder time the last mail was sent for, so every reminder is
-- mailed once, and moving the task (or changing its reminder) mails again.
-- users.timezone / users.language: the app sends them, so a task at 09:00 is reminded at 09:00
-- where the user lives, in their language. NULL: Europe/Berlin, German.

\set ON_ERROR_STOP on

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_email boolean DEFAULT false NOT NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_mailed_at timestamp with time zone;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language text;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_color_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_color_check
    CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_language_check;
ALTER TABLE users ADD CONSTRAINT users_language_check CHECK (language IS NULL OR language IN ('de', 'en'));

-- the reminder job looks at open tasks with a mail reminder, by day
CREATE INDEX IF NOT EXISTS tasks_reminder_email_idx ON public.tasks (due) WHERE reminder_email AND NOT done;
