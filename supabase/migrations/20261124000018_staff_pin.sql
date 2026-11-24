-- HERMOSA OS 0018: a private 4-digit PIN as the second sign-in step (owner request 2026-11-24).
-- For staff who don't use an authenticator app (first: the general manager). An owner sets the PIN in Users
-- and roles and tells the person privately. Once a person has a PIN, every sign-in needs it before any role
-- works (checked in private.has_role, so the database enforces it, not only the app). A PIN check lasts
-- 12 hours per sign-in session. 5 wrong tries lock the PIN for 15 minutes. PINs are stored hashed (bcrypt).
-- Owners, finance and HR still use the authenticator app. Safe to run more than once.

CREATE TABLE IF NOT EXISTS private.user_pins (
  user_id uuid PRIMARY KEY REFERENCES public.app_users(id),
  pin_hash text NOT NULL,
  set_by uuid NOT NULL REFERENCES public.app_users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  failed integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
CREATE TABLE IF NOT EXISTS private.pin_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON private.user_pins, private.pin_sessions FROM PUBLIC, anon, authenticated;

-- True unless the signed-in person has a PIN and hasn't entered it in this sign-in session.
CREATE OR REPLACE FUNCTION private.pin_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM private.user_pins p JOIN public.app_users u ON u.id = p.user_id
    WHERE u.auth_subject = auth.uid()
      AND NOT EXISTS (SELECT 1 FROM private.pin_sessions s
                      WHERE s.user_id = p.user_id AND s.expires_at > now()
                        AND s.session_id::text = coalesce(auth.jwt() ->> 'session_id', '')))
$$;

CREATE OR REPLACE FUNCTION private.has_role(p_roles text[], p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_grants g
    JOIN public.app_users u ON u.id = g.user_id
    WHERE u.auth_subject = auth.uid()
      AND u.active
      AND g.revoked_at IS NULL
      AND g.role_code = ANY (p_roles)
      AND (g.branch_id IS NULL OR g.branch_id = p_branch)
      AND (p_branch IS NOT NULL OR g.branch_id IS NULL)
      AND (g.role_code NOT IN ('OWNER','FINANCE','HR') OR private.has_mfa())
  ) AND private.pin_ok()
$$;

-- What the app needs to know: does this sign-in still need the PIN?
CREATE OR REPLACE FUNCTION public.my_pin_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'has_pin', EXISTS (SELECT 1 FROM private.user_pins p WHERE p.user_id = private.current_user_id()),
    'verified', private.pin_ok(),
    'locked_until', (SELECT p.locked_until FROM private.user_pins p WHERE p.user_id = private.current_user_id() AND p.locked_until > now()))
$$;

CREATE OR REPLACE FUNCTION public.verify_my_pin(p_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); p private.user_pins%ROWTYPE; v_session text := auth.jwt() ->> 'session_id';
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO p FROM private.user_pins WHERE user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'state', 'NO_PIN'); END IF;
  IF v_session IS NULL OR v_session !~ '^[0-9a-fA-F-]{36}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p.locked_until > now() THEN RETURN jsonb_build_object('ok', false, 'error', 'PIN_LOCKED', 'locked_until', p.locked_until); END IF;
  IF coalesce(p_pin, '') !~ '^\d{4}$' OR extensions.crypt(p_pin, p.pin_hash) <> p.pin_hash THEN
    UPDATE private.user_pins SET
      locked_until = CASE WHEN failed + 1 >= 5 THEN now() + interval '15 minutes' END,
      failed = CASE WHEN failed + 1 >= 5 THEN 0 ELSE failed + 1 END
    WHERE user_id = v_user;
    PERFORM private.audit(NULL, 'PIN_FAILED', 'app_user', v_user::text, NULL, NULL);
    RETURN jsonb_build_object('ok', false, 'error', CASE WHEN p.failed + 1 >= 5 THEN 'PIN_LOCKED' ELSE 'PIN_WRONG' END,
      'tries_left', greatest(0, 4 - p.failed));
  END IF;
  UPDATE private.user_pins SET failed = 0, locked_until = NULL WHERE user_id = v_user;
  DELETE FROM private.pin_sessions WHERE expires_at < now() - interval '1 day';
  INSERT INTO private.pin_sessions (session_id, user_id, expires_at) VALUES (v_session::uuid, v_user, now() + interval '12 hours')
  ON CONFLICT (session_id) DO UPDATE SET user_id = excluded.user_id, verified_at = now(), expires_at = excluded.expires_at;
  RETURN jsonb_build_object('ok', true, 'state', 'VERIFIED');
END $$;

-- Owners set or remove someone's PIN (never their own: owners use the authenticator app).
CREATE OR REPLACE FUNCTION public.set_staff_pin(p_user uuid, p_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id();
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'staff_pin',
      CASE WHEN NOT private.has_mfa() AND EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = v_me AND g.revoked_at IS NULL
                                                    AND g.role_code = 'OWNER') THEN 'MFA_REQUIRED' ELSE 'FORBIDDEN' END);
  END IF;
  IF p_user = v_me THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE id = p_user AND organization_id = private.current_org_id() AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_pin IS NULL THEN
    DELETE FROM private.user_pins WHERE user_id = p_user;
    DELETE FROM private.pin_sessions WHERE user_id = p_user;
    PERFORM private.audit(NULL, 'PIN_REMOVED', 'app_user', p_user::text, NULL, NULL);
    RETURN jsonb_build_object('ok', true, 'state', 'REMOVED');
  END IF;
  IF p_pin !~ '^\d{4}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'PIN_FORMAT'); END IF;
  INSERT INTO private.user_pins (user_id, pin_hash, set_by) VALUES (p_user, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), v_me)
  ON CONFLICT (user_id) DO UPDATE SET pin_hash = excluded.pin_hash, set_by = v_me, set_at = now(), failed = 0, locked_until = NULL;
  DELETE FROM private.pin_sessions WHERE user_id = p_user;  -- a new PIN signs them out of the old PIN check
  PERFORM private.audit(NULL, 'PIN_SET', 'app_user', p_user::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'state', 'SET');
END $$;

-- Which staff have a PIN, for the owner's Users page.
CREATE OR REPLACE FUNCTION public.staff_pin_list() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.has_role(ARRAY['OWNER'], NULL)
    THEN coalesce((SELECT jsonb_agg(p.user_id) FROM private.user_pins p JOIN public.app_users u ON u.id = p.user_id
                   WHERE u.organization_id = private.current_org_id()), '[]'::jsonb)
    ELSE '[]'::jsonb END
$$;

REVOKE ALL ON FUNCTION private.pin_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.pin_ok() TO authenticated;
REVOKE ALL ON FUNCTION public.my_pin_status(), public.verify_my_pin(text), public.set_staff_pin(uuid, text), public.staff_pin_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pin_status(), public.verify_my_pin(text), public.set_staff_pin(uuid, text), public.staff_pin_list() TO authenticated;
