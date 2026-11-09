-- 043: a task's notes live in the notebook.
-- Notes written on a task (Home's focus card, the Fokusraum's task card) used to go into their own
-- table `notes` (task_id, content), which the notebook (Fokusraum, Notizen) never showed. They are
-- now notebook notes about that task (notebook_notes.task_id), so every note is in one place. The
-- old routes (/api/notes, /api/tasks/:id/notes) stay for older apps and read / write notebook notes.
-- The rows move to the task's owner (a task note had no author of its own). Run once more, it finds
-- nothing left to move (migrate.sh runs it in one transaction). The table `notes` stays (empty) for older code paths.

INSERT INTO public.notebook_notes (user_id, task_id, title, body, created_at, updated_at)
SELECT tasks.user_id, notes.task_id, '', btrim(notes.content),
       COALESCE(notes.created_at, now()), COALESCE(notes.created_at, now())
FROM public.notes
JOIN public.tasks ON tasks.id = notes.task_id
WHERE tasks.user_id IS NOT NULL AND btrim(COALESCE(notes.content, '')) <> ''
ORDER BY notes.id;

DELETE FROM public.notes;
