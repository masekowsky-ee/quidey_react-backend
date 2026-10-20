-- 011: when the terms of use and the privacy policy were accepted
-- Set on registration (the sign-up form requires both checkboxes and the age confirmation), so
-- there is proof of the agreement. Accounts from before stay NULL: they never saw the checkboxes.
-- Already part of schema.sql. Run this only on a database created before it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamp with time zone;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamp with time zone;
