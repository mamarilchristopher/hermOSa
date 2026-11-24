-- HERMOSA OS 0022: weekly schedule, swaps / day-off changes, time in / out, and On Duty today
-- (owner request 2026-11-25). Safe to run more than once.
-- * Each employee has a usual pattern (home branch, days off, hours; clinics open 10 AM to 7 PM).
--   A manager generates a week from the patterns, adjusts any day, and publishes it. Staff then see it.
-- * Staff ask to swap a day with someone or move their day off; an owner or manager (not the asker) approves,
--   and the schedule updates. Every change to a published day notifies the staff member.
-- * Time in / out happens in the app: the database stamps the time (the phone's clock is not used), with a
--   selfie and the phone's location. Late = time in after the shift start (plus the grace minutes).
-- * Owners and managers see On Duty today: who is scheduled at each branch, who timed in, who is late.
-- Owners = company-wide; managers = their branches (the general manager has all branches).

ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS late_grace_minutes integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.schedule_patterns (
  employee_id uuid PRIMARY KEY REFERENCES public.employees(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  days_off integer[] NOT NULL DEFAULT '{}' CHECK (days_off <@ ARRAY[0,1,2,3,4,5,6]),  -- 0 = Sunday
  start_time time NOT NULL DEFAULT '10:00',
  end_time time NOT NULL DEFAULT '19:00',
  updated_by uuid NOT NULL REFERENCES public.app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS public.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  work_date date NOT NULL,
  is_off boolean NOT NULL DEFAULT false,
  branch_id uuid REFERENCES public.branches(id),
  start_time time,
  end_time time,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','PUBLISHED')),
  note text CHECK (note IS NULL OR length(note) <= 200),
  updated_by uuid NOT NULL REFERENCES public.app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date),
  CHECK (is_off OR (branch_id IS NOT NULL AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
);
CREATE INDEX IF NOT EXISTS shifts_date ON public.shifts (work_date);

CREATE TABLE IF NOT EXISTS public.schedule_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  kind text NOT NULL CHECK (kind IN ('SWAP','DAY_OFF')),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  work_date date NOT NULL,                                  -- SWAP: the day swapped; DAY_OFF: the day off to work instead
  other_employee_id uuid REFERENCES public.employees(id),   -- SWAP: who they swap with
  other_date date,                                          -- DAY_OFF: the new day off
  reason text CHECK (reason IS NULL OR length(reason) <= 300),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  CHECK ((kind = 'SWAP' AND other_employee_id IS NOT NULL) OR (kind = 'DAY_OFF' AND other_date IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.time_punches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  kind text NOT NULL CHECK (kind IN ('IN','OUT')),
  punched_at timestamptz NOT NULL DEFAULT now(),
  work_date date NOT NULL,
  photo_path text CHECK (photo_path IS NULL OR photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'),
  lat double precision, lng double precision, accuracy_m integer,
  distance_m integer
);
CREATE INDEX IF NOT EXISTS time_punches_date ON public.time_punches (work_date, employee_id);

ALTER TABLE public.schedule_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_punches ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.schedule_patterns, public.shifts, public.schedule_requests, public.time_punches TO authenticated;

-- Who may run the schedule for an employee: owners, and managers of the employee's home branch (GM = all).
CREATE OR REPLACE FUNCTION private.can_schedule(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = p_employee AND e.organization_id = private.current_org_id()
                   AND (private.has_role(ARRAY['OWNER'], NULL) OR private.has_role(ARRAY['OWNER','MANAGER'], e.branch_id)))
$$;
CREATE OR REPLACE FUNCTION private.my_employee_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id FROM public.employees e WHERE e.app_user_id = private.current_user_id() AND e.active ORDER BY e.created_at LIMIT 1
$$;

DROP POLICY IF EXISTS schedule_patterns_read ON public.schedule_patterns;
CREATE POLICY schedule_patterns_read ON public.schedule_patterns FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (private.can_schedule(employee_id) OR employee_id = private.my_employee_id()));
-- Published days are the clinic's posted schedule: everyone in the company sees them. Drafts: schedulers only.
DROP POLICY IF EXISTS shifts_read ON public.shifts;
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (state = 'PUBLISHED' OR private.can_schedule(employee_id)));
DROP POLICY IF EXISTS schedule_requests_read ON public.schedule_requests;
CREATE POLICY schedule_requests_read ON public.schedule_requests FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (requested_by = private.current_user_id()
         OR other_employee_id = private.my_employee_id() OR private.can_schedule(employee_id)));
DROP POLICY IF EXISTS time_punches_read ON public.time_punches;
CREATE POLICY time_punches_read ON public.time_punches FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (user_id = private.current_user_id() OR private.can_schedule(employee_id)));

-- Tell one employee (if they have a login) something about their schedule.
CREATE OR REPLACE FUNCTION private.notify_employee(p_employee uuid, p_kind text, p_title text, p_body text, p_link text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT e.organization_id, e.app_user_id, p_kind, left(p_title, 200), left(p_body, 1000), p_link, private.current_user_id()
  FROM public.employees e WHERE e.id = p_employee AND e.app_user_id IS NOT NULL AND e.app_user_id IS DISTINCT FROM private.current_user_id()
$$;

CREATE OR REPLACE FUNCTION public.save_schedule_pattern(p_employee uuid, p_branch uuid, p_days_off integer[], p_start time, p_end time) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_schedule(p_employee) THEN RETURN private.deny(NULL, 'schedule'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind = 'CLINIC' AND active) THEN
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

-- Fill a week (Monday to Sunday) from the patterns, as a draft. Days already planned are kept.
CREATE OR REPLACE FUNCTION public.generate_week(p_monday date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_monday IS NULL OR extract(isodow FROM p_monday) <> 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, branch_id, start_time, end_time, state, updated_by)
  SELECT p.organization_id, p.employee_id, d::date, extract(dow FROM d)::int = ANY (p.days_off),
         CASE WHEN extract(dow FROM d)::int = ANY (p.days_off) THEN NULL ELSE p.branch_id END,
         CASE WHEN extract(dow FROM d)::int = ANY (p.days_off) THEN NULL ELSE p.start_time END,
         CASE WHEN extract(dow FROM d)::int = ANY (p.days_off) THEN NULL ELSE p.end_time END,
         'DRAFT', private.current_user_id()
  FROM public.schedule_patterns p JOIN public.employees e ON e.id = p.employee_id AND e.active
  CROSS JOIN generate_series(p_monday, p_monday + 6, interval '1 day') d
  WHERE p.organization_id = private.current_org_id() AND private.can_schedule(p.employee_id)
  ON CONFLICT (employee_id, work_date) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM private.audit(NULL, 'SCHEDULE_GENERATED', 'schedule_week', p_monday::text, NULL, jsonb_build_object('days', v_n));
  RETURN jsonb_build_object('ok', true, 'created', v_n);
END $$;

-- Set one person's day: a branch and hours, or a day off. A change to a published day notifies them.
CREATE OR REPLACE FUNCTION public.save_shift(p_employee uuid, p_date date, p_off boolean, p_branch uuid, p_start time, p_end time, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old public.shifts%ROWTYPE; v_found boolean;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_schedule(p_employee) THEN RETURN private.deny(NULL, 'schedule'); END IF;
  IF p_date IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  IF NOT coalesce(p_off, false) AND (p_start IS NULL OR p_end IS NULL OR p_end <= p_start
       OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind = 'CLINIC' AND active)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO old FROM public.shifts WHERE employee_id = p_employee AND work_date = p_date FOR UPDATE;
  v_found := FOUND;
  INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, branch_id, start_time, end_time, state, note, updated_by)
  VALUES (private.current_org_id(), p_employee, p_date, coalesce(p_off, false),
          CASE WHEN p_off THEN NULL ELSE p_branch END, CASE WHEN p_off THEN NULL ELSE p_start END, CASE WHEN p_off THEN NULL ELSE p_end END,
          'DRAFT', nullif(btrim(coalesce(p_note, '')), ''), private.current_user_id())
  ON CONFLICT (employee_id, work_date) DO UPDATE SET is_off = excluded.is_off, branch_id = excluded.branch_id,
    start_time = excluded.start_time, end_time = excluded.end_time, note = excluded.note,
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

-- Publish a week: staff see it and get a notice.
CREATE OR REPLACE FUNCTION public.publish_week(p_monday date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer; r record;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_monday IS NULL OR extract(isodow FROM p_monday) <> 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','MANAGER'], NULL) AND NOT EXISTS (
       SELECT 1 FROM public.branches b WHERE b.organization_id = private.current_org_id() AND private.has_role(ARRAY['MANAGER'], b.id)) THEN
    RETURN private.deny(NULL, 'schedule');
  END IF;
  WITH up AS (
    UPDATE public.shifts s SET state = 'PUBLISHED', updated_at = now()
    WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday AND p_monday + 6
      AND s.state = 'DRAFT' AND private.can_schedule(s.employee_id)
    RETURNING s.employee_id)
  SELECT count(*) INTO v_n FROM up;
  FOR r IN SELECT DISTINCT s.employee_id FROM public.shifts s
           WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday AND p_monday + 6 AND private.can_schedule(s.employee_id) LOOP
    PERFORM private.notify_employee(r.employee_id, 'SCHEDULE_PUBLISHED', 'Schedule is out',
      'Week of ' || to_char(p_monday, 'Mon FMDD') || ' to ' || to_char(p_monday + 6, 'Mon FMDD') || '.',
      '/schedule?week=' || to_char(p_monday, 'YYYY-MM-DD'));
  END LOOP;
  PERFORM private.audit(NULL, 'SCHEDULE_PUBLISHED', 'schedule_week', p_monday::text, NULL, jsonb_build_object('days', v_n));
  RETURN jsonb_build_object('ok', true, 'published', v_n);
END $$;

-- Staff: swap a day with someone, or move a day off. Both days must be on the published schedule.
CREATE OR REPLACE FUNCTION public.request_schedule_change(p_kind text, p_date date, p_other_employee uuid, p_other_date date, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.my_employee_id(); a public.shifts%ROWTYPE; b public.shifts%ROWTYPE; v_id uuid;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF p_date IS NULL OR p_date < (now() AT TIME ZONE 'Asia/Manila')::date THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  SELECT * INTO a FROM public.shifts WHERE employee_id = v_me AND work_date = p_date AND state = 'PUBLISHED';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
  IF upper(p_kind) = 'SWAP' THEN
    IF p_other_employee IS NULL OR p_other_employee = v_me THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
    SELECT * INTO b FROM public.shifts WHERE employee_id = p_other_employee AND work_date = p_date AND state = 'PUBLISHED'
      AND organization_id = private.current_org_id();
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
    IF (a.is_off, a.branch_id, a.start_time, a.end_time) IS NOT DISTINCT FROM (b.is_off, b.branch_id, b.start_time, b.end_time) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SAME_SHIFT');
    END IF;
    p_other_date := NULL;
  ELSIF upper(p_kind) = 'DAY_OFF' THEN
    IF NOT a.is_off THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_DAY_OFF'); END IF;
    IF p_other_date IS NULL OR p_other_date = p_date OR p_other_date < (now() AT TIME ZONE 'Asia/Manila')::date THEN
      RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
    END IF;
    SELECT * INTO b FROM public.shifts WHERE employee_id = v_me AND work_date = p_other_date AND state = 'PUBLISHED' AND NOT is_off;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
    p_other_employee := NULL;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  INSERT INTO public.schedule_requests (organization_id, kind, employee_id, work_date, other_employee_id, other_date, reason, requested_by)
  VALUES (private.current_org_id(), upper(p_kind), v_me, p_date, p_other_employee, p_other_date,
          nullif(left(btrim(coalesce(p_reason, '')), 300), ''), private.current_user_id())
  RETURNING id INTO v_id;
  PERFORM private.notify_management(a.branch_id, 'SCHEDULE_REQUEST', 'Schedule change request',
    coalesce((SELECT full_name FROM public.employees WHERE id = v_me), 'Someone') || ': ' ||
    CASE WHEN upper(p_kind) = 'SWAP' THEN 'swap ' || to_char(p_date, 'Dy, Mon FMDD') || ' with ' || coalesce((SELECT full_name FROM public.employees WHERE id = p_other_employee), 'someone')
         ELSE 'work ' || to_char(p_date, 'Dy, Mon FMDD') || ' and take ' || to_char(p_other_date, 'Dy, Mon FMDD') || ' off' END || '.',
    '/schedule?week=' || to_char(date_trunc('week', p_date), 'YYYY-MM-DD'));
  IF upper(p_kind) = 'SWAP' THEN
    PERFORM private.notify_employee(p_other_employee, 'SCHEDULE_REQUEST', 'Swap request',
      coalesce((SELECT full_name FROM public.employees WHERE id = v_me), 'Someone') || ' asked to swap ' || to_char(p_date, 'Dy, Mon FMDD') || ' with you. A manager will decide.',
      '/schedule?week=' || to_char(date_trunc('week', p_date), 'YYYY-MM-DD'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'state', 'PENDING');
END $$;

CREATE OR REPLACE FUNCTION public.decide_schedule_request(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE q public.schedule_requests%ROWTYPE; a public.shifts%ROWTYPE; b public.shifts%ROWTYPE; v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO q FROM public.schedule_requests WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.can_schedule(q.employee_id) THEN RETURN private.deny(NULL, 'schedule.decide'); END IF;
  IF q.requested_by = v_user THEN RETURN private.deny(NULL, 'schedule.decide', 'SELF_APPROVAL_DENIED'); END IF;
  IF q.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF NOT coalesce(p_approve, false) THEN
    IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
    UPDATE public.schedule_requests SET state = 'REJECTED', decided_by = v_user, decided_at = now(), decision_note = left(btrim(p_note), 300) WHERE id = p_id;
    PERFORM private.notify_employee(q.employee_id, 'SCHEDULE_REQUEST', 'Schedule request not approved', left(btrim(p_note), 300), '/schedule');
    RETURN jsonb_build_object('ok', true, 'state', 'REJECTED');
  END IF;
  SELECT * INTO a FROM public.shifts WHERE employee_id = q.employee_id AND work_date = q.work_date FOR UPDATE;
  IF q.kind = 'SWAP' THEN
    SELECT * INTO b FROM public.shifts WHERE employee_id = q.other_employee_id AND work_date = q.work_date FOR UPDATE;
    IF a.id IS NULL OR b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
    UPDATE public.shifts SET is_off = b.is_off, branch_id = b.branch_id, start_time = b.start_time, end_time = b.end_time,
      note = 'Swapped', updated_by = v_user, updated_at = now() WHERE id = a.id;
    UPDATE public.shifts SET is_off = a.is_off, branch_id = a.branch_id, start_time = a.start_time, end_time = a.end_time,
      note = 'Swapped', updated_by = v_user, updated_at = now() WHERE id = b.id;
    PERFORM private.notify_employee(q.other_employee_id, 'SCHEDULE_CHANGED', 'Swap approved',
      to_char(q.work_date, 'Dy, Mon FMDD') || ': your schedule was swapped.', '/schedule?week=' || to_char(date_trunc('week', q.work_date), 'YYYY-MM-DD'));
  ELSE
    SELECT * INTO b FROM public.shifts WHERE employee_id = q.employee_id AND work_date = q.other_date FOR UPDATE;
    IF a.id IS NULL OR b.id IS NULL OR NOT a.is_off OR b.is_off THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
    UPDATE public.shifts SET is_off = false, branch_id = b.branch_id, start_time = b.start_time, end_time = b.end_time,
      note = 'Day off moved', updated_by = v_user, updated_at = now() WHERE id = a.id;
    UPDATE public.shifts SET is_off = true, branch_id = NULL, start_time = NULL, end_time = NULL,
      note = 'Day off moved', updated_by = v_user, updated_at = now() WHERE id = b.id;
  END IF;
  UPDATE public.schedule_requests SET state = 'APPROVED', decided_by = v_user, decided_at = now(),
    decision_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') WHERE id = p_id;
  PERFORM private.notify_employee(q.employee_id, 'SCHEDULE_CHANGED', 'Schedule request approved',
    to_char(q.work_date, 'Dy, Mon FMDD') || CASE WHEN q.kind = 'SWAP' THEN ' swapped.' ELSE ' is now a work day; ' || to_char(q.other_date, 'Dy, Mon FMDD') || ' is your day off.' END,
    '/schedule?week=' || to_char(date_trunc('week', q.work_date), 'YYYY-MM-DD'));
  PERFORM private.audit(NULL, 'SCHEDULE_REQUEST_APPROVED', 'schedule_request', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'state', 'APPROVED');
END $$;

CREATE OR REPLACE FUNCTION public.cancel_schedule_request(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.schedule_requests SET state = 'CANCELLED' WHERE id = p_id AND requested_by = private.current_user_id() AND state = 'PENDING';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Distance in meters between two points (haversine).
CREATE OR REPLACE FUNCTION private.meters(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT round(2 * 6371000 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
         + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::integer
$$;

-- Time in / out. The database's clock is the time on record. The photo is uploaded first to the private
-- "timeclock" storage folder named after the person's own id.
CREATE OR REPLACE FUNCTION public.clock_punch(p_kind text, p_branch uuid, p_photo text, p_lat double precision, p_lng double precision, p_accuracy integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_emp uuid := private.my_employee_id(); v_kind text := upper(coalesce(p_kind, ''));
  v_date date := (now() AT TIME ZONE 'Asia/Manila')::date; br public.branches%ROWTYPE; v_last text; v_id uuid; v_dist integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF v_kind NOT IN ('IN','OUT') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT * INTO br FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind = 'CLINIC' AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH'); END IF;
  IF p_photo IS NULL OR p_photo !~ ('^' || v_user::text || '/[0-9a-f-]{36}\.jpg$') THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_REQUIRED'); END IF;
  SELECT kind INTO v_last FROM public.time_punches WHERE employee_id = v_emp AND work_date = v_date ORDER BY punched_at DESC LIMIT 1;
  IF v_kind = 'IN' AND v_last = 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_IN'); END IF;
  IF v_kind = 'OUT' AND v_last IS DISTINCT FROM 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_IN'); END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND br.lat IS NOT NULL THEN v_dist := private.meters(p_lat, p_lng, br.lat, br.lng); END IF;
  INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, work_date, photo_path, lat, lng, accuracy_m, distance_m)
  VALUES (private.current_org_id(), v_emp, v_user, p_branch, v_kind, v_date, p_photo, p_lat, p_lng, p_accuracy, v_dist)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'kind', v_kind, 'at', now(), 'distance_m', v_dist);
END $$;

-- Owners and managers save a branch's location from a phone standing in the clinic.
CREATE OR REPLACE FUNCTION public.set_branch_location(p_branch uuid, p_lat double precision, p_lng double precision) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.has_role(ARRAY['OWNER','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'branch_location'); END IF;
  IF p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  UPDATE public.branches SET lat = p_lat, lng = p_lng WHERE id = p_branch AND organization_id = private.current_org_id();
  PERFORM private.audit(p_branch, 'BRANCH_LOCATION_SET', 'branch', p_branch::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- On Duty for a day: everyone scheduled (published) or who timed in, per branch, with first in / last out
-- and minutes late. Owners see all branches, managers their branches.
CREATE OR REPLACE FUNCTION public.on_duty(p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH people AS (
    SELECT s.employee_id, s.branch_id, s.start_time, s.end_time, s.is_off, s.note FROM public.shifts s
    WHERE s.organization_id = private.current_org_id() AND s.work_date = p_date AND s.state = 'PUBLISHED'
    UNION
    SELECT DISTINCT ON (t.employee_id) t.employee_id, t.branch_id, NULL::time, NULL::time, false, 'Not on the schedule'
    FROM public.time_punches t
    WHERE t.organization_id = private.current_org_id() AND t.work_date = p_date
      AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.employee_id = t.employee_id AND s.work_date = p_date AND s.state = 'PUBLISHED' AND NOT s.is_off)
    ORDER BY 1
  ), grace AS (SELECT late_grace_minutes AS g FROM public.organizations WHERE id = private.current_org_id())
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', p.employee_id, 'name', e.full_name, 'position', e.position, 'branch_id', p.branch_id,
      'off', p.is_off, 'start', p.start_time, 'end', p.end_time, 'note', p.note,
      'time_in', i.punched_at, 'time_out', o.punched_at, 'in_photo', i.photo_path, 'in_distance_m', i.distance_m,
      'late_min', CASE WHEN p.start_time IS NOT NULL AND i.punched_at IS NOT NULL
                       THEN greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (p_date + p.start_time))) / 60)::int
                                       - (SELECT g FROM grace)) END)
    ORDER BY p.is_off, e.full_name), '[]'::jsonb)
  FROM people p JOIN public.employees e ON e.id = p.employee_id
  LEFT JOIN LATERAL (SELECT t.punched_at, t.photo_path, t.distance_m FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'IN' ORDER BY t.punched_at LIMIT 1) i ON true
  LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'OUT' ORDER BY t.punched_at DESC LIMIT 1) o ON true
  WHERE private.can_schedule(p.employee_id)
$$;

-- Lateness for a period (a payroll cutoff), per person, for owners and managers.
CREATE OR REPLACE FUNCTION public.attendance(p_start date, p_end date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'name'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('employee_id', e.id, 'name', e.full_name,
      'scheduled', count(*) FILTER (WHERE NOT s.is_off),
      'present', count(i.punched_at) FILTER (WHERE NOT s.is_off),
      'absent', count(*) FILTER (WHERE NOT s.is_off AND i.punched_at IS NULL AND s.work_date < (now() AT TIME ZONE 'Asia/Manila')::date),
      'late_days', count(*) FILTER (WHERE NOT s.is_off AND (i.punched_at AT TIME ZONE 'Asia/Manila') > s.work_date + s.start_time
                                       + make_interval(mins => (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()))),
      'late_min', coalesce(sum(greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (s.work_date + s.start_time))) / 60)::int
                       - (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()))) FILTER (WHERE NOT s.is_off), 0)) AS x
    FROM public.shifts s JOIN public.employees e ON e.id = s.employee_id
    LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = s.employee_id AND t.work_date = s.work_date AND t.kind = 'IN'
                       ORDER BY t.punched_at LIMIT 1) i ON true
    WHERE s.organization_id = private.current_org_id() AND s.state = 'PUBLISHED' AND s.work_date BETWEEN p_start AND p_end
      AND p_end - p_start <= 62 AND private.can_schedule(s.employee_id)
    GROUP BY e.id, e.full_name) y
$$;

-- One week for the Schedule page, with names. Schedulers get their people (drafts included) and patterns;
-- everyone else gets the published week of the branches they work at, plus their own days.
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
    SELECT e.id, e.full_name, e.position, e.branch_id, private.can_schedule(e.id) AS can_edit FROM public.employees e
    WHERE e.organization_id = private.current_org_id() AND e.active
      AND (private.can_schedule(e.id) OR e.id IN (SELECT employee_id FROM wk) OR e.id = (SELECT id FROM me))
  )
  SELECT jsonb_build_object(
    'me', (SELECT id FROM me),
    'people', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'position', p.position, 'branch_id', p.branch_id,
        'can_edit', p.can_edit,
        'pattern', CASE WHEN p.can_edit THEN (SELECT jsonb_build_object('branch_id', sp.branch_id, 'days_off', sp.days_off,
                         'start', to_char(sp.start_time, 'HH24:MI'), 'end', to_char(sp.end_time, 'HH24:MI'))
                         FROM public.schedule_patterns sp WHERE sp.employee_id = p.id) END)
        ORDER BY p.full_name) FROM ppl p), '[]'::jsonb),
    'shifts', coalesce((SELECT jsonb_agg(jsonb_build_object('employee_id', w.employee_id, 'date', w.work_date, 'off', w.is_off,
        'branch_id', w.branch_id, 'start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI'),
        'state', w.state, 'note', w.note)) FROM wk w), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'employee_id', r.employee_id, 'name', e.full_name,
        'date', r.work_date, 'other_employee_id', r.other_employee_id, 'other_name', o.full_name, 'other_date', r.other_date,
        'reason', r.reason, 'mine', r.requested_by = private.current_user_id(), 'can_decide', private.can_schedule(r.employee_id)
          AND r.requested_by <> private.current_user_id(), 'created_at', r.created_at) ORDER BY r.created_at)
        FROM public.schedule_requests r JOIN public.employees e ON e.id = r.employee_id
        LEFT JOIN public.employees o ON o.id = r.other_employee_id, me
        WHERE r.organization_id = private.current_org_id() AND r.state = 'PENDING'
          AND (r.requested_by = private.current_user_id() OR r.other_employee_id = me.id OR private.can_schedule(r.employee_id))), '[]'::jsonb))
$$;

-- Private photo folder for time in / out selfies (Supabase Storage). Each person uploads only into their
-- own folder; owners and managers can view them. Skipped where Storage isn't installed (tests).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('timeclock', 'timeclock', false, 1048576, ARRAY['image/jpeg'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS timeclock_insert_own ON storage.objects';
    EXECUTE $p$CREATE POLICY timeclock_insert_own ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'timeclock' AND (storage.foldername(name))[1] = private.current_user_id()::text)$p$;
    EXECUTE 'DROP POLICY IF EXISTS timeclock_read ON storage.objects';
    EXECUTE $p$CREATE POLICY timeclock_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'timeclock' AND ((storage.foldername(name))[1] = private.current_user_id()::text
             OR private.has_role(ARRAY['OWNER','MANAGER'], NULL)
             OR EXISTS (SELECT 1 FROM public.branches b WHERE b.organization_id = private.current_org_id() AND private.has_role(ARRAY['MANAGER'], b.id))))$p$;
  END IF;
END $$;

REVOKE ALL ON FUNCTION private.can_schedule(uuid), private.my_employee_id(), private.notify_employee(uuid, text, text, text, text),
  public.save_schedule_pattern(uuid, uuid, integer[], time, time), public.generate_week(date),
  public.save_shift(uuid, date, boolean, uuid, time, time, text), public.publish_week(date),
  public.request_schedule_change(text, date, uuid, date, text), public.decide_schedule_request(uuid, boolean, text),
  public.cancel_schedule_request(uuid), public.clock_punch(text, uuid, text, double precision, double precision, integer),
  public.set_branch_location(uuid, double precision, double precision), public.on_duty(date), public.attendance(date, date),
  public.week_schedule(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_schedule(uuid), private.my_employee_id(),
  public.save_schedule_pattern(uuid, uuid, integer[], time, time), public.generate_week(date),
  public.save_shift(uuid, date, boolean, uuid, time, time, text), public.publish_week(date),
  public.request_schedule_change(text, date, uuid, date, text), public.decide_schedule_request(uuid, boolean, text),
  public.cancel_schedule_request(uuid), public.clock_punch(text, uuid, text, double precision, double precision, integer),
  public.set_branch_location(uuid, double precision, double precision), public.on_duty(date), public.attendance(date, date),
  public.week_schedule(date) TO authenticated;
