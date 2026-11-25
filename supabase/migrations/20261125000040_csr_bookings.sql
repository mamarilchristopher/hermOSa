-- update-0040: online bookings for CSRs (Hermosa OS v0.40.0).
-- CSRs (and owners and the GM) log each Facebook booking; each branch sees its visit list and marks
-- Arrived / Done / Unresponsive / Re-sched; CSRs see the results live. Replaces the GC lists and the tracker sheet.

-- 1. Who books and who sees a branch's visits.
-- Who manages bookings everywhere: CSRs, owners and the GM.
CREATE OR REPLACE FUNCTION private.can_book() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['CSR','OWNER'], NULL) OR private.is_gm()
$$;
-- Who sees one branch's visits and marks them Arrived / Done: the above, plus that branch's staff.
CREATE OR REPLACE FUNCTION private.can_see_bookings(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.can_book() OR private.has_role(ARRAY['MANAGER','CLINICIAN','CASHIER'], p_branch)
$$;
REVOKE ALL ON FUNCTION private.can_book(), private.can_see_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_book(), private.can_see_bookings(uuid) TO authenticated;


-- 2. Bookings. One row per booked visit; a reschedule moves the row and remembers the day it left (rescheduled_from).
CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  booked_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Manila')::date,
  csr_employee_id uuid REFERENCES public.employees(id),
  client_name text NOT NULL CHECK (length(btrim(client_name)) BETWEEN 2 AND 120),
  contact text CHECK (contact IS NULL OR length(contact) <= 40),
  platform text NOT NULL DEFAULT 'FACEBOOK' CHECK (platform IN ('FACEBOOK','INSTAGRAM','CALL','SMS','WALK_IN','OTHER')),
  services text NOT NULL CHECK (length(btrim(services)) BETWEEN 2 AND 200),
  appointment_date date NOT NULL,
  appointment_time time,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  deposit_cents integer CHECK (deposit_cents IS NULL OR deposit_cents BETWEEN 0 AND 100000000),
  deposit_date date,
  follow_up boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) <= 300),
  status text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','CONFIRMED','ARRIVED','DONE','UNRESPONSIVE','CANCELLED')),
  resched_count integer NOT NULL DEFAULT 0,
  rescheduled_from date,
  status_note text CHECK (status_note IS NULL OR length(status_note) <= 300),
  status_by uuid REFERENCES public.app_users(id),
  status_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_day ON public.bookings (organization_id, appointment_date, branch_id);
CREATE INDEX IF NOT EXISTS bookings_moved ON public.bookings (organization_id, rescheduled_from);
CREATE INDEX IF NOT EXISTS bookings_csr ON public.bookings (csr_employee_id, booked_on);
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.bookings TO authenticated;
DROP POLICY IF EXISTS bookings_read ON public.bookings;
CREATE POLICY bookings_read ON public.bookings FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_see_bookings(branch_id));

-- Add a booking (p_id null) or change one. CSRs, owners and the GM.
CREATE OR REPLACE FUNCTION public.save_booking(p_id uuid, p_client text, p_contact text, p_platform text, p_services text,
  p_date date, p_time time, p_branch uuid, p_deposit_cents integer, p_deposit_date date, p_follow_up boolean, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; old public.bookings%ROWTYPE;
        v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_book() THEN RETURN private.deny(NULL, 'booking'); END IF;
  IF length(btrim(coalesce(p_client, ''))) < 2 OR length(btrim(coalesce(p_services, ''))) < 2 OR p_date IS NULL
     OR coalesce(p_platform, '') NOT IN ('FACEBOOK','INSTAGRAM','CALL','SMS','WALK_IN','OTHER')
     OR (p_deposit_cents IS NOT NULL AND p_deposit_cents < 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF p_date < v_today - 30 OR p_date > v_today + 365 THEN RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC' AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.bookings (organization_id, csr_employee_id, client_name, contact, platform, services, appointment_date, appointment_time,
      branch_id, deposit_cents, deposit_date, follow_up, note, created_by)
    VALUES (v_org, private.my_employee_id(), btrim(p_client), nullif(btrim(coalesce(p_contact, '')), ''), p_platform, btrim(p_services), p_date, p_time,
      p_branch, nullif(p_deposit_cents, 0), CASE WHEN coalesce(p_deposit_cents, 0) > 0 THEN coalesce(p_deposit_date, v_today) END,
      coalesce(p_follow_up, false), nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_user)
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'BOOKING_ADDED', 'booking', v_id::text, NULL, NULL);
  ELSE
    SELECT * INTO old FROM public.bookings WHERE id = p_id AND organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
    UPDATE public.bookings SET client_name = btrim(p_client), contact = nullif(btrim(coalesce(p_contact, '')), ''), platform = p_platform,
      services = btrim(p_services), appointment_date = p_date, appointment_time = p_time, branch_id = p_branch,
      deposit_cents = nullif(p_deposit_cents, 0), deposit_date = CASE WHEN coalesce(p_deposit_cents, 0) > 0 THEN coalesce(p_deposit_date, old.deposit_date, v_today) END,
      follow_up = coalesce(p_follow_up, false), note = nullif(left(btrim(coalesce(p_note, '')), 300), ''), updated_at = now()
    WHERE id = p_id;
    v_id := p_id;
    PERFORM private.audit(p_branch, 'BOOKING_CHANGED', 'booking', v_id::text, to_jsonb(old), NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- Mark a visit. Branch staff: Arrived, Done, Unresponsive, Re-sched (and a note).
-- CSRs, owners and the GM: also Booked, Confirmed and Cancelled. Re-sched moves the date and goes back to Booked.
CREATE OR REPLACE FUNCTION public.set_booking_status(p_id uuid, p_status text, p_new_date date, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.bookings%ROWTYPE; v_user uuid := private.current_user_id(); v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT private.can_see_bookings(b.branch_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p_status = 'RESCHEDULED' THEN
    IF p_new_date IS NULL OR p_new_date < v_today OR p_new_date > v_today + 365 OR p_new_date = b.appointment_date THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE');
    END IF;
    UPDATE public.bookings SET appointment_date = p_new_date, status = 'BOOKED', resched_count = resched_count + 1,
      rescheduled_from = b.appointment_date, status_note = v_note,
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status = 'NOTE' THEN
    UPDATE public.bookings SET status_note = v_note, status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status IN ('ARRIVED','DONE','UNRESPONSIVE') THEN
    UPDATE public.bookings SET status = p_status, status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status IN ('BOOKED','CONFIRMED','CANCELLED') THEN
    IF NOT private.can_book() THEN RETURN private.deny(b.branch_id, 'booking'); END IF;
    UPDATE public.bookings SET status = p_status, status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  PERFORM private.audit(b.branch_id, 'BOOKING_' || p_status, 'booking', p_id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.save_booking(uuid, text, text, text, text, date, time, uuid, integer, date, boolean, text),
  public.set_booking_status(uuid, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_booking(uuid, text, text, text, text, date, time, uuid, integer, date, boolean, text),
  public.set_booking_status(uuid, text, date, text) TO authenticated;

