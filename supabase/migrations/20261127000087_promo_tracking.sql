-- update-0087 (CHRIS Nov 27): approved promos are tracked per client, with a schedule, per-session commission and profit.
--   * Approving a promo sets up its Service log items right away:
--       - a one-service bundle (up to 15 sessions): one item, the price on session 1 and ₱0 after, like Lux Queen 10+3;
--       - a program: a "payment" item (any amount, no commission) plus one item per service, ₱0 per session.
--     Commission per session (CHRIS: "scaled commission on the price per session per total of the service in the
--     bundle", the same way Lux Queen 10+3 pays ₱80 vs ₱150 solo): the service's usual commission for one session,
--     lowered by the promo's discount. Free sessions are paid, unused sessions are not, split 60/40 when assisted.
--   * Each client who buys gets a promo record (promo_clients) with a recommended schedule. Every session logged for
--     them is linked to it, numbered (session 5 of 48), and stopped once all sessions are used or the promo has expired.
--   * services.cost_cents: product cost per session, for the running profit on the promo tracker.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'log_promo_visit') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.services ADD COLUMN IF NOT EXISTS cost_cents bigint CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 100000000);
-- parts: [{service_id (the Service log item), base_id (the usual service), name, sessions, unit_cents, commission_cents}]
ALTER TABLE public.promos ADD COLUMN IF NOT EXISTS parts jsonb;
ALTER TABLE public.promos ADD COLUMN IF NOT EXISTS pay_service_id uuid REFERENCES public.services(id);

CREATE TABLE IF NOT EXISTS public.promo_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  promo_id uuid NOT NULL REFERENCES public.promos(id),
  client_name text NOT NULL CHECK (length(btrim(client_name)) BETWEEN 2 AND 120),
  contact text CHECK (contact IS NULL OR length(contact) <= 40),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  start_on date NOT NULL,
  ends_on date NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  -- [{d: date, s: Service log item id, n: session number}], the recommended schedule
  schedule jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(schedule) = 'array'),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','DONE','CANCELLED')),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promo_clients_promo ON public.promo_clients (promo_id, state);
CREATE INDEX IF NOT EXISTS promo_clients_org ON public.promo_clients (organization_id, state);
ALTER TABLE public.promo_clients ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.promo_clients TO authenticated;
DROP POLICY IF EXISTS promo_clients_read ON public.promo_clients;
CREATE POLICY promo_clients_read ON public.promo_clients FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.is_management(private.current_user_id()));

-- The promo a session belongs to. Set only by log_promo_visit (through a setting read by the default, like session_no).
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS promo_client_id uuid REFERENCES public.promo_clients(id)
  DEFAULT nullif(current_setting('hermosa.promo_client', true), '')::uuid;
CREATE INDEX IF NOT EXISTS service_logs_promo_client ON public.service_logs (promo_client_id) WHERE promo_client_id IS NOT NULL;
-- Year programs have up to 100 sessions of one service (e.g. 48 drips).
ALTER TABLE public.service_logs DROP CONSTRAINT IF EXISTS service_logs_session_no_check;
ALTER TABLE public.service_logs ADD CONSTRAINT service_logs_session_no_check CHECK (session_no BETWEEN 1 AND 100);

-- Who may log or look up promo sessions: anyone who logs services at some branch, or management.
CREATE OR REPLACE FUNCTION private.can_log_somewhere() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_management(private.current_user_id()) OR EXISTS (
    SELECT 1 FROM public.branches b WHERE b.organization_id = private.current_org_id()
      AND private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], b.id))
$$;
REVOKE ALL ON FUNCTION private.can_log_somewhere() FROM PUBLIC, anon, authenticated;

-- Per-session commission: the usual commission for one session (set commission, else 5% of the list price),
-- times the promo price over what the sessions are worth.
CREATE OR REPLACE FUNCTION private.promo_part_commission(p_base uuid, p_unit bigint, p_price bigint, p_value bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN coalesce(p_value, 0) <= 0 THEN 0 ELSE
    round(coalesce((SELECT commission_cents FROM public.services WHERE id = p_base), round(p_unit * 0.05))::numeric
          * least(p_price, p_value) / p_value)::bigint END
$$;
REVOKE ALL ON FUNCTION private.promo_part_commission(uuid, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;

-- Set up an approved promo's Service log items. An existing item (promos approved before this update) is reused.
CREATE OR REPLACE FUNCTION private.promo_setup(p_promo uuid, p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p public.promos; it jsonb; v_parts jsonb := '[]'::jsonb; v_names text[] := '{}'; v_name text; v_svc uuid; v_comm bigint;
  v_n integer; v_prices bigint[]; v_pay uuid; v_single boolean; v_base text;
BEGIN
  SELECT * INTO p FROM public.promos WHERE id = p_promo FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p.parts IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'parts', p.parts); END IF;
  v_single := jsonb_array_length(p.items) = 1 AND p.sessions <= 15;
  -- Names first, so nothing is added when one is taken.
  IF v_single THEN
    IF p.service_id IS NULL THEN
      it := p.items -> 0;
      v_names := ARRAY[left((it ->> 'name') || ' ' || (it ->> 'paid') || '+' || (it ->> 'free') || ' (' || p.title || ')', 120)];
    END IF;
  ELSE
    IF p.service_id IS NULL THEN v_names := ARRAY[left(p.title || ' · payment', 120)]; END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(p.items) LOOP
      v_base := regexp_replace(it ->> 'name', '\s+single session$', '', 'i');
      v_names := v_names || left(v_base || ' · ' || p.title, 120);
    END LOOP;
  END IF;
  SELECT n INTO v_name FROM unnest(v_names) n
  WHERE EXISTS (SELECT 1 FROM public.services s WHERE s.organization_id = p.organization_id AND lower(btrim(s.name)) = lower(btrim(n))) LIMIT 1;
  IF v_name IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_TAKEN', 'name', v_name); END IF;

  IF v_single THEN
    it := p.items -> 0;
    v_n := (it ->> 'paid')::integer + (it ->> 'free')::integer;
    v_comm := private.promo_part_commission((it ->> 'service_id')::uuid, (it ->> 'unit_cents')::bigint, p.price_cents, p.value_cents);
    IF p.service_id IS NOT NULL THEN
      v_svc := p.service_id;
      UPDATE public.services SET commission_cents = v_comm, updated_at = now() WHERE id = v_svc;
    ELSE
      v_prices := array_fill(0::bigint, ARRAY[v_n]);
      v_prices[1] := p.price_cents;
      INSERT INTO public.services (organization_id, name, price_cents, commission_cents, session_prices, created_by, updated_at)
      VALUES (p.organization_id, v_names[1], 0, v_comm, v_prices, p_user, now()) RETURNING id INTO v_svc;
    END IF;
    v_parts := jsonb_build_array(jsonb_build_object('service_id', v_svc, 'base_id', it ->> 'service_id', 'name', it ->> 'name',
      'sessions', v_n, 'unit_cents', (it ->> 'unit_cents')::bigint, 'commission_cents', v_comm));
  ELSE
    IF p.service_id IS NOT NULL THEN
      -- The old "<title> (program)" item becomes the payment line: any amount, no commission (commission is per session now).
      v_pay := p.service_id;
      UPDATE public.services SET price_cents = NULL, commission_cents = 0, session_prices = NULL, updated_at = now() WHERE id = v_pay;
    ELSE
      INSERT INTO public.services (organization_id, name, price_cents, commission_cents, created_by, updated_at)
      VALUES (p.organization_id, v_names[1], NULL, 0, p_user, now()) RETURNING id INTO v_pay;
      v_names := v_names[2:];
    END IF;
    v_n := 0;
    FOR it IN SELECT * FROM jsonb_array_elements(p.items) LOOP
      v_n := v_n + 1;
      v_comm := private.promo_part_commission((it ->> 'service_id')::uuid, (it ->> 'unit_cents')::bigint, p.price_cents, p.value_cents);
      INSERT INTO public.services (organization_id, name, price_cents, commission_cents, created_by, updated_at)
      VALUES (p.organization_id, v_names[v_n], 0, v_comm, p_user, now()) RETURNING id INTO v_svc;
      v_parts := v_parts || jsonb_build_object('service_id', v_svc, 'base_id', it ->> 'service_id', 'name', it ->> 'name',
        'sessions', (it ->> 'paid')::integer + (it ->> 'free')::integer, 'unit_cents', (it ->> 'unit_cents')::bigint, 'commission_cents', v_comm);
    END LOOP;
  END IF;
  UPDATE public.promos SET parts = v_parts, pay_service_id = v_pay, service_id = coalesce(v_pay, v_svc), updated_at = now() WHERE id = p.id;
  RETURN jsonb_build_object('ok', true, 'parts', v_parts, 'pay_service_id', v_pay);
END $$;
REVOKE ALL ON FUNCTION private.promo_setup(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Approve: set up the Service log items and tell the rest of management.
CREATE OR REPLACE FUNCTION public.approve_promo(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); p public.promos; r jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO p FROM public.promos WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p.state <> 'DRAFT' THEN RETURN jsonb_build_object('ok', true, 'id', p.id, 'service_id', p.service_id); END IF;
  r := private.promo_setup(p.id, v_user);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  UPDATE public.promos SET state = 'APPROVED', approved_by = v_user, approved_at = now(), updated_at = now() WHERE id = p.id;
  PERFORM private.notify_management(NULL, 'PROMO', 'New promo approved: ' || p.title,
    'It''s in the Service log now. When a client buys it, pick "New client" there to start their schedule.', '/promos/' || p.id);
  RETURN jsonb_build_object('ok', true, 'id', p.id, 'parts', r -> 'parts');
END $$;
REVOKE ALL ON FUNCTION public.approve_promo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_promo(uuid) TO authenticated;

-- Hide a promo's items once it has ended and no client still has sessions left.
CREATE OR REPLACE FUNCTION private.promo_tidy(p_promo uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.promos;
BEGIN
  SELECT * INTO p FROM public.promos WHERE id = p_promo;
  IF NOT FOUND OR p.state <> 'ENDED' THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.promo_clients WHERE promo_id = p.id AND state = 'ACTIVE') THEN RETURN; END IF;
  UPDATE public.services SET active = false, updated_at = now()
  WHERE id = p.service_id OR id = p.pay_service_id
     OR id IN (SELECT (x ->> 'service_id')::uuid FROM jsonb_array_elements(coalesce(p.parts, '[]'::jsonb)) x);
END $$;
REVOKE ALL ON FUNCTION private.promo_tidy(uuid) FROM PUBLIC, anon, authenticated;

-- End a promo: no new clients. Clients who bought it can still use their sessions; the items hide when they're done.
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
  PERFORM private.promo_tidy(p.id);
  RETURN jsonb_build_object('ok', true, 'active_clients', (SELECT count(*) FROM public.promo_clients WHERE promo_id = p.id AND state = 'ACTIVE'));
END $$;
REVOKE ALL ON FUNCTION public.end_promo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_promo(uuid) TO authenticated;

-- A schedule from the app, kept only where it names one of the promo's items with a real date in the promo's dates.
CREATE OR REPLACE FUNCTION private.promo_clean_schedule(p_parts jsonb, p_schedule jsonb, p_from date, p_to date) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', x ->> 'd', 's', x ->> 's', 'n', (x ->> 'n')::integer) ORDER BY x ->> 'd', x ->> 's'), '[]'::jsonb)
  FROM (SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_schedule) = 'array' THEN p_schedule ELSE '[]'::jsonb END) x LIMIT 400) q
  WHERE jsonb_typeof(x) = 'object' AND (x ->> 'd') ~ '^\d{4}-\d{2}-\d{2}$' AND (x ->> 'n') ~ '^\d{1,3}$'
    AND (x ->> 'd') BETWEEN p_from::text AND p_to::text
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_parts) pt WHERE pt ->> 'service_id' = x ->> 's')
$$;
REVOKE ALL ON FUNCTION private.promo_clean_schedule(jsonb, jsonb, date, date) FROM PUBLIC, anon, authenticated;

-- Log a promo session or payment for a client. p_promo_client null + p_new {promo_id, contact, schedule} = a new client
-- starting the promo with this visit. Everything else is passed on to log_client_visit unchanged (always as Paid).
CREATE OR REPLACE FUNCTION public.log_promo_visit(p_promo_client uuid, p_new jsonb, p_branch uuid, p_date date, p_service uuid,
  p_amount_cents bigint, p_type text, p_employee uuid, p_partner uuid, p_note text, p_client text, p_price_note text,
  p_folder uuid, p_photos jsonb, p_share boolean, p_session integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  e public.promo_clients; p public.promos; part jsonb; v_pay boolean; v_used integer := 0; v_n integer := 1; v_total integer := 1;
  v_paid bigint := 0; r jsonb; v_new boolean := p_promo_client IS NULL; v_client text := nullif(btrim(coalesce(p_client, '')), '');
  v_dup uuid; v_contact text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN RETURN private.deny(p_branch, 'service_log'); END IF;
  IF v_new THEN
    SELECT * INTO p FROM public.promos WHERE id = nullif(p_new ->> 'promo_id', '')::uuid AND organization_id = v_org;
    IF NOT FOUND OR p.parts IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
    IF p.state <> 'APPROVED' THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_NOT_RUNNING'); END IF;
    IF v_client IS NULL OR length(v_client) NOT BETWEEN 2 AND 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'CLIENT_NAME_REQUIRED'); END IF;
    SELECT id INTO v_dup FROM public.promo_clients WHERE promo_id = p.id AND state = 'ACTIVE' AND lower(btrim(client_name)) = lower(v_client) LIMIT 1;
    IF v_dup IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_CLIENT_EXISTS', 'id', v_dup); END IF;
  ELSE
    SELECT * INTO e FROM public.promo_clients WHERE id = p_promo_client AND organization_id = v_org;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
    IF e.state <> 'ACTIVE' THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_CLIENT_CLOSED'); END IF;
    SELECT * INTO p FROM public.promos WHERE id = e.promo_id;
    IF p_date > e.ends_on THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_EXPIRED', 'ends_on', e.ends_on); END IF;
    IF p_date < e.start_on THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  END IF;
  SELECT x INTO part FROM jsonb_array_elements(p.parts) x WHERE x ->> 'service_id' = p_service::text;
  v_pay := p.pay_service_id IS NOT NULL AND p_service = p.pay_service_id;
  IF part IS NULL AND NOT v_pay THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PROMO_SERVICE'); END IF;
  IF NOT v_new THEN
    SELECT coalesce(sum(amount_paid_cents), 0) INTO v_paid FROM public.service_logs WHERE promo_client_id = e.id AND state <> 'REJECTED';
  END IF;
  IF part IS NOT NULL THEN
    v_total := (part ->> 'sessions')::integer;
    IF NOT v_new THEN
      SELECT count(*) INTO v_used FROM public.service_logs WHERE promo_client_id = e.id AND service_id = p_service AND state <> 'REJECTED';
    END IF;
    IF v_used >= v_total THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_USED_UP', 'of', v_total); END IF;
    v_n := v_used + 1;
    -- A bundle's amount follows its session; the form shows the client's next session, so a different one is a mix-up.
    IF p_session IS NOT NULL AND p_session <> v_n AND p.pay_service_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'PROMO_SESSION', 'session', v_n, 'of', v_total);
    END IF;
    -- Program sessions are already paid for: money goes on the payment line.
    IF p.pay_service_id IS NOT NULL AND coalesce(p_amount_cents, 0) <> 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_PAY_LINE'); END IF;
  ELSE
    IF coalesce(p_amount_cents, 0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
    IF v_paid + p_amount_cents > p.price_cents THEN
      RETURN jsonb_build_object('ok', false, 'error', 'PROMO_OVERPAID', 'balance', greatest(0, p.price_cents - v_paid));
    END IF;
  END IF;

  BEGIN
    IF v_new THEN
      v_contact := nullif(left(btrim(coalesce(p_new ->> 'contact', '')), 40), '');
      INSERT INTO public.promo_clients (organization_id, promo_id, client_name, contact, branch_id, start_on, ends_on, price_cents, schedule, created_by)
      VALUES (v_org, p.id, v_client, v_contact, p_branch, p_date, (p_date + make_interval(months => p.valid_months))::date - 1, p.price_cents,
        private.promo_clean_schedule(p.parts, p_new -> 'schedule', p_date, ((p_date + make_interval(months => p.valid_months))::date - 1)), v_user)
      RETURNING * INTO e;
    END IF;
    PERFORM set_config('hermosa.promo_client', e.id::text, true);
    PERFORM set_config('hermosa.session_no', v_n::text, true);
    r := public.log_client_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, p_note, 'PAID', true,
      e.client_name, p_price_note, p_folder, p_photos, p_share);
    PERFORM set_config('hermosa.promo_client', '', true);
    PERFORM set_config('hermosa.session_no', '', true);
    IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RAISE EXCEPTION 'PROMO_ROLLBACK'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'PROMO_ROLLBACK' THEN RAISE; END IF;
    PERFORM set_config('hermosa.promo_client', '', true);
    PERFORM set_config('hermosa.session_no', '', true);
    RETURN r;
  END;

  -- All sessions used: the client's promo is done.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.parts) x
                 WHERE (SELECT count(*) FROM public.service_logs l WHERE l.promo_client_id = e.id AND l.service_id = (x ->> 'service_id')::uuid
                          AND l.state <> 'REJECTED') < (x ->> 'sessions')::integer) THEN
    UPDATE public.promo_clients SET state = 'DONE', updated_at = now() WHERE id = e.id;
    PERFORM private.promo_tidy(p.id);
  END IF;
  IF v_new THEN
    PERFORM private.audit(p_branch, 'PROMO_CLIENT_STARTED', 'promo_client', e.id::text, NULL, jsonb_build_object('promo', p.id, 'price_cents', p.price_cents));
  END IF;
  RETURN r || jsonb_build_object('promo_client', e.id, 'session', v_n, 'of', v_total, 'new', v_new, 'payment', v_pay);
END $$;
REVOKE ALL ON FUNCTION public.log_promo_visit(uuid, jsonb, uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, uuid, jsonb, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_promo_visit(uuid, jsonb, uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, uuid, jsonb, boolean, integer) TO authenticated;

-- For the Service log form: the promo items and the clients with sessions left.
CREATE OR REPLACE FUNCTION public.promo_log_options() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_log_somewhere() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  RETURN jsonb_build_object('ok', true,
    'promos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'state', p.state, 'months', p.valid_months,
        'price_cents', p.price_cents, 'pay_service_id', p.pay_service_id, 'parts', p.parts) ORDER BY p.approved_at)
      FROM public.promos p WHERE p.organization_id = v_org AND p.parts IS NOT NULL
        AND (p.state = 'APPROVED' OR EXISTS (SELECT 1 FROM public.promo_clients c WHERE c.promo_id = p.id AND c.state = 'ACTIVE'))), '[]'::jsonb),
    'clients', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'promo_id', c.promo_id, 'client', c.client_name, 'branch_id', c.branch_id,
        'start_on', c.start_on, 'ends_on', c.ends_on, 'price_cents', c.price_cents,
        'paid_cents', (SELECT coalesce(sum(l.amount_paid_cents), 0) FROM public.service_logs l WHERE l.promo_client_id = c.id AND l.state <> 'REJECTED'),
        'used', (SELECT coalesce(jsonb_object_agg(u.service_id, u.n), '{}'::jsonb) FROM (
            SELECT l.service_id, count(*) n FROM public.service_logs l WHERE l.promo_client_id = c.id AND l.state <> 'REJECTED' GROUP BY l.service_id) u))
        ORDER BY c.client_name)
      FROM public.promo_clients c WHERE c.organization_id = v_org AND c.state = 'ACTIVE'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.promo_log_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_log_options() TO authenticated;

-- One client's promo: the plan and the sessions done, for the schedule page (staff and management).
CREATE OR REPLACE FUNCTION public.promo_client_card(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); e public.promo_clients; p public.promos;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_log_somewhere() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO e FROM public.promo_clients WHERE id = p_id AND organization_id = v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  SELECT * INTO p FROM public.promos WHERE id = e.promo_id;
  RETURN jsonb_build_object('ok', true,
    'client', jsonb_build_object('id', e.id, 'name', e.client_name, 'contact', e.contact, 'branch_id', e.branch_id,
      'branch', (SELECT name FROM public.branches WHERE id = e.branch_id), 'start_on', e.start_on, 'ends_on', e.ends_on,
      'price_cents', e.price_cents, 'schedule', e.schedule, 'state', e.state),
    'promo', jsonb_build_object('id', p.id, 'title', p.title, 'tagline', p.tagline, 'parts', p.parts, 'pay_service_id', p.pay_service_id, 'state', p.state),
    'logs', coalesce((SELECT jsonb_agg(jsonb_build_object('service_id', l.service_id, 'date', l.service_date, 'n', l.session_no,
        'amount_cents', l.amount_paid_cents, 'state', l.state) ORDER BY l.service_date, l.created_at)
      FROM public.service_logs l WHERE l.promo_client_id = e.id AND l.state <> 'REJECTED'), '[]'::jsonb),
    'manage', private.is_management(private.current_user_id()));
END $$;
REVOKE ALL ON FUNCTION public.promo_client_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_client_card(uuid) TO authenticated;

-- Change a client's promo: SCHEDULE (new plan, staff and management), CONTACT, EXTEND by months or CANCEL (owners and the GM).
CREATE OR REPLACE FUNCTION public.update_promo_client(p_id uuid, p_action text, p_schedule jsonb, p_months integer, p_contact text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); e public.promo_clients; p public.promos;
  v_mgmt boolean := private.is_management(private.current_user_id()); v_act text := upper(coalesce(p_action, ''));
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_log_somewhere() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO e FROM public.promo_clients WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  SELECT * INTO p FROM public.promos WHERE id = e.promo_id;
  IF v_act IN ('EXTEND', 'CANCEL', 'REOPEN') AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF v_act = 'SCHEDULE' THEN
    UPDATE public.promo_clients SET schedule = private.promo_clean_schedule(p.parts, p_schedule, e.start_on, e.ends_on), updated_at = now() WHERE id = e.id;
  ELSIF v_act = 'CONTACT' THEN
    UPDATE public.promo_clients SET contact = nullif(left(btrim(coalesce(p_contact, '')), 40), ''), updated_at = now() WHERE id = e.id;
  ELSIF v_act = 'EXTEND' THEN
    IF p_months IS NULL OR p_months NOT BETWEEN 1 AND 6 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
    UPDATE public.promo_clients SET ends_on = (ends_on + make_interval(months => p_months))::date, updated_at = now() WHERE id = e.id;
  ELSIF v_act = 'CANCEL' THEN
    IF e.state <> 'ACTIVE' THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_CLIENT_CLOSED'); END IF;
    UPDATE public.promo_clients SET state = 'CANCELLED', updated_at = now() WHERE id = e.id;
    PERFORM private.promo_tidy(p.id);
  ELSIF v_act = 'REOPEN' THEN
    UPDATE public.promo_clients SET state = 'ACTIVE', updated_at = now() WHERE id = e.id AND state = 'CANCELLED';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  PERFORM private.audit(e.branch_id, 'PROMO_CLIENT_' || v_act, 'promo_client', e.id::text, NULL, jsonb_build_object('months', p_months));
  RETURN jsonb_build_object('ok', true, 'id', e.id);
END $$;
REVOKE ALL ON FUNCTION public.update_promo_client(uuid, text, jsonb, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_promo_client(uuid, text, jsonb, integer, text) TO authenticated;

-- Product cost per session (owners and the GM), for the promo tracker's profit.
CREATE OR REPLACE FUNCTION public.set_service_cost(p_service uuid, p_cost_cents bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF p_cost_cents IS NOT NULL AND (p_cost_cents < 0 OR p_cost_cents > 100000000) THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  UPDATE public.services SET cost_cents = p_cost_cents, updated_at = now() WHERE id = p_service AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_service_cost(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_service_cost(uuid, bigint) TO authenticated;

-- Promos approved before this update get the same set-up (a program's old item becomes its payment line).
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT id, coalesce(approved_by, created_by) AS who FROM public.promos WHERE state = 'APPROVED' AND parts IS NULL LOOP
    PERFORM private.promo_setup(p.id, p.who);
  END LOOP;
END $$;
