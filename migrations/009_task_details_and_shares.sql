-- 009: optional time and more details on tasks, and tasks shared with friends
-- A task without due_time is for the whole day, as before. duration, reminder, location,
-- link and details are optional extras.
-- A task can be sent to friends (task_shares). It stays 'pending' until the friend accepts;
-- then it is the same task for both: either can edit it or mark it done, only the owner can
-- delete it, the friend can leave it (deletes their row). Declining also deletes the row.
-- Already part of schema.sql. Run this only on a database created before it.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time time;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_minutes integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS link text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS details text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_duration_minutes_check') THEN
        -- up to a week
        ALTER TABLE tasks ADD CONSTRAINT tasks_duration_minutes_check
            CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 10080);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_reminder_minutes_check') THEN
        -- minutes before the start (0: at the start), up to a week
        ALTER TABLE tasks ADD CONSTRAINT tasks_reminder_minutes_check
            CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 10080);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_due_time_needs_due_check') THEN
        -- a time of day only makes sense on a day
        ALTER TABLE tasks ADD CONSTRAINT tasks_due_time_needs_due_check
            CHECK (due_time IS NULL OR due IS NOT NULL);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS task_shares (
    id           serial PRIMARY KEY,
    task_id      integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the friend it was sent to
    invited_by   integer REFERENCES users(id) ON DELETE SET NULL,
    status       text    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz,
    UNIQUE (task_id, user_id)
);

-- "tasks shared with me" and "invites waiting for me"
CREATE INDEX IF NOT EXISTS task_shares_user_status_idx ON task_shares (user_id, status);
