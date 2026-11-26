-- Hermosa OS update-0090: backjob cases per client (status, resolution, closing). Safe to run again.
-- SQL Editor: https://supabase.com/dashboard/project/bnopatuopnenbdhrecdt/sql/new
-- update-0090 (CHRIS Nov 27): "per client it's necessary to have current status, resolution etc. Ability to close cases
-- via resolution or quitclaims etc." Every backjob belongs to a case: one client's issue with one treatment. A new backjob
-- joins the client's open case for that service (or opens a new one). Owners and the GM move a case along:
-- Open → Being fixed → closed as Fixed, Refunded (with the amount), Quitclaim signed, or Client stopped responding.
-- A closed case can be reopened. Backjobs from before this update are grouped into cases automatically.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'update_backjob_case') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

CREATE TABLE IF NOT EXISTS public.backjob_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  client_name text NOT NULL,
  client_key text NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  service_id uuid REFERENCES public.services(id),
  original_log_id uuid REFERENCES public.service_logs(id) ON DELETE SET NULL,
  staff_id uuid REFERENCES public.employees(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','REFUNDED','QUITCLAIM','NO_RESPONSE')),
  resolution text CHECK (resolution IS NULL OR length(resolution) <= 500),
  refund_cents bigint CHECK (refund_cents IS NULL OR refund_cents BETWEEN 0 AND 100000000),
  opened_on date NOT NULL,
  closed_on date,
  closed_by uuid REFERENCES public.app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backjob_cases_open ON public.backjob_cases (organization_id, client_key, service_id) WHERE status IN ('OPEN','IN_PROGRESS');
ALTER TABLE public.backjob_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backjob_cases_read ON public.backjob_cases;
CREATE POLICY backjob_cases_read ON public.backjob_cases FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.is_management(private.current_user_id()));
REVOKE INSERT, UPDATE, DELETE ON public.backjob_cases FROM anon, authenticated;
GRANT SELECT ON public.backjob_cases TO authenticated;

ALTER TABLE public.backjob_tags ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES public.backjob_cases(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION private.client_key(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')) $$;
REVOKE ALL ON FUNCTION private.client_key(text) FROM PUBLIC, anon, authenticated;

-- Put a tagged backjob in a case: the client's open case for the same service, else a new one.
CREATE OR REPLACE FUNCTION private.backjob_case_for(p_log uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs; t public.backjob_tags; v_case uuid; v_key text;
BEGIN
  SELECT * INTO l FROM public.service_logs WHERE id = p_log;
  SELECT * INTO t FROM public.backjob_tags WHERE service_log_id = p_log;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.case_id IS NOT NULL THEN
    UPDATE public.backjob_cases SET staff_id = coalesce(t.staff_id, staff_id), original_log_id = coalesce(t.original_log_id, original_log_id), updated_at = now() WHERE id = t.case_id;
    RETURN t.case_id;
  END IF;
  v_key := private.client_key(l.client_name);
  SELECT id INTO v_case FROM public.backjob_cases
  WHERE organization_id = l.organization_id AND client_key = v_key AND service_id IS NOT DISTINCT FROM l.service_id AND status IN ('OPEN','IN_PROGRESS')
  ORDER BY opened_on DESC LIMIT 1;
  IF v_case IS NULL THEN
    INSERT INTO public.backjob_cases (organization_id, client_name, client_key, branch_id, service_id, original_log_id, staff_id, status, opened_on)
    VALUES (l.organization_id, coalesce(nullif(btrim(l.client_name), ''), 'Client'), v_key, l.branch_id, l.service_id, t.original_log_id, t.staff_id, 'OPEN', l.service_date)
    RETURNING id INTO v_case;
  END IF;
  UPDATE public.backjob_tags SET case_id = v_case WHERE service_log_id = p_log;
  RETURN v_case;
END $$;
REVOKE ALL ON FUNCTION private.backjob_case_for(uuid) FROM PUBLIC, anon, authenticated;

-- tag_backjob as in update-0088, plus: the backjob joins (or opens) its case.
CREATE OR REPLACE FUNCTION public.tag_backjob(p_log uuid, p_staff uuid, p_reason text, p_note text, p_original uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs; v_orig uuid; v_staff uuid; v_reason text := nullif(upper(btrim(coalesce(p_reason, ''))), '');
  v_case uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF coalesce(l.visit_kind, 'PAID') <> 'BACKJOB' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_BACKJOB'); END IF;
  IF NOT (private.is_management(v_user) OR (l.created_by = v_user AND l.state = 'PENDING')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED');
  END IF;
  IF v_reason IS NOT NULL AND v_reason NOT IN ('UNEVEN','THREAD','SWELLING','REACTION','FADED','NOT_SATISFIED','OTHER') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REASON');
  END IF;
  IF p_original IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_logs o WHERE o.id = p_original AND o.organization_id = l.organization_id AND o.id <> l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_staff IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = p_staff AND e.organization_id = l.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  v_orig := coalesce(p_original, private.backjob_original(l.id));
  v_staff := coalesce(p_staff, (SELECT o.performer_id FROM public.service_logs o WHERE o.id = v_orig));
  INSERT INTO public.backjob_tags (service_log_id, organization_id, original_log_id, staff_id, reason, note, tagged_by, tagged_at)
  VALUES (l.id, l.organization_id, v_orig, v_staff, v_reason, nullif(btrim(coalesce(p_note, '')), ''), v_user, now())
  ON CONFLICT (service_log_id) DO UPDATE SET original_log_id = EXCLUDED.original_log_id, staff_id = EXCLUDED.staff_id,
    reason = EXCLUDED.reason, note = EXCLUDED.note, tagged_by = EXCLUDED.tagged_by, tagged_at = now();
  v_case := private.backjob_case_for(l.id);
  RETURN jsonb_build_object('ok', true, 'id', l.id, 'original', v_orig, 'staff', v_staff, 'case', v_case);
END $$;
REVOKE ALL ON FUNCTION public.tag_backjob(uuid, uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tag_backjob(uuid, uuid, text, text, uuid) TO authenticated;

-- Move a case along or close it (owners and the GM). Closing needs a short resolution; a refund needs its amount.
CREATE OR REPLACE FUNCTION public.update_backjob_case(p_case uuid, p_status text, p_resolution text, p_refund_cents bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); c public.backjob_cases; v_status text := upper(btrim(coalesce(p_status, '')));
  v_note text := nullif(btrim(coalesce(p_resolution, '')), ''); v_closed boolean;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO c FROM public.backjob_cases WHERE id = p_case AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF v_status NOT IN ('OPEN','IN_PROGRESS','RESOLVED','REFUNDED','QUITCLAIM','NO_RESPONSE') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  v_closed := v_status IN ('RESOLVED','REFUNDED','QUITCLAIM','NO_RESPONSE');
  IF v_closed AND (v_note IS NULL OR length(v_note) < 3) THEN RETURN jsonb_build_object('ok', false, 'error', 'RESOLUTION_REQUIRED'); END IF;
  IF v_status = 'REFUNDED' AND (p_refund_cents IS NULL OR p_refund_cents <= 0) THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  UPDATE public.backjob_cases SET status = v_status, resolution = coalesce(v_note, resolution),
    refund_cents = CASE WHEN v_status = 'REFUNDED' THEN p_refund_cents ELSE refund_cents END,
    closed_on = CASE WHEN v_closed THEN (now() AT TIME ZONE 'Asia/Manila')::date ELSE NULL END,
    closed_by = CASE WHEN v_closed THEN v_user ELSE NULL END, updated_at = now()
  WHERE id = c.id;
  PERFORM private.audit(c.branch_id, 'BACKJOB_CASE_' || v_status, 'backjob_case', c.id::text, NULL, jsonb_build_object('refund_cents', p_refund_cents));
  RETURN jsonb_build_object('ok', true, 'id', c.id, 'status', v_status);
END $$;
REVOKE ALL ON FUNCTION public.update_backjob_case(uuid, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_backjob_case(uuid, text, text, bigint) TO authenticated;

-- Backjobs tagged before this update: group them into cases, oldest first.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.service_log_id FROM public.backjob_tags t JOIN public.service_logs l ON l.id = t.service_log_id
           WHERE t.case_id IS NULL ORDER BY l.service_date, l.created_at LOOP
    PERFORM private.backjob_case_for(r.service_log_id);
  END LOOP;
END $$;

SELECT 'update-0090 is installed' AS result;
