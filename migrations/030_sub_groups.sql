-- 030: sub-groups in shared sessions and families (experimental, testers).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   shared_session_groups / family_groups   named groups inside one session / family
--                                           ("Kapitel 1", "Einkauf"), made by any member
--   shared_session_tasks.group_id /         the sub-group an entry is in (null: none); deleting
--   family_tasks.group_id                   a group keeps its entries

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS shared_session_groups (
    id serial PRIMARY KEY,
    session_id integer NOT NULL REFERENCES shared_sessions(id) ON DELETE CASCADE,
    name text NOT NULL CONSTRAINT shared_session_groups_name_check CHECK (length(name) >= 1 AND length(name) <= 40),
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_session_groups_session_id_idx ON shared_session_groups (session_id);

ALTER TABLE shared_session_tasks ADD COLUMN IF NOT EXISTS group_id integer
    REFERENCES shared_session_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS shared_session_tasks_group_id_idx ON shared_session_tasks (group_id) WHERE group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS family_groups (
    id serial PRIMARY KEY,
    family_id integer NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    name text NOT NULL CONSTRAINT family_groups_name_check CHECK (length(name) >= 1 AND length(name) <= 40),
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS family_groups_family_id_idx ON family_groups (family_id);

ALTER TABLE family_tasks ADD COLUMN IF NOT EXISTS group_id integer
    REFERENCES family_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS family_tasks_group_id_idx ON family_tasks (group_id) WHERE group_id IS NOT NULL;
