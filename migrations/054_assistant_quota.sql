-- 054: the assistant (Max): its daily allowance joins daily_quota (utils/quota.js), and a daily token
-- total per account is kept as numbers only, no content, so the real cost per user can be checked.
-- Old days are deleted with the same cleanup as daily_quota.
ALTER TABLE public.daily_quota DROP CONSTRAINT IF EXISTS daily_quota_kind_check;
ALTER TABLE public.daily_quota ADD CONSTRAINT daily_quota_kind_check CHECK ((kind = ANY (ARRAY['scan'::text, 'ai_line'::text, 'assistant'::text])));

CREATE TABLE IF NOT EXISTS public.assistant_usage (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    day date NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    CONSTRAINT assistant_usage_pkey PRIMARY KEY (user_id, day)
);
