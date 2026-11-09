-- 038: the arcade (games while waiting for beta access, and inside the app) and its leaderboard.
-- Already part of schema.sql. Run this only on a database created before it.
--
--   arcade_scores   one row per account, game and difficulty: the personal best (every run counts),
--                   the best of the runs played for the leaderboard ("Rangliste" mode; null = never
--                   played for it, or taken off it again), how many runs were sent, and when.
--                   Only ranked_best is shown to others (with display and user name). Goes with the account.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.arcade_scores (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    game text NOT NULL CHECK (char_length(game) BETWEEN 1 AND 20),
    level text NOT NULL CHECK (level IN ('easy', 'normal', 'hard')),
    best integer NOT NULL DEFAULT 0 CHECK (best >= 0),
    ranked_best integer CHECK (ranked_best >= 0),
    ranked_at timestamp with time zone,
    plays integer NOT NULL DEFAULT 0,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, game, level)
);
CREATE INDEX IF NOT EXISTS arcade_scores_board ON public.arcade_scores (game, level, ranked_best DESC, ranked_at)
    WHERE ranked_best IS NOT NULL;
