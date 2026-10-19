-- 006: admins and a log of what they did
-- Admins see the admin panel: beta requests, giving and taking away pro and admin.
-- Already part of schema.sql. Run this only on a database created before it.
--
-- Make someone admin by hand (or with `npm run pro -- admin <username>`):
--   UPDATE users SET is_admin = true WHERE username = 'someone';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Every change an admin makes, newest last. The usernames are kept as text too,
-- so the entry still reads right after an account is deleted.
CREATE TABLE IF NOT EXISTS admin_actions (
    id              serial PRIMARY KEY,
    admin_id        integer REFERENCES users(id) ON DELETE SET NULL,
    admin_username  text NOT NULL,
    target_id       integer REFERENCES users(id) ON DELETE SET NULL,
    target_username text NOT NULL,
    action          text NOT NULL CHECK (action IN (
        'grant_pro', 'revoke_pro', 'grant_admin', 'revoke_admin',
        'approve_request', 'decline_request', 'reset_request'
    )),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at DESC);
