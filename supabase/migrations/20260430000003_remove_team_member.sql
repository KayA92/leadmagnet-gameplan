-- Allows any team member to remove another member from the shared team.
-- Clears the removed user's plan.team_id (plan itself is untouched).
-- Any authenticated team member can call this — there is no lead-only gate.
CREATE OR REPLACE FUNCTION public.remove_team_member(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id uuid;
BEGIN
  -- Caller must be in a team
  SELECT team_id INTO v_team_id
  FROM public.team_members
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF v_team_id IS NULL THEN
    RETURN json_build_object('error', 'Not a team member');
  END IF;

  IF p_user_id = auth.uid() THEN
    RETURN json_build_object('error', 'Cannot remove yourself');
  END IF;

  -- Remove from team
  DELETE FROM public.team_members
  WHERE team_id = v_team_id AND user_id = p_user_id;

  -- Detach their plan from the team (does not delete the plan)
  UPDATE public.plans
  SET team_id = NULL
  WHERE user_id = p_user_id AND team_id = v_team_id;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_team_member(uuid) TO authenticated;
