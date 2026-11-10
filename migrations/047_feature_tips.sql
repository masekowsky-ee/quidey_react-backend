-- 047: feature tips (the app's small tooltips at its controls, which replaced the intro tour for new
-- accounts): which ones each account has seen, kept on the server so every device knows.
-- users.tips_seen: the tips' ids (the app's features/tips/tips.js), at most 300; users.tips_off:
-- "Tipps ausblenden".
-- Everybody who has seen the old intro tour (tour_seen_at) knows the basics it showed: those tips
-- count as seen for them, so they only get the tips about features that came after it. Keep the
-- list in step with BASIC_TIPS in the app's features/tips/tips.js. A tip added later is in nobody's
-- list, so everybody sees it once.
-- Safe to run again.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tips_seen text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS tips_off boolean DEFAULT false NOT NULL;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_tips_seen_check;
ALTER TABLE public.users ADD CONSTRAINT users_tips_seen_check CHECK ((cardinality(tips_seen) <= 300));

UPDATE public.users
SET tips_seen = ARRAY(
    SELECT DISTINCT unnest(tips_seen || ARRAY[
        'navHome', 'navCalendar', 'navFocus', 'navCommunity', 'navInbox', 'navStats', 'navMore', 'tabbar',
        'add', 'focus', 'list', 'search', 'calendarViews', 'calendarDrag', 'focusTimer', 'community', 'stats'
    ]::text[])
)
WHERE tour_seen_at IS NOT NULL;
