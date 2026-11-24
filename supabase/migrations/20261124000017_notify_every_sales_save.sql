-- HERMOSA OS 0017: every sales save notifies management, and any change after saving needs two people
-- (owner request 2026-11-24: "this change will notify all other management members and need confirmation
-- from two people to change again", applied to all saves).
--   * New day totals and Zero sales / Closed marks notify all other management members.
--   * Changing a saved day always waits for a second person (owner, finance or general manager, never the
--     person who asked), even before launch.
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION private.php_text(p_cents bigint) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT '₱' || to_char(p_cents / 100.0, 'FM999,999,990.00') $$;
REVOKE ALL ON FUNCTION private.php_text(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_daily_sales(p_branch uuid, p_rows jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  r jsonb; v_date date; v_cents bigint; v_problems jsonb := '[]'::jsonb; v_seen date[] := '{}'; v_days jsonb := '[]'::jsonb;
  v_res jsonb; v_list text;
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
  v_res := private.stage_days(p_branch,
    coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'Daily sales') || ' (' || jsonb_array_length(v_days) || ' day' ||
      CASE WHEN jsonb_array_length(v_days) = 1 THEN ' ' || (v_days -> 0 ->> 'date') ELSE 's' END || ')',
    v_days);
  IF coalesce((v_res ->> 'ok')::boolean, false) THEN
    SELECT string_agg(to_char((d ->> 'date')::date, 'Mon FMDD') || ' ' || private.php_text((d ->> 'cents')::bigint), ', ' ORDER BY d ->> 'date')
      INTO v_list FROM jsonb_array_elements(v_days) d;
    PERFORM private.notify_management(p_branch, 'SALES_ENTERED', 'Sales entered',
      (SELECT name FROM public.branches WHERE id = p_branch) || ': ' || left(v_list, 700) ||
      CASE WHEN (v_res ->> 'state') = 'PUBLISHED' THEN '' ELSE ' (waiting for sign-off)' END ||
      '. By ' || coalesce((SELECT display_name FROM public.app_users WHERE id = v_user), 'someone') || '.',
      '/sales/daily?month=' || left(v_days -> 0 ->> 'date', 7));
  END IF;
  RETURN v_res;
END $$;


CREATE OR REPLACE FUNCTION public.mark_sales_days(p_branch uuid, p_days jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  r jsonb; v_date date; v_status text; v_problems jsonb := '[]'::jsonb; v_seen date[] := '{}';
  v_ok jsonb := '[]'::jsonb; v_self boolean; v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC' AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'sales_day'); END IF;
  IF jsonb_typeof(p_days) <> 'array' OR jsonb_array_length(p_days) = 0 OR jsonb_array_length(p_days) > 400 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_days) LOOP
    v_date := private.parse_iso_date(r ->> 'date');
    v_status := r ->> 'status';
    IF v_date IS NULL THEN v_problems := v_problems || jsonb_build_object('date', r ->> 'date', 'error', 'INVALID_DATE'); CONTINUE; END IF;
    IF v_status IS NULL OR v_status NOT IN ('CLOSED','NO_SALES') THEN
      v_problems := v_problems || jsonb_build_object('date', v_date, 'error', 'BAD_REQUEST'); CONTINUE;
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
    v_ok := v_ok || jsonb_build_object('date', v_date, 'status', v_status);
  END LOOP;
  IF jsonb_array_length(v_problems) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROWS_REJECTED', 'problems', v_problems);
  END IF;

  v_self := private.daily_self_publish(p_branch);
  FOR r IN SELECT value FROM jsonb_array_elements(v_ok) LOOP
    INSERT INTO public.sales_day_status (organization_id, branch_id, business_date, status, note, created_by, state, decided_by, decided_at)
    VALUES (v_org, p_branch, (r ->> 'date')::date, r ->> 'status', NULL, v_user,
            CASE WHEN v_self THEN 'CONFIRMED' ELSE 'PENDING' END,
            CASE WHEN v_self THEN v_user END, CASE WHEN v_self THEN now() END)
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'ZERO_DAY_MARKED', 'sales_day', v_id::text, NULL,
      jsonb_build_object('date', r ->> 'date', 'status', r ->> 'status', 'source', 'Daily sales', 'self_confirmed', v_self));
  END LOOP;
  PERFORM private.notify_management(p_branch, 'SALES_MARKED', 'Days marked Zero sales / Closed',
    (SELECT name FROM public.branches WHERE id = p_branch) || ': ' ||
    (SELECT string_agg(to_char((d ->> 'date')::date, 'Mon FMDD') || ' ' || CASE WHEN d ->> 'status' = 'CLOSED' THEN 'Closed' ELSE 'Zero sales' END, ', ' ORDER BY d ->> 'date')
       FROM jsonb_array_elements(v_ok) d) ||
    CASE WHEN v_self THEN '' ELSE ' (waiting for confirmation)' END ||
    '. By ' || coalesce((SELECT display_name FROM public.app_users WHERE id = v_user), 'someone') || '.',
    '/sales/daily?month=' || left(v_ok -> 0 ->> 'date', 7));
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN v_self THEN 'CONFIRMED' ELSE 'PENDING' END, 'count', jsonb_array_length(v_ok));
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
  v_two := true;  -- every change after saving needs a second person (owner request 2026-11-24)
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
    'Sales change needs your confirmation',
    private.correction_text(c), '/sales/daily?month=' || to_char(p_date, 'YYYY-MM'));
  RETURN jsonb_build_object('ok', true, 'state', 'PENDING', 'id', v_id, 'needs_two', v_two);
END $$;

