-- HERMOSA OS 0002: access helpers, row-level security, and the historical import API.
--
-- Security model (ADR-2, ADR-3, ADR-8):
--   * Browser and server code talk to Postgres as the Supabase `authenticated` role with the
--     user's own JWT. That role may only SELECT, and RLS limits rows to the user's branch scope.
--   * Every write goes through a SECURITY DEFINER function below that re-checks role, branch,
--     MFA level and segregation of duties, writes its audit event in the same transaction,
--     and returns {ok:false,error:...} instead of raising, so denials are audited too.
--   * OWNER, FINANCE and HR grants only count when the session has MFA (aal2).

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------
CREATE FUNCTION private.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id FROM public.app_users u
  WHERE u.auth_subject = auth.uid() AND u.active
$$;

CREATE FUNCTION private.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.organization_id FROM public.app_users u
  WHERE u.auth_subject = auth.uid() AND u.active
$$;

CREATE FUNCTION private.has_mfa() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
$$;

-- True when the current user holds one of p_roles for p_branch.
-- p_branch NULL asks for a company-wide grant (grant.branch_id IS NULL).
CREATE FUNCTION private.has_role(p_roles text[], p_branch uuid) RETURNS boolean
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
  )
$$;

CREATE FUNCTION private.audit(
  p_branch uuid, p_action text, p_resource_type text, p_resource_id text,
  p_prior jsonb DEFAULT NULL, p_next jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id();
BEGIN
  IF v_org IS NULL THEN
    SELECT organization_id INTO v_org FROM public.branches WHERE id = p_branch;
  END IF;
  IF v_org IS NULL THEN RETURN; END IF;  -- unknown caller and unknown branch: nothing to attach to
  INSERT INTO public.audit_events (organization_id, branch_id, actor_id, action, resource_type, resource_id, prior_value, next_value)
  VALUES (v_org, p_branch, private.current_user_id(), p_action, p_resource_type, p_resource_id, p_prior, p_next);
END $$;

-- Denial helper: audit and build the error payload.
CREATE FUNCTION private.deny(p_branch uuid, p_what text, p_error text DEFAULT 'FORBIDDEN') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.audit(p_branch, 'ACCESS_DENIED', p_what, NULL, NULL,
                        jsonb_build_object('error', p_error, 'mfa', private.has_mfa()));
  RETURN jsonb_build_object('ok', false, 'error', p_error);
END $$;

CREATE FUNCTION private.php_to_cents(p_text text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE t text := btrim(coalesce(p_text, ''));
BEGIN
  t := regexp_replace(t, '^₱', '');
  IF t !~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$' THEN RETURN NULL; END IF;
  RETURN (split_part(t, '.', 1)::bigint * 100) + rpad(split_part(t, '.', 2), 2, '0')::bigint;
END $$;

CREATE FUNCTION private.parse_iso_date(p_text text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE d date;
BEGIN
  IF coalesce(p_text, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  BEGIN
    d := p_text::date;
  EXCEPTION WHEN others THEN RETURN NULL;
  END;
  IF to_char(d, 'YYYY-MM-DD') <> p_text THEN RETURN NULL; END IF;
  RETURN d;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.current_user_id(), private.current_org_id(), private.has_mfa(),
  private.has_role(text[], uuid) TO authenticated;

------------------------------------------------------------------------------
-- Table privileges: read-only for signed-in users, nothing for anonymous.
------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
-- Future tables must opt in explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

------------------------------------------------------------------------------
-- Row-level security (deny by default; SELECT policies only)
------------------------------------------------------------------------------
ALTER TABLE public.organizations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_grants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.period_locks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_sales  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_signoffs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_read ON public.organizations FOR SELECT TO authenticated
  USING (id = private.current_org_id());

CREATE POLICY branch_read ON public.branches FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id());

CREATE POLICY users_read ON public.app_users FOR SELECT TO authenticated
  USING (id = private.current_user_id()
         OR (organization_id = private.current_org_id() AND private.has_role(ARRAY['OWNER'], NULL)));

CREATE POLICY grants_read ON public.role_grants FOR SELECT TO authenticated
  USING (user_id = private.current_user_id() OR private.has_role(ARRAY['OWNER'], NULL));

CREATE POLICY approvals_read ON public.approval_requests FOR SELECT TO authenticated
  USING (initiator_id = private.current_user_id()
         OR approver_id = private.current_user_id()
         OR private.has_role(ARRAY['OWNER','FINANCE','AUDITOR'], NULL)
         OR (branch_id IS NOT NULL AND private.has_role(ARRAY['MANAGER'], branch_id)));

CREATE POLICY locks_read ON public.period_locks FOR SELECT TO authenticated
  USING (private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER','HR'], branch_id));

-- view_audit_logs: owner and auditor all; manager own branch domain.
CREATE POLICY audit_read ON public.audit_events FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (
           private.has_role(ARRAY['OWNER','AUDITOR'], NULL)
           OR (branch_id IS NOT NULL AND private.has_role(ARRAY['MANAGER'], branch_id))));

-- import_historical_data / approve_import_reconciliation: owner, finance, manager (own branch), auditor read-only.
CREATE POLICY import_batches_read ON public.import_batches FOR SELECT TO authenticated
  USING (private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], branch_id));

CREATE POLICY import_rows_read ON public.import_rows FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.import_batches b
                 WHERE b.id = batch_id
                   AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], b.branch_id)));

CREATE POLICY signoffs_read ON public.import_signoffs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.import_batches b
                 WHERE b.id = batch_id
                   AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], b.branch_id)));

-- view_branch_sales: owner/finance/auditor all branches; manager and cashier assigned branches.
CREATE POLICY historical_sales_read ON public.historical_sales FOR SELECT TO authenticated
  USING (private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER','CASHIER'], branch_id));

------------------------------------------------------------------------------
-- API: historical sales import (ported from build pack reference_slice/history.mjs)
------------------------------------------------------------------------------

-- Stage a CSV. p_rows is the server's parse of p_csv:
--   [{ "row_number": 1, "source_key": "...", "posting_date": "YYYY-MM-DD", "amount": "1250.00",
--      "raw": [...cells], "column_count_ok": true }, ...]
-- Every field is re-validated here; the hash is computed here from the raw file text.
CREATE FUNCTION public.stage_historical_sales(
  p_branch uuid, p_filename text, p_csv text, p_rows jsonb,
  p_expected_rows integer, p_expected_gross_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org  uuid := private.current_org_id();
  v_hash text;
  v_existing record;
  v_batch uuid;
  r jsonb;
  v_key text; v_date date; v_cents bigint; v_errors jsonb;
  v_rowno integer := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC' AND active) THEN
    RETURN private.deny(NULL, 'import_batch', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN
    RETURN private.deny(p_branch, 'import_batch');
  END IF;
  IF coalesce(btrim(p_filename), '') = '' OR p_csv IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_SOURCE');
  END IF;
  IF p_expected_rows IS NULL OR p_expected_rows < 0 OR p_expected_gross_cents IS NULL OR p_expected_gross_cents < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_EXPECTED_TOTAL');
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CSV_HAS_NO_RECORDS');
  END IF;

  v_hash := encode(extensions.digest(p_csv, 'sha256'), 'hex');

  SELECT id, state INTO v_existing FROM public.import_batches
  WHERE organization_id = v_org AND branch_id = p_branch AND import_kind = 'HISTORICAL_SALES'
    AND source_sha256 = v_hash AND state <> 'REVERSED';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'state', v_existing.state, 'duplicate', true);
  END IF;

  INSERT INTO public.import_batches (organization_id, branch_id, import_kind, source_filename, source_sha256,
    mapping, source_row_count, expected_row_count, expected_gross_cents, created_by)
  VALUES (v_org, p_branch, 'HISTORICAL_SALES', p_filename, v_hash,
    jsonb_build_object('columns', jsonb_build_array('source_id','posting_date','amount_php')),
    jsonb_array_length(p_rows), p_expected_rows, p_expected_gross_cents, v_user)
  RETURNING id INTO v_batch;

  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_rowno := v_rowno + 1;
    v_errors := '[]'::jsonb;
    v_key := nullif(btrim(r ->> 'source_key'), '');
    v_date := private.parse_iso_date(btrim(r ->> 'posting_date'));
    v_cents := private.php_to_cents(r ->> 'amount');
    IF coalesce((r ->> 'column_count_ok')::boolean, false) IS NOT TRUE THEN v_errors := v_errors || '"WRONG_COLUMN_COUNT"'; END IF;
    IF v_key IS NULL THEN v_errors := v_errors || '"MISSING_SOURCE_ID"'; END IF;
    IF v_date IS NULL THEN v_errors := v_errors || '"INVALID_DATE"'; END IF;
    IF v_cents IS NULL THEN v_errors := v_errors || '"INVALID_AMOUNT"'; END IF;
    IF v_key IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.historical_sales s
         WHERE s.organization_id = v_org AND s.branch_id = p_branch AND s.source_system = 'LEGACY'
           AND s.source_key = v_key AND s.reversed_at IS NULL) THEN
      v_errors := v_errors || '"EXISTING_SOURCE_ID"';
    END IF;
    IF v_key IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.import_rows x WHERE x.batch_id = v_batch AND x.source_key = v_key) THEN
      v_errors := v_errors || '"DUPLICATE_SOURCE_IN_BATCH"';
    END IF;
    INSERT INTO public.import_rows (batch_id, row_number, source_key, posting_date, gross_cents, source_payload, validation_errors, state)
    VALUES (v_batch, v_rowno, v_key, v_date, v_cents, coalesce(r -> 'raw', r), v_errors,
            CASE WHEN jsonb_array_length(v_errors) = 0 THEN 'VALID' ELSE 'INVALID' END);
  END LOOP;

  UPDATE public.import_batches
  SET actual_gross_cents = (SELECT coalesce(sum(gross_cents), 0) FROM public.import_rows WHERE batch_id = v_batch AND state = 'VALID')
  WHERE id = v_batch;

  PERFORM private.audit(p_branch, 'IMPORT_STAGED', 'import_batch', v_batch::text, NULL,
    jsonb_build_object('filename', p_filename, 'sha256', v_hash, 'rows', v_rowno));
  RETURN jsonb_build_object('ok', true, 'id', v_batch, 'state', 'STAGED', 'duplicate', false);
END $$;

-- Reviewer re-enters the branch's source totals; publish only when everything matches.
CREATE FUNCTION public.publish_historical_batch(
  p_batch uuid, p_expected_rows integer, p_expected_gross_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  b public.import_batches%ROWTYPE;
  v_rows integer; v_invalid integer; v_cents bigint;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'BATCH_NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE'], b.branch_id) THEN
    RETURN private.deny(b.branch_id, 'import_batch.publish',
      CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  IF b.created_by = v_user THEN RETURN private.deny(b.branch_id, 'import_batch.publish', 'SELF_APPROVAL_DENIED'); END IF;
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
    jsonb_build_object('state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents));
  RETURN jsonb_build_object('ok', true, 'id', p_batch, 'state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents);
END $$;

CREATE FUNCTION public.reverse_historical_batch(p_batch uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  b public.import_batches%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'BATCH_NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE'], b.branch_id) THEN
    RETURN private.deny(b.branch_id, 'import_batch.reverse',
      CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  IF b.state <> 'PUBLISHED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PUBLISHED'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;

  UPDATE public.historical_sales SET reversed_at = now() WHERE batch_id = p_batch AND reversed_at IS NULL;
  UPDATE public.import_batches
  SET state = 'REVERSED', reversed_by = v_user, reversed_at = now(), reversal_reason = btrim(p_reason)
  WHERE id = p_batch;
  PERFORM private.audit(b.branch_id, 'IMPORT_REVERSED', 'import_batch', p_batch::text,
    jsonb_build_object('state', 'PUBLISHED'), jsonb_build_object('state', 'REVERSED', 'reason', btrim(p_reason)));
  RETURN jsonb_build_object('ok', true, 'id', p_batch, 'state', 'REVERSED');
END $$;

-- Branch or consolidated totals of PUBLISHED historical sales only.
-- p_branch NULL = consolidated (company-wide grant required).
CREATE FUNCTION public.historical_sales_totals(p_branch uuid, p_start date, p_end date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := private.current_org_id();
  v_rows jsonb;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE_RANGE');
  END IF;
  IF p_branch IS NULL THEN
    IF NOT private.has_role(ARRAY['OWNER','FINANCE','AUDITOR'], NULL) THEN
      RETURN private.deny(NULL, 'report.historical_sales.consolidated');
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org) THEN
      RETURN private.deny(NULL, 'report.historical_sales', 'UNKNOWN_BRANCH');
    END IF;
    IF NOT private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER','CASHIER'], p_branch) THEN
      RETURN private.deny(p_branch, 'report.historical_sales');
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x.branch_name), '[]'::jsonb) INTO v_rows FROM (
    SELECT br.id AS branch_id, br.code AS branch_code, br.name AS branch_name,
           count(s.id) AS sales_count,
           coalesce(sum(s.gross_cents), 0) AS gross_cents,
           (SELECT count(*) FROM public.import_batches pb
             WHERE pb.branch_id = br.id AND pb.state = 'STAGED') AS pending_batches,
           EXISTS (SELECT 1 FROM public.import_batches vb
             WHERE vb.branch_id = br.id AND vb.state = 'PUBLISHED') AS has_validated_data
    FROM public.branches br
    LEFT JOIN public.historical_sales s
      ON s.branch_id = br.id AND s.reversed_at IS NULL AND s.posting_date BETWEEN p_start AND p_end
    WHERE br.organization_id = v_org AND br.kind = 'CLINIC'
      AND (p_branch IS NULL OR br.id = p_branch)
    GROUP BY br.id, br.code, br.name
  ) x;

  RETURN jsonb_build_object('ok', true,
    'basis', 'posting_date', 'currency', 'PHP', 'source', 'validated_historical_detail',
    'start', p_start, 'end', p_end, 'rows', v_rows,
    'total_gross_cents', (SELECT coalesce(sum((e ->> 'gross_cents')::bigint), 0) FROM jsonb_array_elements(v_rows) e),
    'any_validated_data', (SELECT coalesce(bool_or((e ->> 'has_validated_data')::boolean), false) FROM jsonb_array_elements(v_rows) e));
END $$;

------------------------------------------------------------------------------
-- API: role management (owner with MFA; no self escalation)
------------------------------------------------------------------------------
CREATE FUNCTION public.grant_role(p_user uuid, p_role text, p_branch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id(); v_id uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(p_branch, 'role_grant', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  IF p_user = v_me THEN RETURN private.deny(p_branch, 'role_grant', 'SELF_ESCALATION_DENIED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE id = p_user AND organization_id = private.current_org_id()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER');
  END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  INSERT INTO public.role_grants (user_id, role_code, branch_id, granted_by)
  VALUES (p_user, p_role, p_branch, v_me)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', true, 'duplicate', true); END IF;
  PERFORM private.audit(p_branch, 'ROLE_GRANTED', 'role_grant', v_id::text, NULL,
    jsonb_build_object('user_id', p_user, 'role', p_role, 'branch_id', p_branch));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION WHEN check_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_ROLE');
END $$;

CREATE FUNCTION public.revoke_role(p_grant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id(); g public.role_grants%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO g FROM public.role_grants WHERE id = p_grant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(g.branch_id, 'role_grant', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  IF g.user_id = v_me THEN RETURN private.deny(g.branch_id, 'role_grant', 'SELF_CHANGE_DENIED'); END IF;
  IF g.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'duplicate', true); END IF;
  UPDATE public.role_grants SET revoked_at = now(), revoked_by = v_me WHERE id = p_grant;
  PERFORM private.audit(g.branch_id, 'ROLE_REVOKED', 'role_grant', p_grant::text,
    jsonb_build_object('user_id', g.user_id, 'role', g.role_code, 'branch_id', g.branch_id), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Who am I: roles and branches for building the UI (the UI is never the security boundary).
CREATE FUNCTION public.my_access() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'user_id', u.id, 'display_name', u.display_name, 'mfa', private.has_mfa(),
    'needs_mfa', EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL
                         AND g.role_code IN ('OWNER','FINANCE','HR')),
    'grants', coalesce((SELECT jsonb_agg(jsonb_build_object('role', g.role_code, 'branch_id', g.branch_id))
                        FROM public.role_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL), '[]'::jsonb))
  FROM public.app_users u WHERE u.auth_subject = auth.uid() AND u.active
$$;

REVOKE ALL ON FUNCTION public.stage_historical_sales(uuid, text, text, jsonb, integer, bigint),
  public.publish_historical_batch(uuid, integer, bigint),
  public.reverse_historical_batch(uuid, text),
  public.historical_sales_totals(uuid, date, date),
  public.grant_role(uuid, text, uuid),
  public.revoke_role(uuid),
  public.my_access(),
  public.forbid_audit_mutation(),
  public.guard_historical_sales()
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_historical_sales(uuid, text, text, jsonb, integer, bigint),
  public.publish_historical_batch(uuid, integer, bigint),
  public.reverse_historical_batch(uuid, text),
  public.historical_sales_totals(uuid, date, date),
  public.grant_role(uuid, text, uuid),
  public.revoke_role(uuid),
  public.my_access()
TO authenticated;
