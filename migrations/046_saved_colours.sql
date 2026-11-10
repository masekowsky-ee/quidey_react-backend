-- 046: colours of one's own kept for the colour pickers ("#rrggbb", at most 16, newest first).
-- Every picker (tasks, groups, events, subjects, collections, notes) offers them beside the eight.
-- Safe to run again.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS saved_colors text[] DEFAULT '{}'::text[] NOT NULL;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_saved_colors_check;
ALTER TABLE public.users ADD CONSTRAINT users_saved_colors_check CHECK ((cardinality(saved_colors) <= 16));
