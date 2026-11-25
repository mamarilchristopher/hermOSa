-- update-0035: leave requests (CHRIS, Nov 25 2026). Safe to run more than once.
-- * Staff file VL (vacation leave) or SL (sick leave) for one day or a range, with a reason.
--   VL is filed ahead (today onward); SL can also be filed for the past 14 days (filed on return).
-- * Owners and the General Manager approve (with pay or without pay) or decline with a note.
--   The GM's own leave needs an owner.
-- * On approval the schedule updates by itself: each working day in the range becomes VL or SL
--   (rest days are left alone), and the person and their branch managers get a notice.
-- * Philippine Service Incentive Leave: 5 paid days a year after 1 year of service. The page shows paid
--   leave days used this year so approvers can see it; payroll uses "with pay" days.

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  kind text NOT NULL CHECK (kind IN ('VL','SL')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','DECLINED','CANCELLED')),
  with_pay boolean,
  days integer,
  note text CHECK (note IS NULL OR length(note) <= 300),
  filed_by uuid NOT NULL REFERENCES public.app_users(id),
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz,
  CHECK (end_date >= start_date AND end_date - start_date <= 30)
);
CREATE INDEX IF NOT EXISTS leave_requests_employee ON public.leave_requests (employee_id, start_date);
CREATE INDEX IF NOT EXISTS leave_requests_pending ON public.leave_requests (organization_id) WHERE state = 'PENDING';
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.leave_requests TO authenticated;
DROP POLICY IF EXISTS leave_requests_read ON public.leave_requests;
CREATE POLICY leave_requests_read ON public.leave_requests FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (employee_id = private.my_employee_id() OR private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()
              OR private.can_schedule(employee_id)));

-- Working days in a range: skips rest days (a day off already on the schedule, or the person's usual day off
-- when that day isn't planned yet).
CREATE OR REPLACE FUNCTION private.leave_dates(p_employee uuid, p_start date, p_end date) RETURNS SETOF date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d::date FROM generate_series(p_start, p_end, interval '1 day') d
  WHERE NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.employee_id = p_employee AND s.work_date = d::date
                    AND s.is_off AND s.leave_type IS NULL)
    AND (EXISTS (SELECT 1 FROM public.shifts s WHERE s.employee_id = p_employee AND s.work_date = d::date)
         OR NOT EXISTS (SELECT 1 FROM public.schedule_patterns p WHERE p.employee_id = p_employee
                        AND extract(dow FROM d)::int = ANY (p.days_off)))
$$;
REVOKE ALL ON FUNCTION private.leave_dates(uuid, date, date) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.request_leave(p_kind text, p_start date, p_end date, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_emp uuid; v_name text;
        v_today date := (now() AT TIME ZONE 'Asia/Manila')::date; v_id uuid; v_days int;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT id, full_name INTO v_emp, v_name FROM public.employees WHERE app_user_id = v_user AND active;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF p_kind NOT IN ('VL','SL') OR p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 30
     OR length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF p_end > v_today + 180 OR (p_kind = 'VL' AND p_start < v_today) OR (p_kind = 'SL' AND p_start < v_today - 14) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEAVE_DATES');
  END IF;
  IF EXISTS (SELECT 1 FROM public.leave_requests WHERE employee_id = v_emp AND state IN ('PENDING','APPROVED')
             AND start_date <= p_end AND end_date >= p_start) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEAVE_OVERLAP');
  END IF;
  SELECT count(*) INTO v_days FROM private.leave_dates(v_emp, p_start, p_end);
  INSERT INTO public.leave_requests (organization_id, employee_id, kind, start_date, end_date, reason, filed_by, days)
  VALUES (v_org, v_emp, p_kind, p_start, p_end, left(btrim(p_reason), 500), v_user, v_days) RETURNING id INTO v_id;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT v_org, g.user_id, 'LEAVE_FILED', CASE p_kind WHEN 'VL' THEN 'Vacation leave to approve' ELSE 'Sick leave to approve' END,
    left(v_name || ' filed ' || p_kind || ' for ' || to_char(p_start, 'Mon FMDD')
         || CASE WHEN p_end > p_start THEN ' to ' || to_char(p_end, 'Mon FMDD') ELSE '' END || ': ' || btrim(p_reason), 1000), '/leave', v_user
  FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id AND u.active
  WHERE g.revoked_at IS NULL AND u.organization_id = v_org AND g.user_id <> v_user
    AND (g.role_code = 'OWNER' OR (g.role_code = 'MANAGER' AND g.branch_id IS NULL));
  PERFORM private.audit(NULL, 'LEAVE_FILED', 'leave_request', v_id::text, NULL, jsonb_build_object('kind', p_kind, 'start', p_start, 'end', p_end));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'days', v_days);
END $$;

-- The person withdraws a request nobody has decided yet.
CREATE OR REPLACE FUNCTION public.cancel_leave(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  UPDATE public.leave_requests SET state = 'CANCELLED', decided_at = now()
  WHERE id = p_id AND employee_id = private.my_employee_id() AND state = 'PENDING';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Owners and the GM approve (schedule updates, notices go out) or decline with a note.
CREATE OR REPLACE FUNCTION public.decide_leave(p_id uuid, p_approve boolean, p_with_pay boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.leave_requests%ROWTYPE; v_me uuid := private.current_user_id(); v_owner boolean; v_emp public.employees%ROWTYPE;
        v_days int := 0; d date; v_label text; v_range text;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO r FROM public.leave_requests WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  v_owner := private.has_role(ARRAY['OWNER'], NULL);
  IF NOT (v_owner OR private.is_gm()) THEN RETURN private.deny(NULL, 'leave'); END IF;
  SELECT * INTO v_emp FROM public.employees WHERE id = r.employee_id;
  IF v_emp.app_user_id = v_me AND NOT v_owner THEN RETURN private.deny(NULL, 'leave', 'SELF_APPROVAL_DENIED'); END IF;
  IF r.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  v_label := CASE r.kind WHEN 'VL' THEN 'vacation leave' ELSE 'sick leave' END;
  v_range := to_char(r.start_date, 'Mon FMDD') || CASE WHEN r.end_date > r.start_date THEN ' to ' || to_char(r.end_date, 'Mon FMDD') ELSE '' END;
  IF coalesce(p_approve, false) THEN
    IF p_with_pay IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'PAY_CHOICE_REQUIRED'); END IF;
    FOR d IN SELECT * FROM private.leave_dates(r.employee_id, r.start_date, r.end_date) LOOP
      INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, branch_id, start_time, end_time, state, note, leave_type, updated_by)
      VALUES (r.organization_id, r.employee_id, d, true, NULL, NULL, NULL, 'PUBLISHED', 'Approved ' || r.kind, r.kind, v_me)
      ON CONFLICT (employee_id, work_date) DO UPDATE SET is_off = true, branch_id = NULL, start_time = NULL, end_time = NULL,
        state = 'PUBLISHED', note = excluded.note, leave_type = excluded.leave_type, updated_by = v_me, updated_at = now();
      v_days := v_days + 1;
    END LOOP;
    UPDATE public.leave_requests SET state = 'APPROVED', with_pay = p_with_pay, days = v_days, note = nullif(left(btrim(coalesce(p_note, '')), 300), ''),
      decided_by = v_me, decided_at = now() WHERE id = p_id;
    PERFORM private.notify_employee(r.employee_id, 'LEAVE_APPROVED', 'Your ' || v_label || ' was approved',
      left(v_range || ' (' || v_days || ' working day' || CASE WHEN v_days = 1 THEN '' ELSE 's' END || ', '
           || CASE WHEN p_with_pay THEN 'with pay' ELSE 'without pay' END || '). Your schedule is updated.', 1000),
      '/schedule?week=' || to_char(date_trunc('week', r.start_date), 'YYYY-MM-DD'));
    PERFORM private.notify_management(v_emp.branch_id, 'LEAVE_APPROVED', 'Schedule updated for leave',
      left(v_emp.full_name || ' is on ' || r.kind || ' ' || v_range || '. The schedule was updated.', 1000),
      '/schedule?week=' || to_char(date_trunc('week', r.start_date), 'YYYY-MM-DD'));
  ELSE
    IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
    UPDATE public.leave_requests SET state = 'DECLINED', note = left(btrim(p_note), 300), decided_by = v_me, decided_at = now() WHERE id = p_id;
    PERFORM private.notify_employee(r.employee_id, 'LEAVE_DECLINED', 'Your ' || v_label || ' was not approved',
      left(v_range || ': ' || btrim(p_note), 1000), '/leave');
  END IF;
  PERFORM private.audit(NULL, CASE WHEN p_approve THEN 'LEAVE_APPROVED' ELSE 'LEAVE_DECLINED' END, 'leave_request', p_id::text, NULL,
    jsonb_build_object('with_pay', p_with_pay, 'days', v_days));
  RETURN jsonb_build_object('ok', true, 'days', v_days);
END $$;

REVOKE ALL ON FUNCTION public.request_leave(text, date, date, text), public.cancel_leave(uuid),
  public.decide_leave(uuid, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_leave(text, date, date, text), public.cancel_leave(uuid),
  public.decide_leave(uuid, boolean, boolean, text) TO authenticated;
