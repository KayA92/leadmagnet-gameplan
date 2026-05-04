-- Returns a pending invite waiting for the calling user that they haven't
-- acted on yet (i.e. the invite is for a team they're not already on).
-- SECURITY DEFINER so it can read pending_invites on behalf of a user who
-- is not yet a team member (RLS would block a direct table query).
CREATE OR REPLACE FUNCTION public.get_incoming_invite()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'invite_token', t.invite_token,
    'company',      COALESCE(t.company, 'your colleague'),
    'inviter_name', COALESCE(u.first_name, '')
  )
  FROM public.pending_invites pi
  JOIN public.teams t ON t.id = pi.team_id
  LEFT JOIN public.users u ON u.id = t.lead_user_id
  WHERE lower(pi.email) = lower(
    (SELECT email FROM public.users WHERE id = auth.uid())
  )
  AND pi.team_id IS DISTINCT FROM (
    SELECT team_id FROM public.plans
    WHERE user_id = auth.uid()
    ORDER BY created_at DESC
    LIMIT 1
  )
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_incoming_invite() TO authenticated;
