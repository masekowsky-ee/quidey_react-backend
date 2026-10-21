-- 015: a notice in the inbox when somebody gives me a task in a shared session
-- Already part of schema.sql. Run this only on a database created before it.
--
-- kind 'task_assigned': title is the task's name, body the session's name; data holds what the
-- app needs to word it in the reader's language and to link to it:
--   { "sessionId": 3, "taskId": 7, "by": { "id": 2, "username": "ben", "displayName": "Ben" } }

\set ON_ERROR_STOP on

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('broadcast', 'system', 'task_assigned'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data jsonb;
