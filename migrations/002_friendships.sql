-- 002: friends
-- One row per pair of users. A request is 'pending' until the addressee accepts it.
-- Declining, cancelling and unfriending delete the row, so nobody can tell
-- a declined request from one that is still waiting.
-- Already part of schema.sql. Run this only on a database created before it.

CREATE TABLE IF NOT EXISTS friendships (
    id           serial PRIMARY KEY,
    requester_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       text    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz,
    CHECK (requester_id <> addressee_id)
);

-- A pair can exist only once, no matter who asked whom
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_unique
    ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

-- "my incoming requests" and "my outgoing requests"
CREATE INDEX IF NOT EXISTS friendships_addressee_status_idx ON friendships (addressee_id, status);
CREATE INDEX IF NOT EXISTS friendships_requester_status_idx ON friendships (requester_id, status);
