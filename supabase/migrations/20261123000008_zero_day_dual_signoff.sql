-- HERMOSA OS 0008: a zero-sales day needs two people (owner rule, 2026-11-23).
-- Marking a day "Closed" or "No sales" creates a PENDING mark. A second person with Owner or Finance access
-- (not the one who marked it) confirms or rejects it. Only CONFIRMED marks stop the day counting as missing.
-- This applies even while the import sign-off switch (0006) is off.

ALTER TABLE public.sales_day_status DROP CONSTRAINT sales_day_status_pkey;
ALTER TABLE public.sales_day_status DROP CONSTRAINT sales_day_status_status_check;
ALTER TABLE public.sales_day_status
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ADD COLUMN state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','CONFIRMED','REJECTED')),
  ADD COLUMN decided_by uuid REFERENCES public.app_users(id),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  ADD CONSTRAINT sales_day_status_kind CHECK (status IN ('CLOSED','NO_SALES')),
  ADD CONSTRAINT zero_day_not_self_confirmed CHECK (decided_by IS NULL OR decided_by <> created_by);
-- Any marks made under 0007 were single-person: they now wait for a second person.
UPDATE public.sales_day_status SET state = 'PENDING';
CREATE UNIQUE INDEX one_open_mark_per_day ON public.sales_day_status (branch_id, business_date) WHERE state <> 'REJECTED';

DROP FUNCTION public.fill_missing_day(uuid, date, bigint, boolean, text);

-- p_kind: 'AMOUNT' (enter the day's sales), 'CLOSED' or 'NO_SALES' (both need a second person).
CREATE FUNCTION public.fill_missing_day(p_branch uuid, p_date date, p_kind text, p_amount_cents bigint, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_code text; v_key text; v_amount text; v_csv text; v_id uuid;
  v_stage jsonb; v_pub jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT code INTO v_code FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC';
  IF v_code IS NULL THEN RETURN private.deny(NULL, 'sales_day', 'UNKNOWN_BRANCH'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN
    RETURN private.deny(p_branch, 'sales_day');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('AMOUNT','CLOSED','NO_SALES') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF p_date IS NULL OR p_date >= (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
  END IF;
  IF EXISTS (SELECT 1 FROM public.historical_sales WHERE branch_id = p_branch AND posting_date = p_date AND reversed_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.sales_day_status WHERE branch_id = p_branch AND business_date = p_date AND state <> 'REJECTED') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DAY_ALREADY_RECORDED');
  END IF;

  IF p_kind IN ('CLOSED','NO_SALES') THEN
    INSERT INTO public.sales_day_status (organization_id, branch_id, business_date, status, note, created_by)
    VALUES (v_org, p_branch, p_date, p_kind, nullif(btrim(coalesce(p_note, '')), ''), v_user)
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'ZERO_DAY_MARKED', 'sales_day', v_id::text, NULL,
      jsonb_build_object('date', p_date, 'status', p_kind, 'note', p_note));
    RETURN jsonb_build_object('ok', true, 'state', 'PENDING', 'id', v_id);
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

-- Second person confirms or rejects a Closed / No sales mark.
CREATE FUNCTION public.decide_zero_day(p_mark uuid, p_confirm boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  m public.sales_day_status%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO m FROM public.sales_day_status WHERE id = p_mark AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE'], m.branch_id) THEN
    RETURN private.deny(m.branch_id, 'sales_day.decide', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  IF m.created_by = v_user THEN RETURN private.deny(m.branch_id, 'sales_day.decide', 'SELF_APPROVAL_DENIED'); END IF;
  IF m.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  UPDATE public.sales_day_status
  SET state = CASE WHEN p_confirm THEN 'CONFIRMED' ELSE 'REJECTED' END,
      decided_by = v_user, decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
  WHERE id = p_mark;
  PERFORM private.audit(m.branch_id, CASE WHEN p_confirm THEN 'ZERO_DAY_CONFIRMED' ELSE 'ZERO_DAY_REJECTED' END,
    'sales_day', p_mark::text, jsonb_build_object('state', 'PENDING'),
    jsonb_build_object('date', m.business_date, 'status', m.status, 'note', p_note));
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN p_confirm THEN 'CONFIRMED' ELSE 'REJECTED' END);
END $$;

-- Daily data now returns each open mark: [branch, date, status, state, mark id, marked by, marked by me].
CREATE OR REPLACE FUNCTION public.historical_sales_daily(p_start date, p_end date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := private.current_org_id();
  v_me uuid := private.current_user_id();
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
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
        SELECT jsonb_agg(jsonb_build_array(c.branch_id, c.business_date, c.status, c.state, c.id, u.display_name, c.created_by = v_me))
        FROM public.sales_day_status c JOIN readable r ON r.id = c.branch_id
        JOIN public.app_users u ON u.id = c.created_by
        WHERE c.state <> 'REJECTED' AND c.business_date BETWEEN p_start AND p_end), '[]'::jsonb)
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.fill_missing_day(uuid, date, text, bigint, text), public.decide_zero_day(uuid, boolean, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fill_missing_day(uuid, date, text, bigint, text), public.decide_zero_day(uuid, boolean, text)
  TO authenticated;
