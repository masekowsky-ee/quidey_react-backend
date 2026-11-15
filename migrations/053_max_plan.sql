-- 053: the Max plan, a tier above Pro (Max is a superset of Pro).
--   subscriptions.tier  which plan a subscription is for ('pro' | 'max')
--   users.max_until     the end of the latest running Max subscription (kept by utils/billing.js)
--   users.is_max        Max as a gift (admin panel)
--   admin_actions       grant_max / revoke_max
-- Safe to run again (migrate.sh runs it in one transaction).

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'pro';
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_tier_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_tier_check CHECK (tier IN ('pro', 'max'));

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS max_until timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_max boolean NOT NULL DEFAULT false;

ALTER TABLE public.admin_actions DROP CONSTRAINT IF EXISTS admin_actions_action_check;
ALTER TABLE public.admin_actions ADD CONSTRAINT admin_actions_action_check CHECK ((action = ANY (ARRAY['grant_pro'::text, 'revoke_pro'::text, 'grant_admin'::text, 'revoke_admin'::text, 'grant_tester'::text, 'revoke_tester'::text, 'approve_request'::text, 'decline_request'::text, 'reset_request'::text, 'remove_avatar'::text, 'export_users'::text, 'grant_max'::text, 'revoke_max'::text])));
