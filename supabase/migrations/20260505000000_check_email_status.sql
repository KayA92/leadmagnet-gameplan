CREATE OR REPLACE FUNCTION public.check_email_status(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_has_plan boolean;
BEGIN
  SELECT id INTO v_user_id
  FROM users
  WHERE lower(trim(email)) = lower(trim(p_email))
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('has_account', false, 'has_plan', false);
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM plans WHERE user_id = v_user_id
  ) INTO v_has_plan;

  RETURN jsonb_build_object('has_account', true, 'has_plan', v_has_plan);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_email_status(text) TO anon, authenticated;
