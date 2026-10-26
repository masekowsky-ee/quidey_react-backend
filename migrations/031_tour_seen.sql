-- 031: the intro tour only for new accounts.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   users.tour_seen_at   when the account closed the intro tour (null: not yet). The app opens
--                        the tour by itself only while it is null, on whichever device. Accounts
--                        that exist already count as having seen it, so only accounts registered
--                        from now on get it after their first sign-in.

\set ON_ERROR_STOP on

ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_seen_at timestamp with time zone;
UPDATE users SET tour_seen_at = now() WHERE tour_seen_at IS NULL;
