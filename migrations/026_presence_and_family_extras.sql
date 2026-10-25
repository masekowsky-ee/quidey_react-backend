-- 026: online status and more for Quidey Family.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   users.show_online         friends (and the people in my shared sessions and families) see
--                             whether I have the app open right now. Nothing about it is stored:
--                             the server only knows the open connections.
--   families.note             the family's board: one short text every member can change
--   families.emoji / .color   how the family looks in lists and on its page (owner)
--   family_tasks.assignee_id  who takes care of an entry (any member, or nobody)

\set ON_ERROR_STOP on

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_online boolean NOT NULL DEFAULT true;

ALTER TABLE families ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE families ADD COLUMN IF NOT EXISTS note_updated_at timestamp with time zone;
ALTER TABLE families ADD COLUMN IF NOT EXISTS note_updated_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE families ADD COLUMN IF NOT EXISTS emoji text;
ALTER TABLE families ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE family_tasks ADD COLUMN IF NOT EXISTS assignee_id integer REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'families_note_check') THEN
        ALTER TABLE families ADD CONSTRAINT families_note_check CHECK (note IS NULL OR char_length(note) <= 2000);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'families_emoji_check') THEN
        ALTER TABLE families ADD CONSTRAINT families_emoji_check CHECK (emoji IS NULL OR char_length(emoji) <= 16);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'families_color_check') THEN
        ALTER TABLE families ADD CONSTRAINT families_color_check CHECK (color IS NULL OR color = ANY (ARRAY[
            'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink']));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS family_tasks_assignee_idx ON family_tasks (assignee_id) WHERE assignee_id IS NOT NULL;
