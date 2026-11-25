-- update-0038: CSR staff level, WFH branch and CSR time-in (CHRIS, Nov 25 2026). Safe to run more than once.
-- * New staff level CSR (customer service: online bookings on Facebook/Instagram). CSRs are contractors on basic pay only
--   (no commission). They can pick it when they register, with "WFH" (work from home) as their branch.
-- * WFH is a work location, not a clinic: it has no sales, no daily sales entry, and isn't in the sales dashboard.
--   CSRs' shifts are planned at WFH, and they time in at WFH with a photo of their PC's clock and date.
-- * CSRs are left out of each clinic's minimum staff when the schedule suggests a week.
-- * Bookings come in the next update.

-- 0. WFH branch (a new kind of branch).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.branches'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE public.branches DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.branches ADD CONSTRAINT branches_kind_check CHECK (kind IN ('CLINIC','HQ','WFH'));
END $$;
INSERT INTO public.branches (organization_id, code, name, kind)
SELECT o.id, 'WFH', 'WFH', 'WFH' FROM public.organizations o
ON CONFLICT (organization_id, code) DO NOTHING;

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS requested_level text;
-- 1. The CSR role.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.role_grants'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%role_code%' LOOP
    EXECUTE format('ALTER TABLE public.role_grants DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.role_grants ADD CONSTRAINT role_grants_role_code_check
    CHECK (role_code IN ('OWNER','FINANCE','MANAGER','CASHIER','HR','MARKETING','CLINICIAN','INVENTORY','AUDITOR','CSR'));
END $$;

CREATE OR REPLACE FUNCTION private.is_csr_employee(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.employees e JOIN public.role_grants g ON g.user_id = e.app_user_id
                 WHERE e.id = p_employee AND g.role_code = 'CSR' AND g.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION private.is_csr_employee(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_csr_employee(uuid) TO authenticated;

-- 2. Joining as a CSR (all branches; home branch is where their shifts are planned).
CREATE OR REPLACE FUNCTION public.approve_join_request(p_user uuid, p_level text, p_branch uuid, p_position text, p_commission boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_owner boolean := private.has_role(ARRAY['OWNER'], NULL);
  u public.app_users%ROWTYPE;
  v_role text; v_scope uuid; v_emp uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_approve_joins() THEN
    RETURN private.deny(NULL, 'join_request', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO u FROM public.app_users WHERE id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER'); END IF;
  IF u.join_status <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF p_user = v_me THEN RETURN private.deny(NULL, 'join_request', 'SELF_ESCALATION_DENIED'); END IF;
  IF p_level IS NULL OR p_level NOT IN ('OWNER','GM','SENIOR_CMA','CMA','TRAINEE','CSR','MANAGER','CASHIER','FINANCE','HR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEVEL_REQUIRED');
  END IF;
  IF NOT v_owner AND p_level = 'OWNER' THEN
    RETURN private.deny(NULL, 'join_request', 'OWNER_ONLY_LEVEL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind IN ('CLINIC','WFH')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BRANCH_REQUIRED');
  END IF;
  v_role := CASE p_level WHEN 'GM' THEN 'MANAGER' WHEN 'SENIOR_CMA' THEN 'CLINICIAN' WHEN 'CMA' THEN 'CLINICIAN' WHEN 'TRAINEE' THEN 'CLINICIAN' ELSE p_level END;
  v_scope := CASE WHEN p_level IN ('OWNER','GM','FINANCE','HR','CSR') THEN NULL ELSE p_branch END;

  INSERT INTO public.role_grants (user_id, role_code, branch_id, granted_by) VALUES (p_user, v_role, v_scope, v_me)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = p_user;
  IF v_emp IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, u.display_name,
            coalesce(nullif(btrim(coalesce(p_position, '')), ''), CASE p_level WHEN 'OWNER' THEN 'Owner' WHEN 'GM' THEN 'General Manager' WHEN 'SENIOR_CMA' THEN 'Senior CMA'
              WHEN 'CMA' THEN 'CMA' WHEN 'TRAINEE' THEN 'Trainee' WHEN 'CSR' THEN 'CSR' WHEN 'MANAGER' THEN 'Branch Manager' WHEN 'CASHIER' THEN 'Front desk'
              WHEN 'FINANCE' THEN 'Finance' ELSE 'HR' END),
            coalesce(p_commission, p_level IN ('SENIOR_CMA','CMA')), p_user, v_me)
    RETURNING id INTO v_emp;
  END IF;
  UPDATE public.app_users SET join_status = 'APPROVED' WHERE id = p_user;
  PERFORM private.audit(v_scope, 'JOIN_APPROVED', 'app_user', p_user::text, jsonb_build_object('join_status', 'PENDING'),
    jsonb_build_object('level', p_level, 'role', v_role, 'branch_id', v_scope, 'home_branch', p_branch, 'employee_id', v_emp));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;

-- 3. Registration, schedule and time clock accept WFH; registration asks for the role.
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
  WHERE organization_id = v_org AND kind IN ('CLINIC','WFH') AND id::text = (NEW.raw_user_meta_data ->> 'requested_branch');
  INSERT INTO public.app_users (organization_id, auth_subject, display_name, email, join_status, requested_branch_id, invite_id, requested_level)
  VALUES (v_org, NEW.id,
          left(coalesce(nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), nullif(NEW.raw_user_meta_data ->> 'display_name', ''),
                        split_part(NEW.email, '@', 1)), 120),
          NEW.email, 'PENDING', v_branch, v_invite.id,
          CASE WHEN NEW.raw_user_meta_data ->> 'requested_level' IN ('SENIOR_CMA','CMA','TRAINEE','CSR','CASHIER','MANAGER','OWNER','OTHER')
               THEN NEW.raw_user_meta_data ->> 'requested_level' END)
  ON CONFLICT (auth_subject) DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.staff_invite_info(p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN i.id IS NULL THEN jsonb_build_object('valid', false)
    ELSE jsonb_build_object('valid', true, 'organization', o.name,
      'branches', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name) ORDER BY b.name), '[]'::jsonb)
                   FROM public.branches b WHERE b.organization_id = i.organization_id AND b.kind IN ('CLINIC','WFH') AND b.active)) END
  FROM (SELECT 1) one
  LEFT JOIN public.staff_invites i ON i.code = lower(btrim(coalesce(p_code, ''))) AND i.revoked_at IS NULL AND i.expires_at > now()
  LEFT JOIN public.organizations o ON o.id = i.organization_id
$$;

CREATE OR REPLACE FUNCTION public.save_schedule_pattern(p_employee uuid, p_branch uuid, p_days_off integer[], p_start time, p_end time) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_schedule(p_employee) THEN RETURN private.deny(NULL, 'schedule'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind IN ('CLINIC','WFH') AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR NOT (coalesce(p_days_off, '{}') <@ ARRAY[0,1,2,3,4,5,6]) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  INSERT INTO public.schedule_patterns (employee_id, organization_id, branch_id, days_off, start_time, end_time, updated_by)
  VALUES (p_employee, private.current_org_id(), p_branch, coalesce(p_days_off, '{}'), p_start, p_end, private.current_user_id())
  ON CONFLICT (employee_id) DO UPDATE SET branch_id = excluded.branch_id, days_off = excluded.days_off,
    start_time = excluded.start_time, end_time = excluded.end_time, updated_by = excluded.updated_by, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.save_shift(p_employee uuid, p_date date, p_off boolean, p_branch uuid, p_start time, p_end time, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old public.shifts%ROWTYPE; v_found boolean;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_schedule(p_employee) THEN RETURN private.deny(NULL, 'schedule'); END IF;
  IF p_date IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  IF NOT coalesce(p_off, false) AND (p_start IS NULL OR p_end IS NULL OR p_end <= p_start
       OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind IN ('CLINIC','WFH') AND active)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO old FROM public.shifts WHERE employee_id = p_employee AND work_date = p_date FOR UPDATE;
  v_found := FOUND;
  INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, branch_id, start_time, end_time, state, note, updated_by)
  VALUES (private.current_org_id(), p_employee, p_date, coalesce(p_off, false),
          CASE WHEN p_off THEN NULL ELSE p_branch END, CASE WHEN p_off THEN NULL ELSE p_start END, CASE WHEN p_off THEN NULL ELSE p_end END,
          'DRAFT', nullif(btrim(coalesce(p_note, '')), ''), private.current_user_id())
  ON CONFLICT (employee_id, work_date) DO UPDATE SET is_off = excluded.is_off, branch_id = excluded.branch_id,
    start_time = excluded.start_time, end_time = excluded.end_time, note = excluded.note, leave_type = NULL,
    updated_by = excluded.updated_by, updated_at = now();
  IF v_found AND old.state = 'PUBLISHED' THEN
    UPDATE public.shifts SET state = 'PUBLISHED' WHERE employee_id = p_employee AND work_date = p_date;
    PERFORM private.notify_employee(p_employee, 'SCHEDULE_CHANGED', 'Your schedule changed',
      to_char(p_date, 'Dy, Mon FMDD') || ': ' || CASE WHEN p_off THEN 'Day off'
        ELSE (SELECT name FROM public.branches WHERE id = p_branch) || ', ' || to_char(p_start, 'FMHH12:MI AM') || ' to ' || to_char(p_end, 'FMHH12:MI AM') END || '.',
      '/schedule?week=' || to_char(date_trunc('week', p_date), 'YYYY-MM-DD'));
  END IF;
  PERFORM private.audit(NULL, 'SHIFT_SAVED', 'shift', p_employee::text || ':' || p_date,
    CASE WHEN v_found THEN to_jsonb(old) END, jsonb_build_object('off', p_off, 'branch', p_branch, 'start', p_start, 'end', p_end));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.clock_punch(p_kind text, p_branch uuid, p_photo text, p_lat double precision, p_lng double precision,
  p_accuracy integer, p_photo_taken_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_emp uuid := private.my_employee_id(); v_kind text := upper(coalesce(p_kind, ''));
  v_date date := (now() AT TIME ZONE 'Asia/Manila')::date; br public.branches%ROWTYPE; v_last text; v_id uuid; v_dist integer;
  v_taken timestamptz := p_photo_taken_at;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF v_kind NOT IN ('IN','OUT') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT * INTO br FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind IN ('CLINIC','WFH') AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH'); END IF;
  IF p_photo IS NULL OR p_photo !~ ('^' || v_user::text || '/[0-9a-f-]{36}\.jpg$') THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_REQUIRED'); END IF;
  -- A photo time years off is a phone with a wrong clock or a broken file: keep it out rather than store nonsense.
  IF v_taken IS NOT NULL AND abs(extract(epoch FROM (v_taken - now()))) > 400 * 86400 THEN v_taken := NULL; END IF;
  SELECT kind INTO v_last FROM public.time_punches WHERE employee_id = v_emp AND work_date = v_date ORDER BY punched_at DESC LIMIT 1;
  IF v_kind = 'IN' AND v_last = 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_IN'); END IF;
  IF v_kind = 'OUT' AND v_last IS DISTINCT FROM 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_IN'); END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND br.lat IS NOT NULL THEN v_dist := private.meters(p_lat, p_lng, br.lat, br.lng); END IF;
  INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, work_date, photo_path, lat, lng, accuracy_m, distance_m, photo_taken_at)
  VALUES (private.current_org_id(), v_emp, v_user, p_branch, v_kind, v_date, p_photo, p_lat, p_lng, p_accuracy, v_dist, v_taken)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'kind', v_kind, 'at', now(), 'distance_m', v_dist);
END $$;

-- Employees can be moved to WFH (CSRs).
CREATE OR REPLACE FUNCTION public.save_employee(p_id uuid, p_branch uuid, p_name text, p_position text, p_commission boolean,
  p_app_user uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  e public.employees%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind IN ('CLINIC','WFH')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','HR','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'employee'); END IF;
  IF coalesce(length(btrim(p_name)), 0) < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  IF p_app_user IS NOT NULL AND NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(p_branch, 'employee.link_login');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, btrim(p_name), nullif(btrim(coalesce(p_position, '')), ''), coalesce(p_commission, true), p_app_user, v_user)
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'EMPLOYEE_ADDED', 'employee', v_id::text, NULL,
      jsonb_build_object('commission_eligible', coalesce(p_commission, true)));
    RETURN jsonb_build_object('ok', true, 'id', v_id);
  END IF;
  SELECT * INTO e FROM public.employees WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','HR','MANAGER'], e.branch_id) THEN RETURN private.deny(e.branch_id, 'employee'); END IF;
  UPDATE public.employees SET branch_id = p_branch, full_name = btrim(p_name),
    position = nullif(btrim(coalesce(p_position, '')), ''), commission_eligible = coalesce(p_commission, e.commission_eligible),
    app_user_id = CASE WHEN private.has_role(ARRAY['OWNER'], NULL) THEN p_app_user ELSE e.app_user_id END,
    active = coalesce(p_active, e.active)
  WHERE id = p_id;
  PERFORM private.audit(p_branch, 'EMPLOYEE_UPDATED', 'employee', p_id::text,
    jsonb_build_object('branch_id', e.branch_id, 'commission_eligible', e.commission_eligible, 'active', e.active),
    jsonb_build_object('branch_id', p_branch, 'commission_eligible', p_commission, 'active', p_active));
  RETURN jsonb_build_object('ok', true, 'id', p_id);
END $$;

-- 4. Schedule: mark CSRs so they are left out of each branch's minimum staff.
CREATE OR REPLACE FUNCTION public.week_schedule(p_monday date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH me AS (SELECT private.my_employee_id() AS id),
  mine AS (SELECT DISTINCT s.branch_id FROM public.shifts s, me
           WHERE s.employee_id = me.id AND s.work_date BETWEEN p_monday AND p_monday + 6 AND s.state = 'PUBLISHED' AND s.branch_id IS NOT NULL
           UNION SELECT e.branch_id FROM public.employees e, me WHERE e.id = me.id),
  wk AS (
    SELECT s.* FROM public.shifts s, me
    WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday AND p_monday + 6
      AND (private.can_schedule(s.employee_id)
           OR (s.state = 'PUBLISHED' AND (s.employee_id = me.id
               OR EXISTS (SELECT 1 FROM public.shifts x WHERE x.employee_id = s.employee_id AND x.work_date BETWEEN p_monday AND p_monday + 6
                          AND x.state = 'PUBLISHED' AND x.branch_id IN (SELECT branch_id FROM mine)))))
  ), ppl AS (
    SELECT e.id, e.full_name, e.position, e.branch_id, private.can_schedule(e.id) AS can_edit,
           private.is_csr_employee(e.id) AS csr FROM public.employees e
    WHERE e.organization_id = private.current_org_id() AND e.active
      AND (private.can_schedule(e.id) OR e.id IN (SELECT employee_id FROM wk) OR e.id = (SELECT id FROM me))
  )
  SELECT jsonb_build_object(
    'me', (SELECT id FROM me),
    'people', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'position', p.position, 'branch_id', p.branch_id,
        'can_edit', p.can_edit, 'csr', p.csr,
        'pattern', CASE WHEN p.can_edit THEN (SELECT jsonb_build_object('branch_id', sp.branch_id, 'days_off', sp.days_off,
                         'start', to_char(sp.start_time, 'HH24:MI'), 'end', to_char(sp.end_time, 'HH24:MI'))
                         FROM public.schedule_patterns sp WHERE sp.employee_id = p.id) END)
        ORDER BY p.full_name) FROM ppl p), '[]'::jsonb),
    'shifts', coalesce((SELECT jsonb_agg(jsonb_build_object('employee_id', w.employee_id, 'date', w.work_date, 'off', w.is_off,
        'branch_id', w.branch_id, 'start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI'),
        'state', w.state, 'note', w.note, 'leave', w.leave_type)) FROM wk w), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'employee_id', r.employee_id, 'name', e.full_name,
        'date', r.work_date, 'other_employee_id', r.other_employee_id, 'other_name', o.full_name, 'other_date', r.other_date,
        'reason', r.reason, 'mine', r.requested_by = private.current_user_id(), 'coworker_state', r.coworker_state,
        'can_respond', r.kind = 'SWAP' AND r.coworker_state = 'WAITING' AND r.other_employee_id = me.id,
        'can_decide', CASE WHEN r.kind = 'SWAP'
            THEN r.coworker_state = 'ACCEPTED' AND private.swap_approver(r.employee_id, r.other_employee_id)
            ELSE private.can_schedule(r.employee_id) AND r.requested_by <> private.current_user_id() END,
        'created_at', r.created_at) ORDER BY r.created_at)
        FROM public.schedule_requests r JOIN public.employees e ON e.id = r.employee_id
        LEFT JOIN public.employees o ON o.id = r.other_employee_id, me
        WHERE r.organization_id = private.current_org_id() AND r.state = 'PENDING'
          AND (r.requested_by = private.current_user_id() OR r.other_employee_id = me.id OR private.can_schedule(r.employee_id)
               OR private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm())), '[]'::jsonb))
$$;

REVOKE ALL ON FUNCTION public.save_shift(uuid, date, boolean, uuid, time, time, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_shift(uuid, date, boolean, uuid, time, time, text) TO authenticated;
