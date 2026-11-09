-- 046: daily allowances for the AI features (utils/quota.js): how much of each an account used on a
-- day of its own time zone. One row per account, day and kind; old days are deleted after a week.
CREATE TABLE IF NOT EXISTS public.daily_quota (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    day date NOT NULL,
    kind text NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    CONSTRAINT daily_quota_pkey PRIMARY KEY (user_id, day, kind),
    CONSTRAINT daily_quota_kind_check CHECK ((kind = ANY (ARRAY['scan'::text, 'ai_line'::text]))),
    CONSTRAINT daily_quota_used_check CHECK ((used >= 0))
);
