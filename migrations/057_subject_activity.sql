-- 057: when a subject was last worked on. The study page lists the subject touched last first.
-- Set by the study routes whenever something of the subject is changed (goal, topic, session);
-- focus time on a session and ticked-off topics are read from where they are kept already.
-- Safe to run again.

ALTER TABLE public.subjects ADD COLUMN IF NOT EXISTS last_activity_at timestamp with time zone;
