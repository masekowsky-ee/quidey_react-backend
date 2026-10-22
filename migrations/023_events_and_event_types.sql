-- 023: events next to tasks, and event types.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   tasks.kind           'task' (has to be done: ticked off by hand) or 'event' (an appointment:
--                        it counts as done once it is over, the server ticks it off by itself).
--                        For a task, duration_minutes is the time planned for it; for an event,
--                        how long it lasts. An event needs a day.
--   tasks.event_type_id  what kind of event, e.g. "Arbeit": one of its owner's event_types.
--                        Deleting a type keeps its events, without a type.
--   event_types          each user's own list of event types (name and colour). The statistics
--                        add up the time of past events per type.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS event_types (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    color text CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink')),
    position integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_types_user_name_idx ON event_types (user_id, lower(name));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS event_type_id integer REFERENCES event_types(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_kind_check') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('task', 'event'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_event_needs_due_check') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_event_needs_due_check CHECK (kind <> 'event' OR due IS NOT NULL);
    END IF;
END $$;

-- the events still to tick off (checked every minute) and the statistics per day
CREATE INDEX IF NOT EXISTS tasks_open_events_idx ON tasks (due) WHERE kind = 'event' AND NOT done;
CREATE INDEX IF NOT EXISTS tasks_user_events_idx ON tasks (user_id, due) WHERE kind = 'event';
CREATE INDEX IF NOT EXISTS tasks_event_type_idx ON tasks (event_type_id) WHERE event_type_id IS NOT NULL;
