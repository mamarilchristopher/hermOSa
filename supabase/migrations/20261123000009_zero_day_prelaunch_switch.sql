-- HERMOSA OS 0009: the pre-launch switch (organizations.require_second_signoff, see 0006) now also covers
-- Closed / No sales days (owner's choice, 2026-11-23). While it is false, an MFA-verified OWNER's mark is
-- confirmed at once, and an owner may confirm their own pending marks. Every step is still audited with
-- self_confirmed = true. TURN BACK ON BEFORE LAUNCH (one line covers imports and zero days):
--   update public.organizations set require_second_signoff = true;

ALTER TABLE public.sales_day_status DROP CONSTRAINT zero_day_not_self_confirmed;

CREATE OR REPLACE FUNCTION private.owner_may_self_confirm(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER'], p_branch)
     AND NOT coalesce((SELECT require_second_signoff FROM public.organizations WHERE id = private.current_org_id()), true)
$$;
REVOKE ALL ON FUNCTION private.owner_may_self_confirm(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.fill_missing_day(p_branch uuid, p_date date, p_kind text, p_amount_cents bigint, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_code text; v_key text; v_amount text; v_csv text; v_id uuid; v_self boolean;
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
    v_self := private.owner_may_self_confirm(p_branch);
    INSERT INTO public.sales_day_status (organization_id, branch_id, business_date, status, note, created_by, state, decided_by, decided_at)
    VALUES (v_org, p_branch, p_date, p_kind, nullif(btrim(coalesce(p_note, '')), ''), v_user,
            CASE WHEN v_self THEN 'CONFIRMED' ELSE 'PENDING' END,
            CASE WHEN v_self THEN v_user END, CASE WHEN v_self THEN now() END)
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'ZERO_DAY_MARKED', 'sales_day', v_id::text, NULL,
      jsonb_build_object('date', p_date, 'status', p_kind, 'note', p_note, 'self_confirmed', v_self));
    RETURN jsonb_build_object('ok', true, 'state', CASE WHEN v_self THEN 'CONFIRMED' ELSE 'PENDING' END, 'id', v_id);
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
  IF private.owner_may_self_confirm(p_branch) THEN
    v_pub := public.publish_historical_batch((v_stage ->> 'id')::uuid, 1, p_amount_cents);
    IF (v_pub ->> 'ok')::boolean THEN
      RETURN jsonb_build_object('ok', true, 'state', 'PUBLISHED', 'id', v_stage -> 'id');
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'STAGED', 'id', v_stage -> 'id');
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
  IF NOT private.has_role(ARRAY['OWNER','FINANCE'], m.branch_id) THEN
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

-- Lets the app show the right buttons. Reveals only the caller's own switch state.
CREATE OR REPLACE FUNCTION public.second_signoff_required() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT require_second_signoff FROM public.organizations WHERE id = private.current_org_id()), true)
$$;
REVOKE ALL ON FUNCTION public.second_signoff_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.second_signoff_required() TO authenticated;
