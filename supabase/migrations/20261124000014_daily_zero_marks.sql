-- HERMOSA OS 0014: mark Zero sales / Closed days straight from the Daily Sales grid (owner request 2026-11-24).
-- Same marks as Missing days (sales_day_status), but: today may be marked too, many days save at once
-- (all or nothing), and the general manager's marks confirm at once while the pre-launch switch is off,
-- the same rule as daily entries (private.daily_self_publish). With the switch on, marks wait for a
-- second person on Missing days, as before. Safe to run more than once.

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
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN v_self THEN 'CONFIRMED' ELSE 'PENDING' END, 'count', jsonb_array_length(v_ok));
END $$;

REVOKE ALL ON FUNCTION public.mark_sales_days(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_sales_days(uuid, jsonb) TO authenticated;
