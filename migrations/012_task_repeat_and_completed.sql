-- 012: repeating tasks and when a task was completed
-- tasks.repeat: 'daily' | 'weekly' | 'monthly' | 'yearly' or NULL. When a repeating task is done,
-- the server creates the next one (same fields, the next due day) and links it by repeat_from_id,
-- so ticking the same task twice never creates two.
-- tasks.completed_at: set when a task becomes done, cleared when it is reopened (the history shows
-- it). Tasks that were done before this have no date.
-- Already part of schema.sql. Run this only on a database created before it.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_from_id integer REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_repeat_check') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_check
            CHECK (repeat IS NULL OR repeat IN ('daily', 'weekly', 'monthly', 'yearly'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_repeat_needs_due_check') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_needs_due_check CHECK (repeat IS NULL OR due IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_repeat_from_idx ON tasks (repeat_from_id);
