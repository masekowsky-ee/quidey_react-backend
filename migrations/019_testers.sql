-- 019: testers see features that aren't released to everyone yet
-- Already part of schema.sql. Run this only on a database created before it.
-- Admins make someone a tester in the admin panel (or `npm run pro -- tester <username>`);
-- admins always count as testers. A broadcast can go to everyone or only to the testers.

\set ON_ERROR_STOP on

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_tester boolean NOT NULL DEFAULT false;

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'all';
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_audience_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_audience_check CHECK (audience IN ('all', 'testers'));

ALTER TABLE admin_actions DROP CONSTRAINT IF EXISTS admin_actions_action_check;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_action_check CHECK (action IN (
    'grant_pro', 'revoke_pro', 'grant_admin', 'revoke_admin', 'grant_tester', 'revoke_tester',
    'approve_request', 'decline_request', 'reset_request'
));
