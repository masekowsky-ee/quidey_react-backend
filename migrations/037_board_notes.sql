-- 037: notes pinned to the board of a family or a shared session.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   board_notes   a member's own note on the board of one family (family_id) or one shared
--                 session (session_id), never both. It stays the owner's note: the others read
--                 it as it is now; deleting the note (or the family / session) takes it off,
--                 a note in the trash or of somebody no longer in it isn't shown.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.board_notes (
    id serial PRIMARY KEY,
    note_id integer NOT NULL REFERENCES public.notebook_notes(id) ON DELETE CASCADE,
    family_id integer REFERENCES public.families(id) ON DELETE CASCADE,
    session_id integer REFERENCES public.shared_sessions(id) ON DELETE CASCADE,
    pinned_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT board_notes_one_board CHECK ((family_id IS NULL) <> (session_id IS NULL)),
    CONSTRAINT board_notes_family_once UNIQUE (family_id, note_id),
    CONSTRAINT board_notes_session_once UNIQUE (session_id, note_id)
);
CREATE INDEX IF NOT EXISTS board_notes_note ON public.board_notes (note_id);
