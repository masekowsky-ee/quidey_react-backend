-- 056: idempotency keys. The apps keep changes made offline in a queue and send them again when the
-- connection is back; a retry of a request the server already handled (its answer got lost) must not
-- make a second task or session. The apps send an Idempotency-Key header on those; the first answer
-- to a key is kept here (utils/idempotency.js) and replayed for the same key.
-- Safe to run again (migrate.sh runs it in one transaction).

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    key text NOT NULL,
    status integer,
    response jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON public.idempotency_keys (created_at);
