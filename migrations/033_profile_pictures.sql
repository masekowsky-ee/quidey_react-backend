-- 033: profile pictures (testers first).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   user_avatars   one picture per account: the image (WebP / JPEG / PNG, made small and square
--                  by the app, at most about 90 KB), its type and when it was set. Seen by the
--                  account itself, its friends and the people in its open shared sessions and
--                  families (the same people who see its online status). Goes with the account.
--   admin_actions  may now say 'remove_avatar' (an admin took a picture down).

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.user_avatars (
    user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    image bytea NOT NULL,
    mime text NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg', 'image/png')),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_actions DROP CONSTRAINT IF EXISTS admin_actions_action_check;
ALTER TABLE public.admin_actions ADD CONSTRAINT admin_actions_action_check CHECK ((action = ANY (ARRAY['grant_pro'::text, 'revoke_pro'::text, 'grant_admin'::text, 'revoke_admin'::text, 'grant_tester'::text, 'revoke_tester'::text, 'approve_request'::text, 'decline_request'::text, 'reset_request'::text, 'remove_avatar'::text])));
