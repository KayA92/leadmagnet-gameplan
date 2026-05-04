-- Capture full Stage-5b firm context + Stage-1 pain slugs on the plan row.
-- Currently the wizard only persists `problem` (a humanised comma-joined
-- pain-label string) plus role/categories/time_window. Stage-5b firm size +
-- firm mode and Stage-1 pain slugs were never written to the DB, so the Team
-- tab can't show them. Adds three nullable columns; existing rows stay null.
--
-- All three are slugs as captured by the wizard (see js/wizard.js):
--   pains      text[] e.g. {'mtd-volume','margin','docs'}
--   firm_size  text   one of: 'solo' | '2-10' | '11-50' | '50+' | 'industry'
--   firm_mode  text   one of: 'grow' | 'optimise' | 'niche' | 'exit' | 'explore'

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS pains     text[],
  ADD COLUMN IF NOT EXISTS firm_size text,
  ADD COLUMN IF NOT EXISTS firm_mode text;
