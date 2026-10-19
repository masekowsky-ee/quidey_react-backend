-- 005: closed beta - pro users and beta access requests
-- Only users with is_pro can use the app; everybody else sees the beta screen,
-- where they can ask for access once, with a reason.
-- Already part of schema.sql. Run this only on a database created before it.
--
-- Grant / revoke by hand (or with `npm run pro` in the backend folder):
--   UPDATE users SET is_pro = true  WHERE username = 'someone';
--   UPDATE users SET is_pro = false WHERE username = 'someone';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro boolean NOT NULL DEFAULT false;

-- One request per user (the primary key makes "only once" a database rule, not just a UI one)
CREATE TABLE IF NOT EXISTS beta_access_requests (
    user_id    integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason     text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
    status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS beta_access_requests_status_idx ON beta_access_requests (status, created_at);
