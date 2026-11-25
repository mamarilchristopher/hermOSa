-- update-0028: the General Manager (company-wide MANAGER, e.g. Geraldine) gets every owner-level approval.
--   * Staff details: review, correct, approve or send back (not her own; an owner approves hers).
--   * Join requests: every level except Owner (GM, Finance and HR included).
--   * Sales changes, Closed / No sales days and sales imports: confirm or reject like Owner/Finance.
--   * Pre-launch "approve my own" exceptions that owners have also apply to the GM.
-- Owner-only settings (roles, PIN resets, IR limit, schedule rules) stay owner-only.

CREATE OR REPLACE FUNCTION private.is_gm() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['MANAGER'], NULL)
$$;
REVOKE ALL ON FUNCTION private.is_gm() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_gm() TO authenticated;

CREATE OR REPLACE FUNCTION private.owner_may_self_confirm(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (private.has_role(ARRAY['OWNER'], p_branch) OR private.is_gm())
     AND NOT coalesce((SELECT require_second_signoff FROM public.organizations WHERE id = private.current_org_id()), true)
$$;
REVOKE ALL ON FUNCTION private.owner_may_self_confirm(uuid) FROM PUBLIC;

-- The GM sees every account's name (for the approval lists), and the staff details people sent.
DROP POLICY IF EXISTS users_read_gm ON public.app_users;
CREATE POLICY users_read_gm ON public.app_users FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.is_gm());
DROP POLICY IF EXISTS detail_submissions_read ON public.employee_detail_submissions;
CREATE POLICY detail_submissions_read ON public.employee_detail_submissions FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (user_id = private.current_user_id() OR private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()));
DROP POLICY IF EXISTS employee_details_read ON public.employee_details;
CREATE POLICY employee_details_read ON public.employee_details FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()
              OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.app_user_id = private.current_user_id())));

CREATE OR REPLACE FUNCTION public.decide_employee_details(p_submission uuid, p_approve boolean, p_data jsonb, p_full_name text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  s public.employee_detail_submissions%ROWTYPE;
  v_emp uuid; v_data jsonb; v_hire date;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN
    RETURN private.deny(NULL, 'employee_details', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO s FROM public.employee_detail_submissions
  WHERE id = p_submission AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF s.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  -- Nobody but an owner approves their own details.
  IF s.user_id = v_me AND NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'employee_details', 'SELF_APPROVAL_DENIED');
  END IF;

  IF NOT coalesce(p_approve, false) THEN
    IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
    UPDATE public.employee_detail_submissions SET state = 'RETURNED', note = left(btrim(p_note), 500), decided_by = v_me, decided_at = now()
    WHERE id = s.id;
    PERFORM private.audit(NULL, 'DETAILS_RETURNED', 'employee_detail_submission', s.id::text, NULL, NULL);
    RETURN jsonb_build_object('ok', true);
  END IF;

  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = s.user_id;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  v_data := coalesce(p_data, s.data);
  IF NOT private.details_complete(v_data) OR pg_column_size(v_data) > 20000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF length(btrim(coalesce(p_full_name, ''))) NOT BETWEEN 2 AND 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  IF coalesce(v_data ->> 'hire_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN v_hire := (v_data ->> 'hire_date')::date; END IF;

  UPDATE public.employee_detail_submissions SET state = 'APPROVED', data = v_data, decided_by = v_me, decided_at = now(),
    note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
  WHERE id = s.id;
  INSERT INTO public.employee_details (employee_id, organization_id, data, submission_id, approved_by)
  VALUES (v_emp, s.organization_id, v_data, s.id, v_me)
  ON CONFLICT (employee_id) DO UPDATE SET data = EXCLUDED.data, submission_id = EXCLUDED.submission_id,
    approved_by = EXCLUDED.approved_by, approved_at = now();
  UPDATE public.employees SET full_name = btrim(p_full_name), hire_date = coalesce(v_hire, hire_date) WHERE id = v_emp;
  PERFORM private.audit(NULL, 'DETAILS_APPROVED', 'employee', v_emp::text, NULL,
    jsonb_build_object('submission_id', s.id, 'corrected', p_data IS NOT NULL AND p_data <> s.data));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;

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
  IF p_level IS NULL OR p_level NOT IN ('OWNER','GM','SENIOR_CMA','CMA','TRAINEE','MANAGER','CASHIER','FINANCE','HR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEVEL_REQUIRED');
  END IF;
  IF NOT v_owner AND p_level = 'OWNER' THEN
    RETURN private.deny(NULL, 'join_request', 'OWNER_ONLY_LEVEL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BRANCH_REQUIRED');
  END IF;
  v_role := CASE p_level WHEN 'GM' THEN 'MANAGER' WHEN 'SENIOR_CMA' THEN 'CLINICIAN' WHEN 'CMA' THEN 'CLINICIAN' WHEN 'TRAINEE' THEN 'CLINICIAN' ELSE p_level END;
  v_scope := CASE WHEN p_level IN ('OWNER','GM','FINANCE','HR') THEN NULL ELSE p_branch END;

  INSERT INTO public.role_grants (user_id, role_code, branch_id, granted_by) VALUES (p_user, v_role, v_scope, v_me)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = p_user;
  IF v_emp IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, u.display_name,
            coalesce(nullif(btrim(coalesce(p_position, '')), ''), CASE p_level WHEN 'OWNER' THEN 'Owner' WHEN 'GM' THEN 'General Manager' WHEN 'SENIOR_CMA' THEN 'Senior CMA'
              WHEN 'CMA' THEN 'CMA' WHEN 'TRAINEE' THEN 'Trainee' WHEN 'MANAGER' THEN 'Branch Manager' WHEN 'CASHIER' THEN 'Front desk'
              WHEN 'FINANCE' THEN 'Finance' ELSE 'HR' END),
            coalesce(p_commission, p_level IN ('SENIOR_CMA','CMA')), p_user, v_me)
    RETURNING id INTO v_emp;
  END IF;
  UPDATE public.app_users SET join_status = 'APPROVED' WHERE id = p_user;
  PERFORM private.audit(v_scope, 'JOIN_APPROVED', 'app_user', p_user::text, jsonb_build_object('join_status', 'PENDING'),
    jsonb_build_object('level', p_level, 'role', v_role, 'branch_id', v_scope, 'home_branch', p_branch, 'employee_id', v_emp));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;

CREATE OR REPLACE FUNCTION public.decide_zero_day(p_mark uuid, p_confirm boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  m public.sales_day_status%ROWTYPE;
  v_self boolean;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO m FROM public.sales_day_status WHERE id = p_mark AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','FINANCE'], m.branch_id) OR private.is_gm()) THEN
    RETURN private.deny(m.branch_id, 'sales_day.decide', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  v_self := m.created_by = v_user;
  IF v_self AND NOT private.owner_may_self_confirm(m.branch_id) THEN
    RETURN private.deny(m.branch_id, 'sales_day.decide', 'SELF_APPROVAL_DENIED');
  END IF;
  IF m.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  UPDATE public.sales_day_status
  SET state = CASE WHEN p_confirm THEN 'CONFIRMED' ELSE 'REJECTED' END,
      decided_by = v_user, decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
  WHERE id = p_mark;
  PERFORM private.audit(m.branch_id, CASE WHEN p_confirm THEN 'ZERO_DAY_CONFIRMED' ELSE 'ZERO_DAY_REJECTED' END,
    'sales_day', p_mark::text, jsonb_build_object('state', 'PENDING'),
    jsonb_build_object('date', m.business_date, 'status', m.status, 'note', p_note, 'self_confirmed', v_self));
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN p_confirm THEN 'CONFIRMED' ELSE 'REJECTED' END);
END $$;

CREATE OR REPLACE FUNCTION public.decide_sales_correction(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); c public.sales_corrections%ROWTYPE; v_res jsonb; v_who text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO c FROM public.sales_corrections WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','FINANCE'], c.branch_id) OR private.is_gm()) THEN
    RETURN private.deny(c.branch_id, 'sales_correction',
      CASE WHEN NOT private.has_mfa() AND EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = v_user AND g.revoked_at IS NULL
                                                    AND g.role_code IN ('OWNER','FINANCE')) THEN 'MFA_REQUIRED' ELSE 'FORBIDDEN' END);
  END IF;
  IF c.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF c.requested_by = v_user AND (c.needs_two OR NOT private.owner_may_self_confirm(c.branch_id)) THEN
    RETURN private.deny(c.branch_id, 'sales_correction', 'SELF_APPROVAL_DENIED');
  END IF;
  SELECT display_name INTO v_who FROM public.app_users WHERE id = v_user;
  IF coalesce(p_approve, false) THEN
    UPDATE public.sales_corrections SET decision_note = nullif(left(btrim(coalesce(p_note, '')), 500), '') WHERE id = p_id;
    v_res := private.apply_correction(p_id);
    PERFORM private.notify_management(c.branch_id, 'SALES_CHANGED', 'Sales change confirmed',
      private.correction_text(c) || ' Confirmed by ' || coalesce(v_who, 'someone') || '.', '/sales/daily?month=' || to_char(c.business_date, 'YYYY-MM'));
    RETURN v_res;
  END IF;
  IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
  UPDATE public.sales_corrections SET state = 'REJECTED', decided_by = v_user, decided_at = now(), decision_note = left(btrim(p_note), 500)
  WHERE id = p_id;
  PERFORM private.audit(c.branch_id, 'SALES_CORRECTION_REJECTED', 'sales_correction', p_id::text, NULL, jsonb_build_object('note', p_note));
  PERFORM private.notify_management(c.branch_id, 'SALES_CHANGE_REJECTED', 'Sales change rejected',
    private.correction_text(c) || ' Rejected by ' || coalesce(v_who, 'someone') || ': ' || left(btrim(p_note), 300), '/sales/daily?month=' || to_char(c.business_date, 'YYYY-MM'));
  RETURN jsonb_build_object('ok', true, 'state', 'REJECTED');
END $$;

CREATE OR REPLACE FUNCTION public.publish_historical_batch(
  p_batch uuid, p_expected_rows integer, p_expected_gross_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  b public.import_batches%ROWTYPE;
  v_rows integer; v_invalid integer; v_cents bigint;
  v_self boolean; v_four_eyes boolean := true;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'BATCH_NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','FINANCE'], b.branch_id) OR private.is_gm()) THEN
    RETURN private.deny(b.branch_id, 'import_batch.publish',
      CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  v_self := b.created_by = v_user;
  IF v_self THEN
    SELECT require_second_signoff INTO v_four_eyes FROM public.organizations WHERE id = b.organization_id;
    -- Pre-launch exception: with the switch off, an MFA-verified OWNER (or the GM) may publish their own upload.
    IF v_four_eyes OR NOT (private.has_role(ARRAY['OWNER'], b.branch_id) OR private.is_gm()) THEN
      RETURN private.deny(b.branch_id, 'import_batch.publish', 'SELF_APPROVAL_DENIED');
    END IF;
  END IF;
  IF b.state <> 'STAGED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_STAGED'); END IF;

  SELECT count(*), count(*) FILTER (WHERE state = 'INVALID'), coalesce(sum(gross_cents), 0)
  INTO v_rows, v_invalid, v_cents
  FROM public.import_rows WHERE batch_id = p_batch;

  IF v_invalid > 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_ROWS', 'invalid_rows', v_invalid); END IF;
  IF v_rows <> b.expected_row_count OR v_cents <> b.expected_gross_cents
     OR p_expected_rows IS DISTINCT FROM b.expected_row_count
     OR p_expected_gross_cents IS DISTINCT FROM b.expected_gross_cents THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RECONCILIATION_FAILED',
      'actual_rows', v_rows, 'actual_gross_cents', v_cents);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.period_locks l JOIN public.import_rows r ON r.batch_id = p_batch
    WHERE l.branch_id = b.branch_id AND l.domain = 'IMPORT' AND r.posting_date BETWEEN l.start_on AND l.end_on) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PERIOD_LOCKED');
  END IF;

  BEGIN
    INSERT INTO public.historical_sales (organization_id, branch_id, batch_id, raw_row_id, source_system, source_key, posting_date, gross_cents)
    SELECT b.organization_id, b.branch_id, b.id, r.id, b.source_system, r.source_key, r.posting_date, r.gross_cents
    FROM public.import_rows r WHERE r.batch_id = p_batch;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_SOURCE_ACTIVE');
  END;

  UPDATE public.import_rows SET state = 'PUBLISHED' WHERE batch_id = p_batch;
  INSERT INTO public.import_signoffs (batch_id, reviewer_id, expected_row_count, actual_row_count,
    expected_gross_cents, actual_gross_cents, source_sha256)
  VALUES (p_batch, v_user, b.expected_row_count, v_rows, b.expected_gross_cents, v_cents, b.source_sha256);
  UPDATE public.import_batches
  SET state = 'PUBLISHED', approved_by = v_user, approved_at = now(), actual_gross_cents = v_cents
  WHERE id = p_batch;

  PERFORM private.audit(b.branch_id, 'IMPORT_PUBLISHED', 'import_batch', p_batch::text,
    jsonb_build_object('state', 'STAGED'),
    jsonb_build_object('state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents,
                       'self_approved', v_self, 'second_signoff_required', v_four_eyes));
  RETURN jsonb_build_object('ok', true, 'id', p_batch, 'state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents);
END $$;
