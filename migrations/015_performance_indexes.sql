-- 015: indexes for the queries the app runs all the time
-- Already part of schema.sql. Run this only on a database created before it.
--
-- Without them Postgres reads the whole table for things like "my tasks" (tasks.user_id) or
-- "my groups"; that's unnoticeable with a few rows and slow with many. Foreign keys also need
-- an index on the referencing side, or every DELETE of a user/task/group/session scans the
-- tables pointing at it. The two partial indexes cover the unread counts (inbox badge).
-- CONCURRENTLY isn't used: it can't run inside psql -1, and the tables are small enough today.

CREATE INDEX IF NOT EXISTS tasks_user_idx ON public.tasks (user_id);
CREATE INDEX IF NOT EXISTS groups_user_idx ON public.groups (user_id);
CREATE INDEX IF NOT EXISTS notes_task_idx ON public.notes (task_id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_group_idx ON public.sessions (group_id);
CREATE INDEX IF NOT EXISTS session_tasks_task_idx ON public.session_tasks (task_id);
CREATE INDEX IF NOT EXISTS task_groups_group_idx ON public.task_groups (group_id);
CREATE INDEX IF NOT EXISTS shared_sessions_owner_idx ON public.shared_sessions (owner_id);
CREATE INDEX IF NOT EXISTS shared_session_time_user_idx ON public.shared_session_time (user_id);
CREATE INDEX IF NOT EXISTS messages_unread_idx ON public.messages (recipient_id, sender_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON public.notifications (user_id) WHERE read_at IS NULL;

ANALYZE public.tasks, public.groups, public.notes, public.sessions, public.session_tasks,
    public.task_groups, public.shared_sessions, public.shared_session_time, public.messages,
    public.notifications;
