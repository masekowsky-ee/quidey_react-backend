-- 003: shared sessions ("Together")
-- Friends work in one session: everybody adds tasks, anybody can work on any of them,
-- and the time is kept per task and person, so you can see later who did what for how long.
-- Already part of schema.sql. Run this only on a database created before it.

CREATE TABLE IF NOT EXISTS shared_sessions (
    id         serial PRIMARY KEY,
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    owner_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at   timestamptz -- set by the owner; an ended session is read-only
);

-- Tasks live in the session itself, so every member can see them. A task taken over
-- from someone's own list remembers where it came from (source_task_id).
CREATE TABLE IF NOT EXISTS shared_session_tasks (
    id             serial PRIMARY KEY,
    session_id     integer NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
    name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    description    text,
    done           boolean NOT NULL DEFAULT false,
    added_by       integer REFERENCES users(id) ON DELETE SET NULL,
    source_task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_session_tasks_session_idx ON shared_session_tasks (session_id);

-- The same personal task can be added to a session only once
CREATE UNIQUE INDEX IF NOT EXISTS shared_session_tasks_source_unique
    ON shared_session_tasks (session_id, source_task_id) WHERE source_task_id IS NOT NULL;

-- Invited until they join. current_task_id + last_seen_at say who is working on what right now.
-- Leaving deletes the row; the time someone booked stays in shared_session_time.
CREATE TABLE IF NOT EXISTS shared_session_members (
    session_id      integer NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
    user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'joined')),
    invited_by      integer REFERENCES users(id) ON DELETE SET NULL,
    invited_at      timestamptz NOT NULL DEFAULT now(),
    joined_at       timestamptz,
    current_task_id integer REFERENCES shared_session_tasks(id) ON DELETE SET NULL,
    last_seen_at    timestamptz,
    PRIMARY KEY (session_id, user_id)
);

-- "my sessions" and "my invites"
CREATE INDEX IF NOT EXISTS shared_session_members_user_idx ON shared_session_members (user_id, status);

-- Total time one person spent on one shared task (milliseconds)
CREATE TABLE IF NOT EXISTS shared_session_time (
    task_id    integer NOT NULL REFERENCES shared_session_tasks(id) ON DELETE CASCADE,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    time_ms    bigint  NOT NULL DEFAULT 0 CHECK (time_ms >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);
