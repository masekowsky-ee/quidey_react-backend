-- 008: security hardening
-- Already part of schema.sql. Run this only on a database created before it.

-- Every login token carries the token_version it was issued with. Changing the password or
-- "sign out everywhere" increases it, which makes all older tokens invalid at once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

-- "Ann" and "ann" (or "Ann@x.de" and "ann@x.de") are the same person: no second account
-- that only differs in upper/lower case, e.g. to pose as someone in friend requests.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));
