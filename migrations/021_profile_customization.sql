-- 021: a profile people can make their own, and friends can look at
-- Already part of schema.sql. Run this only on a database created before it.
--
-- All optional (NULL = not set). Everybody signed in sees only username and display name;
-- friends also see these fields and, unless show_stats is off, the focus statistics.
--   bio            short text about oneself (up to 280 characters)
--   status_text    what one is working on right now ("Mathe-Klausur am Freitag", up to 80)
--   study          school / subject / semester (up to 60)
--   interests      up to 6 tags, each 1-24 characters
--   profile_color  one of the task colours; NULL = the viewer's accent colour
--   banner         one of the banner patterns
--   avatar_emoji   one emoji from a fixed list (checked by the API), shown instead of the initials

\set ON_ERROR_STOP on

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS study text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_stats boolean NOT NULL DEFAULT true;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_bio_check;
ALTER TABLE users ADD CONSTRAINT users_bio_check CHECK (bio IS NULL OR length(bio) <= 280);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_text_check;
ALTER TABLE users ADD CONSTRAINT users_status_text_check CHECK (status_text IS NULL OR length(status_text) <= 80);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_study_check;
ALTER TABLE users ADD CONSTRAINT users_study_check CHECK (study IS NULL OR length(study) <= 60);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_interests_check;
ALTER TABLE users ADD CONSTRAINT users_interests_check CHECK (cardinality(interests) <= 6);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_color_check;
ALTER TABLE users ADD CONSTRAINT users_profile_color_check
    CHECK (profile_color IS NULL OR profile_color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_banner_check;
ALTER TABLE users ADD CONSTRAINT users_banner_check
    CHECK (banner IS NULL OR banner IN ('gradient', 'aurora', 'dots', 'stripes', 'grid', 'glow'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_emoji_check;
ALTER TABLE users ADD CONSTRAINT users_avatar_emoji_check CHECK (avatar_emoji IS NULL OR length(avatar_emoji) <= 16);
