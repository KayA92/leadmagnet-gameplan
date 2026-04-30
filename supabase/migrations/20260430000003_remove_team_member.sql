-- Allows a team lead to remove a member from their team.
-- Clears the removed user's plan.team_id (plan itself is untouched).
-- Only the team lead can call this successfully.
CREATE OR REPLACE FUNCTION public.remove_team_member(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id uuid;
BEGIN
  -- Caller must be a lead
  SELECT team_id INTO v_team_id
  FROM public.team_members
  WHERE user_id = auth.uid() AND role = 'lead'
  LIMIT 1;

  IF v_team_id IS NULL THEN
    RETURN json_build_object('error', 'Not authorised');
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
