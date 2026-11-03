-- 036: the notes area and collections (testers first).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   note_folders               my folders for notes: a name (unique per account, any case) and an emoji
--   notebook_notes.folder_id   the folder a note sits in (none: loose; deleting a folder keeps its notes)
--   notebook_notes.tags        up to 10 words of my own (without "#")
--   notebook_notes.color       one of the task colours, or none
--   notebook_notes.archived    put away: out of the lists, still searchable in the archive
--   notebook_notes.trashed_at  in the trash since then (deleted for good after 30 days)
--   collections                my collections: a name, emoji, colour and a few words, holding
--   collection_items           tasks, events (both in tasks) and notes; an entry goes when its task
--                              or note is deleted. One thing can be in several collections.
--   users.groups_imported_at   when a tester's groups were taken over as collections (once)

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.note_folders (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    emoji text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS note_folders_user_name ON public.note_folders (user_id, lower(name));

ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS folder_id integer REFERENCES public.note_folders(id) ON DELETE SET NULL;
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS trashed_at timestamp with time zone;
CREATE INDEX IF NOT EXISTS notebook_notes_trashed ON public.notebook_notes (trashed_at) WHERE trashed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.collections (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    emoji text,
    color text,
    description text NOT NULL DEFAULT '',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collections_user ON public.collections (user_id);

CREATE TABLE IF NOT EXISTS public.collection_items (
    id serial PRIMARY KEY,
    collection_id integer NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
    task_id integer REFERENCES public.tasks(id) ON DELETE CASCADE,
    note_id integer REFERENCES public.notebook_notes(id) ON DELETE CASCADE,
    added_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT collection_items_one_thing CHECK ((task_id IS NULL) <> (note_id IS NULL)),
    CONSTRAINT collection_items_task_once UNIQUE (collection_id, task_id),
    CONSTRAINT collection_items_note_once UNIQUE (collection_id, note_id)
);
CREATE INDEX IF NOT EXISTS collection_items_task ON public.collection_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS collection_items_note ON public.collection_items (note_id) WHERE note_id IS NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS groups_imported_at timestamp with time zone;
