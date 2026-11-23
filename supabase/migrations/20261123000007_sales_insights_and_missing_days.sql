-- HERMOSA OS 0007: daily sales for the dashboard insights, and filling in missing days.
-- Owner feedback 2026-11-23: default to the current month, show missing recorded days per branch,
-- and let them be filled in (an amount) or marked as closed.
-- Scope: owner, branchdash, quality (approved features). Money stays in centavos; dates are Manila business dates.

-- A day the branch was closed (or otherwise has no sales). Marked days stop counting as missing.
CREATE TABLE public.sales_day_status (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  business_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('CLOSED')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, business_date)
);
ALTER TABLE public.sales_day_status ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sales_day_status TO authenticated;
CREATE POLICY day_status_read ON public.sales_day_status FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER','CASHIER'], branch_id));

-- Daily totals per branch the caller may read, plus each branch's first recorded day and closed days.
-- Returned as one JSON document so the dashboard is not cut off by API row limits.
CREATE FUNCTION public.historical_sales_daily(p_start date, p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := private.current_org_id();
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end OR p_end - p_start > 3700 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE_RANGE');
  END IF;
  RETURN (
    WITH readable AS (
      SELECT br.id, br.code, br.name FROM public.branches br
      WHERE br.organization_id = v_org AND br.kind = 'CLINIC' AND br.active
        AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER','CASHIER'], br.id)
    )
    SELECT jsonb_build_object(
      'ok', true, 'basis', 'posting_date', 'start', p_start, 'end', p_end,
      'consolidated', private.has_role(ARRAY['OWNER','FINANCE','AUDITOR'], NULL),
      'branches', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name,
          'first_date', (SELECT min(s.posting_date) FROM public.historical_sales s WHERE s.branch_id = r.id AND s.reversed_at IS NULL))
          ORDER BY r.name) FROM readable r), '[]'::jsonb),
      'days', coalesce((
        SELECT jsonb_agg(jsonb_build_array(d.branch_id, d.posting_date, d.cents) ORDER BY d.posting_date)
        FROM (SELECT s.branch_id, s.posting_date, sum(s.gross_cents) AS cents
              FROM public.historical_sales s JOIN readable r ON r.id = s.branch_id
              WHERE s.reversed_at IS NULL AND s.posting_date BETWEEN p_start AND p_end
              GROUP BY s.branch_id, s.posting_date) d), '[]'::jsonb),
      'closed', coalesce((
        SELECT jsonb_agg(jsonb_build_array(c.branch_id, c.business_date))
        FROM public.sales_day_status c JOIN readable r ON r.id = c.branch_id
        WHERE c.business_date BETWEEN p_start AND p_end), '[]'::jsonb)
    )
  );
END $$;

-- Fill in one missing day: either record its sales amount or mark it closed.
-- An amount goes through the normal import path (hashed, row-level lineage, audit). It publishes at once
-- only when an MFA-verified owner may self-publish (pre-launch switch in 0006); otherwise it waits for sign-off.
CREATE FUNCTION public.fill_missing_day(p_branch uuid, p_date date, p_amount_cents bigint, p_closed boolean, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_code text; v_key text; v_amount text; v_csv text;
  v_stage jsonb; v_pub jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT code INTO v_code FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC';
  IF v_code IS NULL THEN RETURN private.deny(NULL, 'sales_day', 'UNKNOWN_BRANCH'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN
    RETURN private.deny(p_branch, 'sales_day');
  END IF;
  IF p_date IS NULL OR p_date >= (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
  END IF;
  IF EXISTS (SELECT 1 FROM public.historical_sales WHERE branch_id = p_branch AND posting_date = p_date AND reversed_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.sales_day_status WHERE branch_id = p_branch AND business_date = p_date) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DAY_ALREADY_RECORDED');
  END IF;

  IF coalesce(p_closed, false) THEN
    INSERT INTO public.sales_day_status (organization_id, branch_id, business_date, status, note, created_by)
    VALUES (v_org, p_branch, p_date, 'CLOSED', nullif(btrim(coalesce(p_note, '')), ''), v_user);
    PERFORM private.audit(p_branch, 'SALES_DAY_MARKED_CLOSED', 'sales_day', p_date::text, NULL,
      jsonb_build_object('note', p_note));
    RETURN jsonb_build_object('ok', true, 'state', 'CLOSED');
  END IF;

  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  v_key := 'MANUAL-' || v_code || '-' || p_date::text;
  v_amount := (p_amount_cents / 100)::text || '.' || lpad((p_amount_cents % 100)::text, 2, '0');
  v_csv := 'source_id,posting_date,amount_php' || chr(10) || v_key || ',' || p_date || ',' || v_amount || chr(10);
  v_stage := public.stage_historical_sales(p_branch, 'Manual entry ' || p_date::text, v_csv,
    jsonb_build_array(jsonb_build_object('row_number', 1, 'source_key', v_key, 'posting_date', p_date::text,
      'amount', v_amount, 'raw', jsonb_build_array(v_key, p_date::text, v_amount), 'column_count_ok', true)),
    1, p_amount_cents);
  IF NOT (v_stage ->> 'ok')::boolean THEN RETURN v_stage; END IF;
  IF (v_stage ->> 'state') = 'PUBLISHED' THEN RETURN jsonb_build_object('ok', true, 'state', 'PUBLISHED', 'id', v_stage -> 'id'); END IF;

  IF private.has_role(ARRAY['OWNER'], p_branch)
     AND NOT (SELECT require_second_signoff FROM public.organizations WHERE id = v_org) THEN
    v_pub := public.publish_historical_batch((v_stage ->> 'id')::uuid, 1, p_amount_cents);
    IF (v_pub ->> 'ok')::boolean THEN
      RETURN jsonb_build_object('ok', true, 'state', 'PUBLISHED', 'id', v_stage -> 'id');
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'STAGED', 'id', v_stage -> 'id');
END $$;

REVOKE ALL ON FUNCTION public.historical_sales_daily(date, date), public.fill_missing_day(uuid, date, bigint, boolean, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.historical_sales_daily(date, date), public.fill_missing_day(uuid, date, bigint, boolean, text)
  TO authenticated;
