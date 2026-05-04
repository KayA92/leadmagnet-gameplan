-- Revoke the default PostgreSQL PUBLIC execute grant from all SECURITY DEFINER
-- functions. PostgreSQL grants EXECUTE to PUBLIC by default on creation; the
-- existing GRANT TO authenticated in each function's own migration does not
-- revoke that default. After this migration:
--   - anonymous / unauthenticated callers cannot invoke these functions
--   - authenticated users retain full access (existing grants unchanged)

REVOKE EXECUTE ON FUNCTION public.accept_team_invite(text)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_anonymous_plan(bigint)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_anonymous_plan_by_email()    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_incoming_invite()              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_invite_info(text)              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.remove_team_member(uuid)           FROM PUBLIC;

-- The three functions below were created directly in Supabase Studio (not via
-- a prior migration). REVOKE/GRANT is safe to run without knowing the body.
-- NOTE: get_my_team_ids also has a "Function Search Path Mutable" warning —
-- to fully fix that, recreate the function with SET search_path = public once
-- you have its body from Studio (Database → Functions).
REVOKE EXECUTE ON FUNCTION public.get_my_team_ids()                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_user_team_ids()               FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.join_team(text)                    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_my_team_ids()                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_team_ids()                TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_team(text)                     TO authenticated;
