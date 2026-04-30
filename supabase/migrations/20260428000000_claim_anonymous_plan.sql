-- Drop old uuid-typed version if it exists from a previous run.
DROP FUNCTION IF EXISTS public.claim_anonymous_plan(uuid);

-- Transfers an anonymous user's plan to the currently authenticated caller.
-- SECURITY DEFINER bypasses RLS so the email user can claim the anon-owned row.
CREATE OR REPLACE FUNCTION public.claim_anonymous_plan(p_plan_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_owner uuid;
BEGIN
  -- Resolve the plan's current owner
  SELECT user_id INTO v_plan_owner
  FROM public.plans
  WHERE id = p_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found: %', p_plan_id;
  END IF;

  -- Only allow claiming plans owned by an anonymous user
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_plan_owner
      AND is_anonymous = true
  ) THEN
    RAISE EXCEPTION 'Plan % is not owned by an anonymous user', p_plan_id;
  END IF;

  -- Transfer plan and any associated notes to the authenticated caller
  UPDATE public.plans
  SET user_id = auth.uid()
  WHERE id = p_plan_id;

  UPDATE public.notes
  SET created_by = auth.uid()
  WHERE plan_id = p_plan_id
    AND created_by = v_plan_owner;

  -- Remove the now-orphaned anonymous user row from public.users
  DELETE FROM public.users WHERE id = v_plan_owner;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_anonymous_plan(bigint) TO authenticated;
