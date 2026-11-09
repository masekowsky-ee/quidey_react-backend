-- 040: events and reminders in families, who ticked off a shared entry, push kind "groups".
-- Already part of schema.sql. Run this only on a database created before it.
--
--   family_tasks           kind: 'task' or 'event' (an event needs a day and is done once over,
--                          in the family owner's time zone); reminders: minutes before the start
--                          (like tasks.reminders), pushed to every joined member; push_sent_for:
--                          the reminder time last pushed for; done_by / completed_at: who ticked a
--                          task off and when (an event: its end), for the statistics.
--   shared_session_tasks   done_by / completed_at, the same.
--   notifications          kind entries_added: somebody else added entries to my family / session.
--   push_subscriptions     groups: new entries by others and chat messages in my families and
--                          sessions (on for every device).

\set ON_ERROR_STOP on

ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS reminders integer[] NOT NULL DEFAULT '{}';
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS push_sent_for timestamp with time zone;
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS done_by integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;
ALTER TABLE public.family_tasks DROP CONSTRAINT IF EXISTS family_tasks_kind_check;
ALTER TABLE public.family_tasks ADD CONSTRAINT family_tasks_kind_check CHECK (kind IN ('task', 'event'));
ALTER TABLE public.family_tasks DROP CONSTRAINT IF EXISTS family_tasks_event_needs_due_check;
ALTER TABLE public.family_tasks ADD CONSTRAINT family_tasks_event_needs_due_check CHECK (kind <> 'event' OR due IS NOT NULL);
ALTER TABLE public.family_tasks DROP CONSTRAINT IF EXISTS family_tasks_reminders_check;
ALTER TABLE public.family_tasks ADD CONSTRAINT family_tasks_reminders_check
    CHECK (cardinality(reminders) <= 5 AND array_position(reminders, NULL) IS NULL
        AND 0 <= ALL (reminders) AND 10080 >= ALL (reminders));

ALTER TABLE public.shared_session_tasks ADD COLUMN IF NOT EXISTS done_by integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.shared_session_tasks ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS groups boolean NOT NULL DEFAULT true;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('broadcast', 'system', 'task_assigned', 'entries_added'));

CREATE INDEX IF NOT EXISTS family_tasks_open_events ON public.family_tasks (due) WHERE kind = 'event' AND NOT done;
CREATE INDEX IF NOT EXISTS family_tasks_done_by ON public.family_tasks (done_by, completed_at);
CREATE INDEX IF NOT EXISTS shared_session_tasks_done_by ON public.shared_session_tasks (done_by, completed_at);
