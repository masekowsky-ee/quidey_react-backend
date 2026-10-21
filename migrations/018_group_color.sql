-- 018: a colour per group; its tasks show a flag in that colour
-- Already part of schema.sql. Run this only on a database created before it.
-- Same colours as tasks (TASK_COLORS in index.js), null = none.

\set ON_ERROR_STOP on

ALTER TABLE groups ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_color_check;
ALTER TABLE groups ADD CONSTRAINT groups_color_check
    CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'));
