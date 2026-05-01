ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.users.marketing_opt_in IS
  'GDPR: explicit opt-in only — true when user ticked the card during wizard sign-up. Default false.';
