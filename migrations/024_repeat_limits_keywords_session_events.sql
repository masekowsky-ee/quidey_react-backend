-- 024: repeats that end, skipped repeats, keywords for event types, events in shared sessions.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   tasks.repeat_left     how many more times a repeating task comes back after this one
--                         (NULL = no end). The next one gets repeat_left minus the steps it is
--                         away; none comes when that would be below 0. "Delete this and the
--                         following" on a coming repeat sets it, too.
--   tasks.repeat_skip     days of coming repeats that were deleted on their own ("only this one"):
--                         the next one jumps over them (each still counts as one of repeat_left).
--   event_types.keywords  words that pick the type by themselves: an event whose name contains
--                         one of them gets the type (the app does it, it can be taken away again).
--   shared_session_tasks.kind  'task' or 'event', like tasks.kind: an event in a session needs a
--                         day and is done once it is over (in the session owner's time zone).

\set ON_ERROR_STOP on

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_left integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_skip date[] NOT NULL DEFAULT '{}';

ALTER TABLE event_types ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';

ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_repeat_left_check') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_left_check
            CHECK (repeat_left IS NULL OR (repeat_left >= 0 AND repeat_left <= 1000));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_types_keywords_check') THEN
        ALTER TABLE event_types ADD CONSTRAINT event_types_keywords_check CHECK (cardinality(keywords) <= 20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_session_tasks_kind_check') THEN
        ALTER TABLE shared_session_tasks ADD CONSTRAINT shared_session_tasks_kind_check CHECK (kind IN ('task', 'event'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_session_tasks_event_needs_due_check') THEN
        ALTER TABLE shared_session_tasks ADD CONSTRAINT shared_session_tasks_event_needs_due_check
            CHECK (kind <> 'event' OR due IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS shared_session_tasks_open_events_idx ON shared_session_tasks (due)
    WHERE kind = 'event' AND NOT done;
