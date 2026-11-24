-- HERMOSA OS 0016: a recorded day can be changed to Zero sales (owner request 2026-11-24).
-- A change to ₱0 reverses the day's sales rows (kept, never deleted) and marks the day Zero sales.
-- Same rules as any change: reason, pop-up, notices, and two people for a day changed before.
-- Safe to run more than once.

ALTER TABLE public.sales_corrections DROP CONSTRAINT IF EXISTS sales_corrections_new_cents_check;
ALTER TABLE public.sales_corrections DROP CONSTRAINT IF EXISTS sales_corrections_new_cents_nonneg;
ALTER TABLE public.sales_corrections ADD CONSTRAINT sales_corrections_new_cents_nonneg CHECK (new_cents >= 0);

CREATE OR REPLACE FUNCTION private.apply_correction(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.sales_corrections%ROWTYPE; v_res jsonb; v_user uuid := private.current_user_id(); v_batch uuid;
BEGIN
  SELECT * INTO c FROM public.sales_corrections WHERE id = p_id FOR UPDATE;
  UPDATE public.historical_sales SET reversed_at = now()
  WHERE branch_id = c.branch_id AND posting_date = c.business_date AND reversed_at IS NULL;
  IF c.new_cents = 0 THEN
    -- Zero sales: no replacement row, the day is marked instead (confirmed: the change itself was signed off).
    INSERT INTO public.sales_day_status (organization_id, branch_id, business_date, status, note, created_by, state, decided_by, decided_at)
    VALUES (c.organization_id, c.branch_id, c.business_date, 'NO_SALES', left('Changed to zero sales: ' || c.reason, 300), c.requested_by,
            'CONFIRMED', v_user, now());
  ELSE
    -- The replacement publishes straight away: the correction itself is what was signed off.
    v_res := public.stage_historical_sales(c.branch_id, 'Correction ' || c.business_date,
      'source_id,posting_date,amount_php' || chr(10) || 'FIX-' || c.id || ',' || c.business_date || ',' ||
        (c.new_cents / 100) || '.' || lpad((c.new_cents % 100)::text, 2, '0') || chr(10),
      jsonb_build_array(jsonb_build_object('row_number', 1, 'source_key', 'FIX-' || c.id, 'posting_date', c.business_date::text,
        'amount', (c.new_cents / 100) || '.' || lpad((c.new_cents % 100)::text, 2, '0'),
        'raw', jsonb_build_array('FIX-' || c.id), 'column_count_ok', true)),
      1, c.new_cents);
    IF NOT coalesce((v_res ->> 'ok')::boolean, false) THEN RAISE EXCEPTION 'CORRECTION_STAGE_FAILED %', v_res ->> 'error'; END IF;
    v_batch := (v_res ->> 'id')::uuid;
    PERFORM private.publish_now(v_batch);
  END IF;
  UPDATE public.sales_corrections SET state = 'APPLIED', decided_by = v_user, decided_at = now(), batch_id = v_batch
  WHERE id = p_id;
  PERFORM private.audit(c.branch_id, 'SALES_CORRECTED', 'sales_correction', p_id::text,
    jsonb_build_object('date', c.business_date, 'cents', c.old_cents),
    jsonb_build_object('date', c.business_date, 'cents', c.new_cents, 'reason', c.reason, 'requested_by', c.requested_by));
  RETURN jsonb_build_object('ok', true, 'state', 'APPLIED', 'id', p_id);
END $$;

CREATE OR REPLACE FUNCTION public.request_sales_correction(p_branch uuid, p_date date, p_cents bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_old bigint; v_id uuid;
  v_two boolean; v_res jsonb; c public.sales_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'sales_correction'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  IF p_cents IS NULL OR p_cents < 0 OR p_cents > 100000000000 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT sum(gross_cents) INTO v_old FROM public.historical_sales
  WHERE branch_id = p_branch AND posting_date = p_date AND reversed_at IS NULL;
  IF v_old IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CORRECT'); END IF;
  IF v_old = p_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'SAME_AMOUNT'); END IF;
  IF EXISTS (SELECT 1 FROM public.sales_corrections WHERE branch_id = p_branch AND business_date = p_date AND state = 'PENDING') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CORRECTION_PENDING');
  END IF;
  v_two := EXISTS (SELECT 1 FROM public.sales_corrections WHERE branch_id = p_branch AND business_date = p_date AND state = 'APPLIED');
  INSERT INTO public.sales_corrections (organization_id, branch_id, business_date, old_cents, new_cents, reason, requested_by, needs_two)
  VALUES (v_org, p_branch, p_date, v_old, p_cents, left(btrim(p_reason), 500), v_user, v_two) RETURNING * INTO c;
  v_id := c.id;
  PERFORM private.audit(p_branch, 'SALES_CORRECTION_REQUESTED', 'sales_correction', v_id::text,
    jsonb_build_object('cents', v_old), jsonb_build_object('date', p_date, 'cents', p_cents, 'reason', p_reason, 'needs_two', v_two));
  IF NOT v_two AND private.daily_self_publish(p_branch) THEN
    v_res := private.apply_correction(v_id);
    PERFORM private.notify_management(p_branch, 'SALES_CHANGED', 'Sales changed', private.correction_text(c),
      '/sales/daily?month=' || to_char(p_date, 'YYYY-MM'));
    RETURN v_res;
  END IF;
  PERFORM private.notify_management(p_branch, 'SALES_CHANGE_WAITING',
    CASE WHEN v_two THEN 'Sales change needs your confirmation (changed before)' ELSE 'Sales change needs your confirmation' END,
    private.correction_text(c), '/sales/daily?month=' || to_char(p_date, 'YYYY-MM'));
  RETURN jsonb_build_object('ok', true, 'state', 'PENDING', 'id', v_id, 'needs_two', v_two);
END $$;
