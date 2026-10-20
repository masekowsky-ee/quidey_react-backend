-- 010: email verification
-- users.email_verified is false until the user opens the link from the verification email.
-- Each link carries a random token; only its hash is stored, so a leaked database cannot be
-- used to verify addresses. A token is valid until expires_at and is gone with its user.
-- Already part of schema.sql. Run this only on a database created before it.

-- Accounts that already have an email when the column is added count as verified, so they
-- are not locked out. Only done together with adding the column: running this file again
-- must not verify accounts created since.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'users' AND column_name = 'email_verified') THEN
        ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
        UPDATE users SET email_verified = true WHERE email IS NOT NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id          serial PRIMARY KEY,
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- "drop the old tokens of this user" when a new email is sent or the address is verified
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);
