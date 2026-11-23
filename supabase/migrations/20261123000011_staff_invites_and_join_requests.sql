-- HERMOSA OS 0011: staff invite links and join requests (owner request 2026-11-23).
-- Flow: the owner makes an invite link -> staff open it and register -> they wait with NO access ->
-- the owner approves and must pick a staff level (and home branch) first -> the role and an employee
-- record are created together. A sign-up that quotes a wrong or expired invite code is refused outright.
-- Requires Supabase Authentication > "Allow new users to sign up" ON (sign-ups land as pending, no access).

ALTER TABLE public.app_users
  ADD COLUMN join_status text NOT NULL DEFAULT 'APPROVED' CHECK (join_status IN ('PENDING','APPROVED','REJECTED')),
  ADD COLUMN requested_branch_id uuid REFERENCES public.branches(id),
  ADD COLUMN invite_id uuid,
  ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE public.staff_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{12,40}$'),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  use_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.app_users ADD CONSTRAINT app_users_invite_fk FOREIGN KEY (invite_id) REFERENCES public.staff_invites(id);
ALTER TABLE public.staff_invites ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.staff_invites TO authenticated;
CREATE POLICY invites_read ON public.staff_invites FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.has_role(ARRAY['OWNER'], NULL));

-- Every new login: pending until the owner approves. An invite code, when given, must be valid.
CREATE OR REPLACE FUNCTION private.on_auth_user_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid; v_code text; v_invite public.staff_invites%ROWTYPE; v_branch uuid;
BEGIN
  v_code := lower(btrim(coalesce(NEW.raw_user_meta_data ->> 'invite_code', '')));
  IF v_code <> '' THEN
    SELECT * INTO v_invite FROM public.staff_invites
    WHERE code = v_code AND revoked_at IS NULL AND expires_at > now();
    IF NOT FOUND THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
    v_org := v_invite.organization_id;
    UPDATE public.staff_invites SET use_count = use_count + 1 WHERE id = v_invite.id;
  ELSE
    SELECT id INTO v_org FROM public.organizations ORDER BY created_at LIMIT 1;
  END IF;
  IF v_org IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_branch FROM public.branches
  WHERE organization_id = v_org AND kind = 'CLINIC' AND id::text = (NEW.raw_user_meta_data ->> 'requested_branch');
  INSERT INTO public.app_users (organization_id, auth_subject, display_name, email, join_status, requested_branch_id, invite_id)
  VALUES (v_org, NEW.id,
          left(coalesce(nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), nullif(NEW.raw_user_meta_data ->> 'display_name', ''),
                        split_part(NEW.email, '@', 1)), 120),
          NEW.email, 'PENDING', v_branch, v_invite.id)
  ON CONFLICT (auth_subject) DO NOTHING;
  RETURN NEW;
END $$;

-- my_access now also says whether the account is still waiting for approval.
CREATE OR REPLACE FUNCTION public.my_access() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'user_id', u.id, 'display_name', u.display_name, 'mfa', private.has_mfa(), 'join_status', u.join_status,
    'needs_mfa', EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL
                         AND g.role_code IN ('OWNER','FINANCE','HR')),
    'grants', coalesce((SELECT jsonb_agg(jsonb_build_object('role', g.role_code, 'branch_id', g.branch_id))
                        FROM public.role_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL), '[]'::jsonb))
  FROM public.app_users u WHERE u.auth_subject = auth.uid() AND u.active
$$;

CREATE FUNCTION public.create_staff_invite(p_days integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id(); v_code text; v_id uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'staff_invite', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  v_code := lower(translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xyz'));
  v_code := regexp_replace(v_code, '[^a-z0-9]', '', 'g');
  INSERT INTO public.staff_invites (organization_id, code, created_by, expires_at)
  VALUES (private.current_org_id(), v_code, v_me, now() + make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90)))
  RETURNING id INTO v_id;
  PERFORM private.audit(NULL, 'STAFF_INVITE_CREATED', 'staff_invite', v_id::text, NULL, jsonb_build_object('days', p_days));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
END $$;

CREATE FUNCTION public.revoke_staff_invite(p_invite uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN RETURN private.deny(NULL, 'staff_invite'); END IF;
  UPDATE public.staff_invites SET revoked_at = now()
  WHERE id = p_invite AND organization_id = private.current_org_id() AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  PERFORM private.audit(NULL, 'STAFF_INVITE_REVOKED', 'staff_invite', p_invite::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Public (signed-out) check used by the join page: is the code valid, and which branches to offer.
CREATE FUNCTION public.staff_invite_info(p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN i.id IS NULL THEN jsonb_build_object('valid', false)
    ELSE jsonb_build_object('valid', true, 'organization', o.name,
      'branches', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name) ORDER BY b.name), '[]'::jsonb)
                   FROM public.branches b WHERE b.organization_id = i.organization_id AND b.kind = 'CLINIC' AND b.active)) END
  FROM (SELECT 1) one
  LEFT JOIN public.staff_invites i ON i.code = lower(btrim(coalesce(p_code, ''))) AND i.revoked_at IS NULL AND i.expires_at > now()
  LEFT JOIN public.organizations o ON o.id = i.organization_id
$$;

-- Approve a join request. The level must be chosen; it sets the role and creates the employee record.
-- Hermosa's positions (owner, 2026-11-23): Owner, General Manager, Senior CMA, CMA.
--   OWNER      -> OWNER, company-wide (needs 2-step sign-in)
--   GM         -> MANAGER for all branches (signs off every branch's commission log)
--   SENIOR_CMA -> CLINICIAN for the home branch, on commission by default
--   CMA        -> CLINICIAN for the home branch, on commission by default
-- Also accepted for later use: MANAGER (one branch), CASHIER (one branch), FINANCE and HR (company-wide).
CREATE FUNCTION public.approve_join_request(p_user uuid, p_level text, p_branch uuid, p_position text, p_commission boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  u public.app_users%ROWTYPE;
  v_role text; v_scope uuid; v_emp uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'join_request', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO u FROM public.app_users WHERE id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER'); END IF;
  IF u.join_status <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF p_user = v_me THEN RETURN private.deny(NULL, 'join_request', 'SELF_ESCALATION_DENIED'); END IF;
  IF p_level IS NULL OR p_level NOT IN ('OWNER','GM','SENIOR_CMA','CMA','MANAGER','CASHIER','FINANCE','HR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEVEL_REQUIRED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BRANCH_REQUIRED');
  END IF;
  v_role := CASE p_level WHEN 'GM' THEN 'MANAGER' WHEN 'SENIOR_CMA' THEN 'CLINICIAN' WHEN 'CMA' THEN 'CLINICIAN' ELSE p_level END;
  v_scope := CASE WHEN p_level IN ('OWNER','GM','FINANCE','HR') THEN NULL ELSE p_branch END;

  INSERT INTO public.role_grants (user_id, role_code, branch_id, granted_by) VALUES (p_user, v_role, v_scope, v_me)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = p_user;
  IF v_emp IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, u.display_name,
            coalesce(nullif(btrim(coalesce(p_position, '')), ''), CASE p_level WHEN 'OWNER' THEN 'Owner' WHEN 'GM' THEN 'General Manager' WHEN 'SENIOR_CMA' THEN 'Senior CMA'
              WHEN 'CMA' THEN 'CMA' WHEN 'MANAGER' THEN 'Branch Manager' WHEN 'CASHIER' THEN 'Front desk'
              WHEN 'FINANCE' THEN 'Finance' ELSE 'HR' END),
            coalesce(p_commission, p_level IN ('SENIOR_CMA','CMA')), p_user, v_me)
    RETURNING id INTO v_emp;
  END IF;
  UPDATE public.app_users SET join_status = 'APPROVED' WHERE id = p_user;
  PERFORM private.audit(v_scope, 'JOIN_APPROVED', 'app_user', p_user::text, jsonb_build_object('join_status', 'PENDING'),
    jsonb_build_object('level', p_level, 'role', v_role, 'branch_id', v_scope, 'home_branch', p_branch, 'employee_id', v_emp));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;

CREATE FUNCTION public.reject_join_request(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id();
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN RETURN private.deny(NULL, 'join_request'); END IF;
  UPDATE public.app_users SET join_status = 'REJECTED', active = false
  WHERE id = p_user AND organization_id = private.current_org_id() AND join_status = 'PENDING' AND id <> v_me;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  PERFORM private.audit(NULL, 'JOIN_REJECTED', 'app_user', p_user::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Pending accounts can never hold roles: granting a role to someone still waiting goes through approval.
CREATE OR REPLACE FUNCTION private.block_pending_grants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_users WHERE id = NEW.user_id AND join_status = 'REJECTED') THEN
    RAISE EXCEPTION 'USER_REJECTED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_grants_block_rejected BEFORE INSERT ON public.role_grants
  FOR EACH ROW EXECUTE FUNCTION private.block_pending_grants();

REVOKE ALL ON FUNCTION public.create_staff_invite(integer), public.revoke_staff_invite(uuid),
  public.approve_join_request(uuid, text, uuid, text, boolean), public.reject_join_request(uuid),
  public.staff_invite_info(text), private.block_pending_grants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_staff_invite(integer), public.revoke_staff_invite(uuid),
  public.approve_join_request(uuid, text, uuid, text, boolean), public.reject_join_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_invite_info(text) TO anon, authenticated;
