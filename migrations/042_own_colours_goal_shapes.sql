-- 042: own colours and a shape per study goal.
-- A colour is still one of the eight names, or now a colour of one's own as "#rrggbb" (picked on
-- the colour wheel in the app). Applies to everything the app lets one colour with the same picker:
-- tasks, groups, event types, the tasks of shared sessions and families, and study subjects.
-- Study goals get an optional shape (shown in the subject's colour), so the goals of one subject
-- can be told apart at a glance.

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tasks', 'groups', 'event_types', 'shared_session_tasks', 'family_tasks', 'subjects'] LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_color_check');
        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (color IS NULL OR color IN '
            '(''red'', ''orange'', ''yellow'', ''green'', ''teal'', ''blue'', ''violet'', ''pink'') '
            'OR color ~ ''^#[0-9a-f]{6}$'')',
            t, t || '_color_check');
    END LOOP;
END $$;

ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS shape text;
ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_shape_check;
ALTER TABLE public.goals ADD CONSTRAINT goals_shape_check
    CHECK (shape IS NULL OR shape IN ('circle', 'square', 'triangle', 'diamond', 'star', 'hexagon', 'heart'));
