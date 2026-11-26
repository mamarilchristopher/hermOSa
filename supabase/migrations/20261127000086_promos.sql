-- update-0086 (CHRIS Nov 27): Promo generator. "Sales. sales. sales. Retention and lifetime value."
--   * Sales › Promos (owners and the GM): build a bundle (e.g. HIFU Arms 5+2) or a year-long program, see the price and
--     a ready-to-post image update live, then approve it.
--   * Approving a bundle adds it to the price list as a Sales log item, like the Gluta / VContour bundles: the bundle
--     price on session 1, ₱0 on the rest, commission = 5% of the bundle price spread over every session.
--     A program (several services, or more than 15 sessions) is added as one item sold at the program price, 5% commission.
--   * Every Monday, owners and the GM get one notice that this week's promo ideas are ready.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'approve_promo') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

CREATE TABLE IF NOT EXISTS public.promos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 80),
  tagline text CHECK (tagline IS NULL OR length(tagline) <= 160),
  -- [{service_id, name, paid, free, unit_cents}]
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 8),
  price_cents bigint NOT NULL CHECK (price_cents > 0 AND price_cents <= 100000000),
  value_cents bigint NOT NULL CHECK (value_cents >= 0),
  sessions integer NOT NULL CHECK (sessions BETWEEN 1 AND 200),
  valid_months integer NOT NULL DEFAULT 12 CHECK (valid_months BETWEEN 1 AND 24),
  ends_on date,
  model text CHECK (model IS NULL OR model ~ '^M[0-9]{2,3}$'),
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','SUGGESTED')),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','ENDED')),
  service_id uuid REFERENCES public.services(id),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES public.app_users(id),
  approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS promos_org_state ON public.promos (organization_id, state, created_at DESC);
ALTER TABLE public.promos ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.promos TO authenticated;
DROP POLICY IF EXISTS promos_read ON public.promos;
CREATE POLICY promos_read ON public.promos FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.is_management(private.current_user_id()));

-- Save (create or update) a draft promo. Owners and the GM.
CREATE OR REPLACE FUNCTION public.save_promo(p_id uuid, p_title text, p_tagline text, p_items jsonb, p_price_cents bigint,
  p_valid_months integer, p_ends_on date, p_model text, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid;
  it jsonb; v_items jsonb := '[]'; v_value bigint := 0; v_sessions integer := 0; s record; v_paid integer; v_free integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 3 AND 80 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_TITLE'); END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  -- Re-read each service's list price; the client's numbers are not trusted.
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_paid := coalesce((it ->> 'paid')::integer, 0); v_free := coalesce((it ->> 'free')::integer, 0);
    IF v_paid < 1 OR v_paid > 50 OR v_free < 0 OR v_free > 50 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_COUNTS'); END IF;
    SELECT id, name, price_cents INTO s FROM public.services
    WHERE id = (it ->> 'service_id')::uuid AND organization_id = v_org AND active AND NOT is_meds;
    IF NOT FOUND OR coalesce(s.price_cents, 0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;
    v_items := v_items || jsonb_build_object('service_id', s.id, 'name', s.name, 'paid', v_paid, 'free', v_free, 'unit_cents', s.price_cents);
    v_value := v_value + s.price_cents * (v_paid + v_free);
    v_sessions := v_sessions + v_paid + v_free;
  END LOOP;
  IF p_price_cents IS NULL OR p_price_cents <= 0 OR p_price_cents > v_value THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_PRICE'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.promos (organization_id, title, tagline, items, price_cents, value_cents, sessions, valid_months, ends_on, model, source, created_by)
    VALUES (v_org, btrim(p_title), nullif(btrim(coalesce(p_tagline, '')), ''), v_items, p_price_cents, v_value, v_sessions,
            least(24, greatest(1, coalesce(p_valid_months, 12))), p_ends_on, nullif(p_model, ''), coalesce(nullif(p_source, ''), 'MANUAL'), v_user)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.promos SET title = btrim(p_title), tagline = nullif(btrim(coalesce(p_tagline, '')), ''), items = v_items,
      price_cents = p_price_cents, value_cents = v_value, sessions = v_sessions, valid_months = least(24, greatest(1, coalesce(p_valid_months, 12))),
      ends_on = p_ends_on, model = nullif(p_model, ''), updated_at = now()
    WHERE id = p_id AND organization_id = v_org AND state = 'DRAFT'
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.save_promo(uuid, text, text, jsonb, bigint, integer, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_promo(uuid, text, text, jsonb, bigint, integer, date, text, text) TO authenticated;

-- Approve: add the Sales log item and tell the rest of management.
CREATE OR REPLACE FUNCTION public.approve_promo(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); p public.promos;
  v_name text; v_svc uuid; v_single boolean; v_comm bigint; v_prices bigint[];
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO p FROM public.promos WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p.state <> 'DRAFT' THEN RETURN jsonb_build_object('ok', true, 'id', p.id, 'service_id', p.service_id); END IF;
  v_single := jsonb_array_length(p.items) = 1 AND p.sessions <= 15;
  IF v_single THEN
    -- e.g. "Hifu Arms 5+2 (Summer Arms Sprint)"
    v_name := (p.items -> 0 ->> 'name') || ' ' || (p.items -> 0 ->> 'paid') || '+' || (p.items -> 0 ->> 'free') || ' (' || p.title || ')';
    v_comm := round(p.price_cents * 0.05 / p.sessions);
    v_prices := array_fill(0::bigint, ARRAY[p.sessions]);
    v_prices[1] := p.price_cents;
  ELSE
    v_name := p.title || ' (program)';
    v_comm := round(p.price_cents * 0.05);
    v_prices := NULL;
  END IF;
  v_name := left(v_name, 120);
  IF EXISTS (SELECT 1 FROM public.services WHERE organization_id = v_org AND lower(btrim(name)) = lower(btrim(v_name))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NAME_TAKEN', 'name', v_name);
  END IF;
  INSERT INTO public.services (organization_id, name, price_cents, commission_cents, session_prices, created_by, updated_at)
  VALUES (v_org, v_name, CASE WHEN v_single THEN 0 ELSE p.price_cents END, v_comm, v_prices, v_user, now())
  RETURNING id INTO v_svc;
  UPDATE public.promos SET state = 'APPROVED', service_id = v_svc, approved_by = v_user, approved_at = now(), updated_at = now() WHERE id = p.id;
  PERFORM private.notify_management(NULL, 'PROMO', 'New promo approved: ' || p.title,
    'Added to the Service log as "' || v_name || '".', '/promos');
  RETURN jsonb_build_object('ok', true, 'id', p.id, 'service_id', v_svc, 'service', v_name);
END $$;
REVOKE ALL ON FUNCTION public.approve_promo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_promo(uuid) TO authenticated;

-- End a promo (its Sales log item is switched off) or delete a draft.
CREATE OR REPLACE FUNCTION public.end_promo(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); p public.promos;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO p FROM public.promos WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p.state = 'DRAFT' THEN DELETE FROM public.promos WHERE id = p.id; RETURN jsonb_build_object('ok', true, 'deleted', true); END IF;
  UPDATE public.promos SET state = 'ENDED', updated_at = now() WHERE id = p.id;
  IF p.service_id IS NOT NULL THEN UPDATE public.services SET active = false, updated_at = now() WHERE id = p.service_id; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.end_promo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_promo(uuid) TO authenticated;

-- Sales per service for the promo ideas: the last 4 weeks and the 4 weeks before (rejected entries left out).
CREATE OR REPLACE FUNCTION public.promo_service_stats() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  IF v_user IS NULL OR NOT private.is_management(v_user) THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('service_id', service_id, 'recent', recent, 'before', before, 'recent_cents', recent_cents))
    FROM (
      SELECT l.service_id,
        count(*) FILTER (WHERE l.service_date > v_today - 28) AS recent,
        count(*) FILTER (WHERE l.service_date <= v_today - 28) AS before,
        coalesce(sum(l.amount_paid_cents) FILTER (WHERE l.service_date > v_today - 28), 0) AS recent_cents
      FROM public.service_logs l
      WHERE l.organization_id = v_org AND l.state <> 'REJECTED' AND l.service_date > v_today - 56 AND l.service_date <= v_today
      GROUP BY l.service_id
    ) t), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.promo_service_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_service_stats() TO authenticated;

-- Monday notice: the first time anyone in management opens the app on a Monday (Manila), everyone in management
-- gets one "This week's promo ideas are ready" notice. Called by the app; at most once per week.
CREATE OR REPLACE FUNCTION public.promo_week_notice() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date; v_title text; v_n integer;
BEGIN
  IF v_user IS NULL OR NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false); END IF;
  IF extract(isodow FROM v_today) <> 1 THEN RETURN jsonb_build_object('ok', true, 'sent', 0); END IF;
  v_title := 'Promo ideas for the week of ' || to_char(v_today, 'Mon FMDD');
  PERFORM pg_advisory_xact_lock(hashtext('promo_week_notice' || v_org::text));
  IF EXISTS (SELECT 1 FROM public.notifications WHERE organization_id = v_org AND kind = 'PROMO_WEEK' AND title = v_title) THEN
    RETURN jsonb_build_object('ok', true, 'sent', 0);
  END IF;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT v_org, u.id, 'PROMO_WEEK', v_title,
    'Fresh promo ideas from last weeks'' sales, slow services and the coming season. Open one, adjust it and approve.', '/promos', NULL::uuid
  FROM public.app_users u JOIN public.role_grants g ON g.user_id = u.id
  WHERE u.organization_id = v_org AND u.active AND coalesce(u.join_status, 'APPROVED') = 'APPROVED'
    AND g.revoked_at IS NULL AND g.branch_id IS NULL AND g.role_code IN ('OWNER','MANAGER');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'sent', v_n);
END $$;
REVOKE ALL ON FUNCTION public.promo_week_notice() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_week_notice() TO authenticated;

SELECT 'update-0086 is installed' AS result;
