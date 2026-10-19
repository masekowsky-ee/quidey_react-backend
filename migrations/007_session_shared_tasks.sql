-- 007: shared-session tasks worked on during a personal (solo) session
-- When the solo timer runs on a task from a shared session, the time is booked in that
-- shared session (shared_session_time) and also noted here, so the solo session in the
-- history shows it, labeled with the shared session's name.
-- Already part of schema.sql. Run this only on a database created before it.

CREATE TABLE IF NOT EXISTS session_shared_tasks (
    session_id     integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    shared_task_id integer NOT NULL REFERENCES shared_session_tasks(id) ON DELETE CASCADE,
    time_ms        integer NOT NULL DEFAULT 0 CHECK (time_ms >= 0),
    PRIMARY KEY (session_id, shared_task_id)
);
