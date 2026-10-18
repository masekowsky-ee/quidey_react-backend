-- 001: time spent per task within a session (milliseconds)
-- Already part of schema.sql. Run this only on a database created before it.
ALTER TABLE session_tasks ADD COLUMN IF NOT EXISTS time_ms integer NOT NULL DEFAULT 0;
