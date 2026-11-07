-- 045: the admin user export is logged (admin_actions.action 'export_users').
-- Safe to run again (the constraint is dropped and added; migrate.sh runs it in one transaction).

ALTER TABLE public.admin_actions DROP CONSTRAINT IF EXISTS admin_actions_action_check;
ALTER TABLE public.admin_actions ADD CONSTRAINT admin_actions_action_check CHECK ((action = ANY (ARRAY['grant_pro'::text, 'revoke_pro'::text, 'grant_admin'::text, 'revoke_admin'::text, 'grant_tester'::text, 'revoke_tester'::text, 'approve_request'::text, 'decline_request'::text, 'reset_request'::text, 'remove_avatar'::text, 'export_users'::text])));
