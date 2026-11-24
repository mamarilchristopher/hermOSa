-- HERMOSA OS 0013: daily sales entry, tracker upload and corrections (owner request 2026-11-24).
-- Replaces the daily Google Sheet update: the general manager and owners enter each branch's day total
-- (today included) or load many days from the Sales Source Tracker download. Every day goes through the
-- existing import batch machinery, so the dashboard, audit and sign-off rules all still apply.
--   * Pre-launch switch OFF (organizations.require_second_signoff = false): entries by an owner or by the
--     general manager (manager of all branches) publish at once.
--   * Switch ON: entries wait on /imports for a second person (owner or finance), as imports do.
-- A day that already has a total is never overwritten by an upload. Changing it is a correction: it needs
-- a reason and, with the switch on, a second person. The old row is reversed (kept), never deleted.

CREATE TABLE IF NOT EXISTS public.sales_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  business_date date NOT NULL,
  old_cents bigint NOT NULL,
  new_cents bigint NOT NULL CHECK (new_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPLIED','REJECTED')),
  requested_by uuid NOT NULL REFERENCES public.app_users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  batch_id uuid REFERENCES public.import_batches(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_corrections_one_pending ON public.sales_corrections (branch_id, business_date) WHERE state = 'PENDING';
ALTER TABLE public.sales_corrections ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sales_corrections TO authenticated;
DROP POLICY IF EXISTS sales_corrections_read ON public.sales_corrections;
CREATE POLICY sales_corrections_read ON public.sales_corrections FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], branch_id));

-- Owners and the general manager may publish their own daily entries while the pre-launch switch is off.
CREATE OR REPLACE FUNCTION private.daily_self_publish(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (private.has_role(ARRAY['OWNER'], p_branch) OR private.has_role(ARRAY['MANAGER'], NULL))
     AND NOT coalesce((SELECT require_second_signoff FROM public.organizations WHERE id = private.current_org_id()), true)
$$;

-- Publish a staged batch on behalf of the person who entered it (only called after daily_self_publish).
CREATE OR REPLACE FUNCTION private.publish_now(p_batch uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); b public.import_batches%ROWTYPE; v_rows integer; v_cents bigint;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch FOR UPDATE;
  SELECT count(*), coalesce(sum(gross_cents), 0) INTO v_rows, v_cents FROM public.import_rows WHERE batch_id = p_batch;
  INSERT INTO public.historical_sales (organization_id, branch_id, batch_id, raw_row_id, source_system, source_key, posting_date, gross_cents)
  SELECT b.organization_id, b.branch_id, b.id, r.id, b.source_system, r.source_key, r.posting_date, r.gross_cents
  FROM public.import_rows r WHERE r.batch_id = p_batch;
  UPDATE public.import_rows SET state = 'PUBLISHED' WHERE batch_id = p_batch;
  INSERT INTO public.import_signoffs (batch_id, reviewer_id, expected_row_count, actual_row_count,
    expected_gross_cents, actual_gross_cents, source_sha256)
  VALUES (p_batch, v_user, v_rows, v_rows, v_cents, v_cents, b.source_sha256);
  UPDATE public.import_batches SET state = 'PUBLISHED', approved_by = v_user, approved_at = now(), actual_gross_cents = v_cents
  WHERE id = p_batch;
  PERFORM private.audit(b.branch_id, 'IMPORT_PUBLISHED', 'import_batch', p_batch::text, jsonb_build_object('state', 'STAGED'),
    jsonb_build_object('state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents, 'self_approved', true,
                       'second_signoff_required', false, 'via', 'daily_sales'));
END $$;

-- Stage (and, when allowed, publish) day totals for one branch as one batch.
CREATE OR REPLACE FUNCTION private.stage_days(p_branch uuid, p_label text, p_days jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text; v_stamp text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_csv text := 'source_id,posting_date,amount_php' || chr(10); v_rows jsonb := '[]'::jsonb;
  v_total bigint := 0; v_n integer := 0; d jsonb; v_key text; v_amount text; v_stage jsonb;
BEGIN
  SELECT code INTO v_code FROM public.branches WHERE id = p_branch;
  FOR d IN SELECT value FROM jsonb_array_elements(p_days) ORDER BY value ->> 'date' LOOP
    v_n := v_n + 1;
    v_key := 'OS-' || v_code || '-' || (d ->> 'date') || '-' || v_stamp;
    v_amount := ((d ->> 'cents')::bigint / 100)::text || '.' || lpad(((d ->> 'cents')::bigint % 100)::text, 2, '0');
    v_csv := v_csv || v_key || ',' || (d ->> 'date') || ',' || v_amount || chr(10);
    v_rows := v_rows || jsonb_build_object('row_number', v_n, 'source_key', v_key, 'posting_date', d ->> 'date', 'amount', v_amount,
      'raw', jsonb_build_array(v_key, d ->> 'date', v_amount), 'column_count_ok', true);
    v_total := v_total + (d ->> 'cents')::bigint;
  END LOOP;
  v_stage := public.stage_historical_sales(p_branch, left(p_label, 200), v_csv, v_rows, v_n, v_total);
  IF NOT coalesce((v_stage ->> 'ok')::boolean, false) THEN RETURN v_stage; END IF;
  IF private.daily_self_publish(p_branch) THEN
    PERFORM private.publish_now((v_stage ->> 'id')::uuid);
    RETURN jsonb_build_object('ok', true, 'state', 'PUBLISHED', 'id', v_stage -> 'id', 'rows', v_n, 'cents', v_total);
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'STAGED', 'id', v_stage -> 'id', 'rows', v_n, 'cents', v_total);
END $$;

-- Enter day totals for a branch: one day from the Daily sales page, or many from a tracker upload.
-- p_rows = [{"date": "2026-11-24", "cents": 100000}, ...]. All rows must pass or nothing is saved.
CREATE OR REPLACE FUNCTION public.record_daily_sales(p_branch uuid, p_rows jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  r jsonb; v_date date; v_cents bigint; v_problems jsonb := '[]'::jsonb; v_seen date[] := '{}'; v_days jsonb := '[]'::jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC' AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'daily_sales'); END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 400 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_date := private.parse_iso_date(r ->> 'date');
    v_cents := CASE WHEN coalesce(r ->> 'cents', '') ~ '^\d{1,12}$' THEN (r ->> 'cents')::bigint END;
    IF v_date IS NULL THEN v_problems := v_problems || jsonb_build_object('date', r ->> 'date', 'error', 'INVALID_DATE'); CONTINUE; END IF;
    IF v_cents IS NULL OR v_cents <= 0 OR v_cents > 100000000000 THEN
      v_problems := v_problems || jsonb_build_object('date', v_date, 'error', 'INVALID_AMOUNT'); CONTINUE;
    END IF;
    IF v_date > v_today THEN v_problems := v_problems || jsonb_build_object('date', v_date, 'error', 'FUTURE_DATE'); CONTINUE; END IF;
    IF v_date = ANY (v_seen) THEN v_problems := v_problems || jsonb_build_object('date', v_date, 'error', 'DUPLICATE_DATE'); CONTINUE; END IF;
    v_seen := v_seen || v_date;
    IF EXISTS (SELECT 1 FROM public.historical_sales WHERE branch_id = p_branch AND posting_date = v_date AND reversed_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.import_rows x JOIN public.import_batches b ON b.id = x.batch_id
                  WHERE b.branch_id = p_branch AND b.state = 'STAGED' AND x.posting_date = v_date)
       OR EXISTS (SELECT 1 FROM public.sales_day_status WHERE branch_id = p_branch AND business_date = v_date AND state <> 'REJECTED') THEN
      v_problems := v_problems || jsonb_build_object('date', v_date, 'error', 'DAY_ALREADY_RECORDED'); CONTINUE;
    END IF;
    v_days := v_days || jsonb_build_object('date', v_date, 'cents', v_cents);
  END LOOP;
  IF jsonb_array_length(v_problems) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROWS_REJECTED', 'problems', v_problems);
  END IF;
  RETURN private.stage_days(p_branch,
    coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'Daily sales') || ' (' || jsonb_array_length(v_days) || ' day' ||
      CASE WHEN jsonb_array_length(v_days) = 1 THEN ' ' || (v_days -> 0 ->> 'date') ELSE 's' END || ')',
    v_days);
END $$;

CREATE OR REPLACE FUNCTION private.apply_correction(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.sales_corrections%ROWTYPE; v_res jsonb; v_user uuid := private.current_user_id();
BEGIN
  SELECT * INTO c FROM public.sales_corrections WHERE id = p_id FOR UPDATE;
  UPDATE public.historical_sales SET reversed_at = now()
  WHERE branch_id = c.branch_id AND posting_date = c.business_date AND reversed_at IS NULL;
  -- The replacement publishes straight away: the correction itself is what was signed off.
  v_res := public.stage_historical_sales(c.branch_id, 'Correction ' || c.business_date,
    'source_id,posting_date,amount_php' || chr(10) || 'FIX-' || c.id || ',' || c.business_date || ',' ||
      (c.new_cents / 100) || '.' || lpad((c.new_cents % 100)::text, 2, '0') || chr(10),
    jsonb_build_array(jsonb_build_object('row_number', 1, 'source_key', 'FIX-' || c.id, 'posting_date', c.business_date::text,
      'amount', (c.new_cents / 100) || '.' || lpad((c.new_cents % 100)::text, 2, '0'),
      'raw', jsonb_build_array('FIX-' || c.id), 'column_count_ok', true)),
    1, c.new_cents);
  IF NOT coalesce((v_res ->> 'ok')::boolean, false) THEN RAISE EXCEPTION 'CORRECTION_STAGE_FAILED %', v_res ->> 'error'; END IF;
  PERFORM private.publish_now((v_res ->> 'id')::uuid);
  UPDATE public.sales_corrections SET state = 'APPLIED', decided_by = v_user, decided_at = now(), batch_id = (v_res ->> 'id')::uuid
  WHERE id = p_id;
  PERFORM private.audit(c.branch_id, 'SALES_CORRECTED', 'sales_correction', p_id::text,
    jsonb_build_object('date', c.business_date, 'cents', c.old_cents),
    jsonb_build_object('date', c.business_date, 'cents', c.new_cents, 'reason', c.reason, 'requested_by', c.requested_by));
  RETURN jsonb_build_object('ok', true, 'state', 'APPLIED', 'id', p_id);
END $$;

-- Ask to change a recorded day's total. Applies at once only while the pre-launch switch is off.
CREATE OR REPLACE FUNCTION public.request_sales_correction(p_branch uuid, p_date date, p_cents bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_old bigint; v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'sales_correction'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 OR p_cents > 100000000000 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT sum(gross_cents) INTO v_old FROM public.historical_sales
  WHERE branch_id = p_branch AND posting_date = p_date AND reversed_at IS NULL;
  IF v_old IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CORRECT'); END IF;
  IF v_old = p_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'SAME_AMOUNT'); END IF;
  IF EXISTS (SELECT 1 FROM public.sales_corrections WHERE branch_id = p_branch AND business_date = p_date AND state = 'PENDING') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CORRECTION_PENDING');
  END IF;
  INSERT INTO public.sales_corrections (organization_id, branch_id, business_date, old_cents, new_cents, reason, requested_by)
  VALUES (v_org, p_branch, p_date, v_old, p_cents, left(btrim(p_reason), 500), v_user) RETURNING id INTO v_id;
  PERFORM private.audit(p_branch, 'SALES_CORRECTION_REQUESTED', 'sales_correction', v_id::text,
    jsonb_build_object('cents', v_old), jsonb_build_object('date', p_date, 'cents', p_cents, 'reason', p_reason));
  IF private.daily_self_publish(p_branch) THEN RETURN private.apply_correction(v_id); END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'PENDING', 'id', v_id);
END $$;

-- Second person (owner or finance, never the requester) approves or rejects a correction.
CREATE OR REPLACE FUNCTION public.decide_sales_correction(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); c public.sales_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO c FROM public.sales_corrections WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE'], c.branch_id) THEN
    -- "Verify with your authenticator" only helps someone who holds an owner or finance role.
    RETURN private.deny(c.branch_id, 'sales_correction',
      CASE WHEN NOT private.has_mfa() AND EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = v_user AND g.revoked_at IS NULL
                                                    AND g.role_code IN ('OWNER','FINANCE')) THEN 'MFA_REQUIRED' ELSE 'FORBIDDEN' END);
  END IF;
  IF c.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF c.requested_by = v_user AND NOT private.owner_may_self_confirm(c.branch_id) THEN
    RETURN private.deny(c.branch_id, 'sales_correction', 'SELF_APPROVAL_DENIED');
  END IF;
  IF coalesce(p_approve, false) THEN
    UPDATE public.sales_corrections SET decision_note = nullif(left(btrim(coalesce(p_note, '')), 500), '') WHERE id = p_id;
    RETURN private.apply_correction(p_id);
  END IF;
  IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
  UPDATE public.sales_corrections SET state = 'REJECTED', decided_by = v_user, decided_at = now(), decision_note = left(btrim(p_note), 500)
  WHERE id = p_id;
  PERFORM private.audit(c.branch_id, 'SALES_CORRECTION_REJECTED', 'sales_correction', p_id::text, NULL, jsonb_build_object('note', p_note));
  RETURN jsonb_build_object('ok', true, 'state', 'REJECTED');
END $$;

-- What the OS holds per branch and day: recorded total, Closed/No sales mark, waiting sign-off,
-- and the service log total for the same day (non-rejected entries) to compare against.
CREATE OR REPLACE FUNCTION public.daily_sales_status(p_start date, p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 800 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  RETURN jsonb_build_object('ok', true,
    'second_signoff', coalesce((SELECT require_second_signoff FROM public.organizations WHERE id = v_org), true),
    'branches', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name,
        'can_enter', private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], b.id),
        'self_publish', private.daily_self_publish(b.id),
        'can_approve', private.has_role(ARRAY['OWNER','FINANCE'], b.id)) ORDER BY b.name)
      FROM public.branches b WHERE b.organization_id = v_org AND b.kind = 'CLINIC' AND b.active
        AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], b.id)), '[]'::jsonb),
    'days', coalesce((
      SELECT jsonb_agg(jsonb_build_array(x.branch_id, x.d, x.recorded, x.mark, x.staged, x.service) ORDER BY x.d, x.branch_id)
      FROM (
        SELECT k.branch_id, k.d,
          (SELECT sum(s.gross_cents) FROM public.historical_sales s WHERE s.branch_id = k.branch_id AND s.posting_date = k.d AND s.reversed_at IS NULL) AS recorded,
          (SELECT m.status FROM public.sales_day_status m WHERE m.branch_id = k.branch_id AND m.business_date = k.d AND m.state <> 'REJECTED' LIMIT 1) AS mark,
          EXISTS (SELECT 1 FROM public.import_rows r JOIN public.import_batches bt ON bt.id = r.batch_id
                  WHERE bt.branch_id = k.branch_id AND bt.state = 'STAGED' AND r.posting_date = k.d) AS staged,
          (SELECT sum(l.amount_paid_cents) FROM public.service_logs l WHERE l.branch_id = k.branch_id AND l.service_date = k.d AND l.state <> 'REJECTED') AS service
        FROM (
          SELECT DISTINCT branch_id, posting_date AS d FROM public.historical_sales
            WHERE reversed_at IS NULL AND posting_date BETWEEN p_start AND p_end
          UNION SELECT DISTINCT branch_id, business_date FROM public.sales_day_status WHERE state <> 'REJECTED' AND business_date BETWEEN p_start AND p_end
          UNION SELECT DISTINCT bt.branch_id, r.posting_date FROM public.import_rows r JOIN public.import_batches bt ON bt.id = r.batch_id
            WHERE bt.state = 'STAGED' AND r.posting_date BETWEEN p_start AND p_end
          UNION SELECT DISTINCT branch_id, service_date FROM public.service_logs WHERE state <> 'REJECTED' AND service_date BETWEEN p_start AND p_end
        ) k
        JOIN public.branches b ON b.id = k.branch_id AND b.organization_id = v_org
        WHERE private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], k.branch_id)
      ) x), '[]'::jsonb),
    'corrections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'branch_id', c.branch_id, 'date', c.business_date,
        'old_cents', c.old_cents, 'new_cents', c.new_cents, 'reason', c.reason, 'requested_by', u.display_name,
        'mine', c.requested_by = private.current_user_id()) ORDER BY c.requested_at)
      FROM public.sales_corrections c JOIN public.app_users u ON u.id = c.requested_by
      WHERE c.organization_id = v_org AND c.state = 'PENDING'
        AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], c.branch_id)), '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION private.daily_self_publish(uuid), private.publish_now(uuid), private.stage_days(uuid, text, jsonb),
  private.apply_correction(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_daily_sales(uuid, jsonb, text), public.request_sales_correction(uuid, date, bigint, text),
  public.decide_sales_correction(uuid, boolean, text), public.daily_sales_status(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_daily_sales(uuid, jsonb, text), public.request_sales_correction(uuid, date, bigint, text),
  public.decide_sales_correction(uuid, boolean, text), public.daily_sales_status(date, date) TO authenticated;
