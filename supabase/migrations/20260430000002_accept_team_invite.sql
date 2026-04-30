-- Atomic invite-accept for both new and existing users.
-- Uses SECURITY DEFINER to bypass RLS on plans and teams.
-- Steps:
--   1. Adds caller to the target team's members (idempotent)
--   2. Updates caller's plan.team_id to the new team
--   3. Removes caller from their old solo team and deletes it if now empty
CREATE OR REPLACE FUNCTION public.accept_team_invite(p_invite_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_team_id uuid;
  v_old_team_id uuid;
BEGIN
  -- Resolve invite token
  SELECT id INTO v_new_team_id
  FROM public.teams
  WHERE invite_token = p_invite_token;

  IF v_new_team_id IS NULL THEN
    RETURN json_build_object('error', 'Invalid invite token');
  END IF;

  -- Capture caller's current team before making changes
  SELECT team_id INTO v_old_team_id
  FROM public.plans
  WHERE user_id = auth.uid()
  LIMIT 1;

  -- Add caller to the new team (idempotent)
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (v_new_team_id, auth.uid(), 'member')
  ON CONFLICT (team_id, user_id) DO NOTHING;

  -- Point caller's plan at the new team
  UPDATE public.plans
  SET team_id = v_new_team_id
  WHERE user_id = auth.uid();

  -- Clean up old team if it was a different solo team
  IF v_old_team_id IS NOT NULL AND v_old_team_id != v_new_team_id THEN
    DELETE FROM public.team_members
    WHERE team_id = v_old_team_id AND user_id = auth.uid();

    IF NOT EXISTS (
      SELECT 1 FROM public.team_members WHERE team_id = v_old_team_id
    ) THEN
      DELETE FROM public.teams WHERE id = v_old_team_id;
    END IF;
  END IF;

  RETURN json_build_object('success', true, 'team_id', v_new_team_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_team_invite(text) TO authenticated;
