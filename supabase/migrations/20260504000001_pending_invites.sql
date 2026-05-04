-- Persistent pending-invite tracking.
-- Previously, pending invites were stored only in localStorage, meaning they
-- vanished when the team lead switched browsers/devices and were invisible to
-- other team members. This table makes them shared and durable.
--
-- Records are written when a magic-link invite is sent (or resent) and
-- deleted either by the sender (Cancel button) or automatically when the
-- invitee calls accept_team_invite().

-- email is stored lowercase-normalised on insert so a plain unique
-- constraint covers case-insensitive deduplication without a functional index.
CREATE TABLE IF NOT EXISTS public.pending_invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid        NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  email       text        NOT NULL,
  invited_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, email)
);

ALTER TABLE public.pending_invites ENABLE ROW LEVEL SECURITY;

-- Any authenticated team member can read, write and delete pending invites
-- for their own team.
CREATE POLICY "team members select pending_invites"
  ON public.pending_invites FOR SELECT
  USING (team_id IN (
    SELECT team_id FROM public.team_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "team members insert pending_invites"
  ON public.pending_invites FOR INSERT
  WITH CHECK (team_id IN (
    SELECT team_id FROM public.team_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "team members update pending_invites"
  ON public.pending_invites FOR UPDATE
  USING (team_id IN (
    SELECT team_id FROM public.team_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "team members delete pending_invites"
  ON public.pending_invites FOR DELETE
  USING (team_id IN (
    SELECT team_id FROM public.team_members WHERE user_id = auth.uid()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_invites TO authenticated;

-- ── Update accept_team_invite to clean up the pending invite on join ──────────
-- When an invitee accepts, remove their row from pending_invites so the
-- team lead's "Sent invites" list clears automatically.
-- The function is SECURITY DEFINER so it bypasses RLS on pending_invites safely.
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

  -- Remove the caller's pending invite row so the team lead's list
  -- clears automatically on next page load.
  DELETE FROM public.pending_invites
  WHERE team_id = v_new_team_id
    AND email = lower((SELECT email FROM public.users WHERE id = auth.uid()));

  RETURN json_build_object('success', true, 'team_id', v_new_team_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_team_invite(text) TO authenticated;
