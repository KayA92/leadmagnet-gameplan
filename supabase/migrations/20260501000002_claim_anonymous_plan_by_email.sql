-- Cross-device magic link recovery: when a user opens their magic link on a
-- different device, there's no localStorage pendingPlanId so claim_anonymous_plan
-- is never called. This function finds any orphaned anonymous user whose email
-- matches the now-authenticated caller and transfers everything across.
CREATE OR REPLACE FUNCTION public.claim_anonymous_plan_by_email()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anon_id    uuid;
  v_auth_email text;
BEGIN
  -- Get the authenticated caller's email
  SELECT email INTO v_auth_email
  FROM auth.users
  WHERE id = auth.uid();

  IF v_auth_email IS NULL THEN
    RETURN;
  END IF;

  -- Find an orphaned anonymous user with a matching email in public.users
  SELECT au.id INTO v_anon_id
  FROM auth.users au
  JOIN public.users pu ON pu.id = au.id
  WHERE au.is_anonymous = true
    AND pu.email = v_auth_email
  LIMIT 1;

  IF v_anon_id IS NULL THEN
    -- No orphaned anonymous user found — nothing to do
    RETURN;
  END IF;

  -- Transfer all plans
  UPDATE public.plans
  SET user_id = auth.uid()
  WHERE user_id = v_anon_id;

  -- Transfer all notes
  UPDATE public.notes
  SET created_by = auth.uid()
  WHERE created_by = v_anon_id;

  -- Copy profile to authenticated row (don't overwrite non-empty fields)
  INSERT INTO public.users (id, email, first_name, last_name, company, marketing_opt_in)
  SELECT auth.uid(), email, first_name, last_name, company, marketing_opt_in
  FROM public.users
  WHERE id = v_anon_id
  ON CONFLICT (id) DO UPDATE SET
    first_name       = CASE WHEN EXCLUDED.first_name != '' THEN EXCLUDED.first_name ELSE public.users.first_name END,
    last_name        = CASE WHEN EXCLUDED.last_name  != '' THEN EXCLUDED.last_name  ELSE public.users.last_name  END,
    company          = COALESCE(EXCLUDED.company, public.users.company),
    marketing_opt_in = EXCLUDED.marketing_opt_in;

  -- Remove the orphaned anonymous row
  DELETE FROM public.users WHERE id = v_anon_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_anonymous_plan_by_email() TO authenticated;
