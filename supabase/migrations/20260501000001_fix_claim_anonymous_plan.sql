CREATE OR REPLACE FUNCTION public.claim_anonymous_plan(p_plan_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_owner uuid;
BEGIN
  SELECT user_id INTO v_plan_owner
  FROM public.plans
  WHERE id = p_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found: %', p_plan_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_plan_owner
      AND is_anonymous = true
  ) THEN
    RAISE EXCEPTION 'Plan % is not owned by an anonymous user', p_plan_id;
  END IF;

  UPDATE public.plans
  SET user_id = auth.uid()
  WHERE id = p_plan_id;

  UPDATE public.notes
  SET created_by = auth.uid()
  WHERE plan_id = p_plan_id
    AND created_by = v_plan_owner;

  -- Copy profile from anonymous row to authenticated row before deleting.
  -- Covers magic links opened on a different device where pendingPlan is absent.
  INSERT INTO public.users (id, email, first_name, last_name, company, marketing_opt_in)
  SELECT auth.uid(), email, first_name, last_name, company, marketing_opt_in
  FROM public.users
  WHERE id = v_plan_owner
  ON CONFLICT (id) DO UPDATE SET
    first_name       = CASE WHEN EXCLUDED.first_name != '' THEN EXCLUDED.first_name ELSE public.users.first_name END,
    last_name        = CASE WHEN EXCLUDED.last_name  != '' THEN EXCLUDED.last_name  ELSE public.users.last_name  END,
    company          = COALESCE(EXCLUDED.company, public.users.company),
    marketing_opt_in = EXCLUDED.marketing_opt_in;

  DELETE FROM public.users WHERE id = v_plan_owner;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_anonymous_plan(bigint) TO authenticated;
