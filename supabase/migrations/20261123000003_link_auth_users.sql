-- HERMOSA OS 0003: every Supabase login gets an app_users row with NO roles.
-- The owner then grants roles in Hermosa OS (Users page). A login without roles can see nothing.
-- Public sign-up must stay DISABLED in Supabase (Authentication > Sign In / Providers);
-- staff are added by the owner from the Supabase dashboard (Authentication > Users > Add user / Invite).

CREATE FUNCTION private.on_auth_user_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  SELECT id INTO v_org FROM public.organizations ORDER BY created_at LIMIT 1;
  IF v_org IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.app_users (organization_id, auth_subject, display_name, email)
  VALUES (v_org, NEW.id,
          coalesce(nullif(NEW.raw_user_meta_data ->> 'display_name', ''), split_part(NEW.email, '@', 1)),
          NEW.email)
  ON CONFLICT (auth_subject) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.on_auth_user_created();

-- Owner can rename staff or deactivate a login (deactivated = no access at all).
CREATE FUNCTION public.update_staff_user(p_user uuid, p_display_name text, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id(); u public.app_users%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'app_user', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO u FROM public.app_users WHERE id = p_user AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER'); END IF;
  IF p_user = v_me AND p_active IS FALSE THEN RETURN jsonb_build_object('ok', false, 'error', 'SELF_CHANGE_DENIED'); END IF;
  IF length(btrim(coalesce(p_display_name, ''))) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  UPDATE public.app_users SET display_name = btrim(p_display_name), active = coalesce(p_active, active) WHERE id = p_user;
  PERFORM private.audit(NULL, 'USER_UPDATED', 'app_user', p_user::text,
    jsonb_build_object('display_name', u.display_name, 'active', u.active),
    jsonb_build_object('display_name', btrim(p_display_name), 'active', coalesce(p_active, u.active)));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION private.on_auth_user_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_staff_user(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_staff_user(uuid, text, boolean) TO authenticated;
