-- 034: sign in with Google, and push notifications to the Android app (Firebase Cloud Messaging).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   users.google_sub     Google's id of the person (the "sub" of a Google ID token), set when an
--                        account signs in with Google the first time (a new one, or an existing one
--                        found by its email address). Unique.
--   users.has_password   false for an account made with Google that never set a password: it
--                        signs in with Google only, and setting a password or deleting the account
--                        asks for no current password.
--   push_subscriptions   a device of the Android app has no Web Push keys: its endpoint is
--                        'fcm:<token>' (the FCM registration token) and p256dh / auth stay empty.

\set ON_ERROR_STOP on

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_password boolean DEFAULT true NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub);

ALTER TABLE push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN auth DROP NOT NULL;
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_check;
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_keys_check;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_check
    CHECK (char_length(endpoint) <= 1000 AND (endpoint ~ '^https://' OR endpoint ~ '^fcm:[A-Za-z0-9_:-]+$'));
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_keys_check
    CHECK (CASE WHEN endpoint ~ '^fcm:'
        THEN p256dh IS NULL AND auth IS NULL
        ELSE char_length(p256dh) BETWEEN 1 AND 200 AND char_length(auth) BETWEEN 1 AND 100 END);
