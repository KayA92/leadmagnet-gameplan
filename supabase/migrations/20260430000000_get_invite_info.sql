-- Returns team display info given an invite token.
-- Used by the join prompt so an existing user can see who invited them.
CREATE OR REPLACE FUNCTION public.get_invite_info(p_invite_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_id   uuid;
  v_company   text;
  v_lead_name text;
BEGIN
  SELECT t.id,
         t.company,
         u.first_name
    INTO v_team_id, v_company, v_lead_name
    FROM public.teams t
    JOIN public.users u ON u.id = t.lead_user_id
   WHERE t.invite_token = p_invite_token;

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'Invalid invite token');
  END IF;

  RETURN json_build_object(
    'team_id',   v_team_id,
    'company',   v_company,
    'lead_name', v_lead_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invite_info(text) TO authenticated;
