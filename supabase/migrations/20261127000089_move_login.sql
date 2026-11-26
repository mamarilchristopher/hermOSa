-- HERMOSA OS 0089: give a staff member a new login without losing her history (owner request 2026-11-27).
-- The staff member registers again with the invite link (new email and password). Her new registration shows
-- under Join requests. The owner picks "Same person as ..." and the new login moves onto her existing account:
-- same AC and ST numbers, roles, PIN, payroll, commissions and records. The extra registration is closed
-- (marked REJECTED) and the old login stops working. Owners only. Owner accounts can't be moved this way.
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.move_login_to_staff(p_pending uuid, p_target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  n public.app_users%ROWTYPE;
  t public.app_users%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN RETURN private.deny(NULL, 'move_login'); END IF;
  IF p_pending = p_target OR v_me IN (p_pending, p_target) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SELF_CHANGE_DENIED');
  END IF;
  SELECT * INTO n FROM public.app_users WHERE id = p_pending AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR n.join_status <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  SELECT * INTO t FROM public.app_users WHERE id = p_target AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR coalesce(t.join_status, 'APPROVED') <> 'APPROVED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER');
  END IF;
  IF EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = p_target AND g.role_code = 'OWNER' AND g.revoked_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'OWNER_LOGIN_LOCKED');
  END IF;

  -- Free the new login from the extra registration (auth_subject is unique), then put it on her account.
  UPDATE public.app_users SET auth_subject = gen_random_uuid(), join_status = 'REJECTED', active = false WHERE id = p_pending;
  UPDATE public.app_users SET auth_subject = n.auth_subject, email = n.email, active = true WHERE id = p_target;

  PERFORM private.audit(NULL, 'LOGIN_MOVED', 'app_user', p_target::text,
    jsonb_build_object('email', t.email, 'active', t.active),
    jsonb_build_object('email', n.email, 'from_request', p_pending));
  RETURN jsonb_build_object('ok', true, 'name', t.display_name);
END $$;

REVOKE ALL ON FUNCTION public.move_login_to_staff(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_login_to_staff(uuid, uuid) TO authenticated;

-- Check: has this already run?
-- select case when exists (select 1 from pg_proc where proname = 'move_login_to_staff')
--   then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;
