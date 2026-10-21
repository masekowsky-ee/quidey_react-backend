-- 014: every account has an email address, and owners can't lose admin
-- Already part of schema.sql. Run this only on a database created before it.
--
-- is_owner: false for everybody; the app never reads, sends or writes it. An owner is always
-- admin: the database turns is_admin back on whenever something tries to switch it off.
-- Only a superuser (postgres, by hand in psql) can set or clear it; the app's role
-- (quidey_app) gets an error if it tries:
--   UPDATE users SET is_owner = true WHERE username = 'someone';

\set ON_ERROR_STOP on

-- Registration has required an address for a while; older rows without one would stop this.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE email IS NULL OR btrim(email) = '') THEN
        RAISE EXCEPTION 'Some users have no email address. Give them one first: SELECT id, username FROM users WHERE email IS NULL OR btrim(email) = '''';';
    END IF;
END $$;

ALTER TABLE users ALTER COLUMN email SET NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION users_protect_owner() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_owner IS DISTINCT FROM (CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.is_owner END)
        AND current_setting('is_superuser') <> 'on' THEN
        RAISE EXCEPTION 'is_owner can only be changed by hand as a database superuser';
    END IF;
    IF NEW.is_owner THEN
        NEW.is_admin := true;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_protect_owner ON users;
CREATE TRIGGER users_protect_owner BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION users_protect_owner();
