-- 022: Quidey Family: a fixed group of accounts with a shared calendar and a chat of its own,
-- apart from the shared sessions (which end). For testers only for now (/api/tester/families).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   families         name and owner. The owner renames it, removes members or deletes it. When the
--                    owner deletes their account, the longest member takes over (see DELETE
--                    /api/users); a family nobody else is in goes with the account.
--   family_members   invited friends join (status 'invited' -> 'joined'); leaving deletes the row
--   family_tasks     the shared calendar: entries with the same optional fields as tasks in a
--                    shared session (day, time, prio, duration, location, link, details, colour)
--   family_messages  the family's chat; deleting an account takes its messages along

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS families (
    id serial PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_members (
    family_id integer NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('invited', 'joined')),
    invited_by integer REFERENCES users(id) ON DELETE SET NULL,
    invited_at timestamp with time zone NOT NULL DEFAULT now(),
    joined_at timestamp with time zone,
    PRIMARY KEY (family_id, user_id)
);
CREATE INDEX IF NOT EXISTS family_members_user_idx ON family_members (user_id);

CREATE TABLE IF NOT EXISTS family_tasks (
    id serial PRIMARY KEY,
    family_id integer NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    done boolean NOT NULL DEFAULT false,
    due date,
    due_time time without time zone,
    prio integer,
    duration_minutes integer,
    location text,
    link text,
    details text,
    color text,
    added_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT family_tasks_due_time_needs_due_check CHECK (due_time IS NULL OR due IS NOT NULL),
    CONSTRAINT family_tasks_duration_minutes_check
        CHECK (duration_minutes IS NULL OR (duration_minutes >= 1 AND duration_minutes <= 10080)),
    CONSTRAINT family_tasks_color_check
        CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'))
);
CREATE INDEX IF NOT EXISTS family_tasks_family_idx ON family_tasks (family_id);

CREATE TABLE IF NOT EXISTS family_messages (
    id serial PRIMARY KEY,
    family_id integer NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS family_messages_family_idx ON family_messages (family_id, id);
