-- 013: inbox (messages between friends, notifications) and admin broadcasts
-- messages: one direct message from one user to a friend; read_at when the recipient opened it.
-- notifications: notices for one user (an admin broadcast, later other system notices).
-- broadcasts: what an admin sent to everybody, for the admin panel's log.
-- Everything goes with the account it belongs to (Konto löschen).
-- Already part of schema.sql. Run this only on a database created before it.

CREATE TABLE IF NOT EXISTS messages (
    id           serial PRIMARY KEY,
    sender_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    read_at      timestamp with time zone,
    CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient_id, created_at);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id, created_at);

CREATE TABLE IF NOT EXISTS broadcasts (
    id              serial PRIMARY KEY,
    admin_id        integer REFERENCES users(id) ON DELETE SET NULL,
    admin_username  text,
    title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    recipient_count integer NOT NULL DEFAULT 0,
    created_at      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
    id           serial PRIMARY KEY,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('broadcast', 'system')),
    title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    broadcast_id integer REFERENCES broadcasts(id) ON DELETE CASCADE,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    read_at      timestamp with time zone
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at);
