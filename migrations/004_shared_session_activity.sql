-- 004: shared sessions - task assignments and the activity feed (incl. chat messages)
-- Already part of schema.sql. Run this only on a database created before it.

-- Who should take care of a task (any member, or nobody)
ALTER TABLE shared_session_tasks
    ADD COLUMN IF NOT EXISTS assignee_id integer REFERENCES users(id) ON DELETE SET NULL;

-- What happened in a session, newest last: people joining and leaving, tasks added,
-- assigned and finished, who started working on what, and chat messages (type 'message').
CREATE TABLE IF NOT EXISTS shared_session_events (
    id         serial PRIMARY KEY,
    session_id integer NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
    user_id    integer REFERENCES users(id) ON DELETE SET NULL,
    type       text NOT NULL CHECK (type IN (
        'created', 'joined', 'left', 'removed', 'task_added', 'task_done', 'task_reopened',
        'task_assigned', 'started', 'message', 'renamed', 'ended'
    )),
    -- the task it is about; the name is kept so the entry still reads right after a task is removed
    task_id    integer REFERENCES shared_session_tasks(id) ON DELETE SET NULL,
    task_name  text,
    -- message text, new session name, or the assignee's name
    text       text CHECK (length(text) <= 1000),
    target_id  integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_session_events_session_idx ON shared_session_events (session_id, id);
