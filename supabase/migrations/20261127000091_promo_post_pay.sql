-- update-0091 (CHRIS Nov 27): Approve and post, payment options and the promo kit.
--   * Payment options per promo: full payment only, or installments (up to 2, 3, 4 or 6 monthly payments at the same
--     total, no interest). An installment promo gets a payment line in the Service log; each client picks full or their
--     number of payments on the first visit, and their sessions follow their payments (each payment unlocks its share).
--   * Approve and post: the promo's FB post and Story images are saved, its posting calendar is made (launch day:
--     FB feed + Story on all 4 pages; then reminder, "last 3 days" and "last day" Stories), and once the launch is
--     posted the app announces it in the All staff chat (photo + details, @all) from the owner who approved it.
--   * The posts can be published by the app straight to the 4 Facebook pages (after the one-time Meta connection), or
--     posted by the CSRs from Promo posts with a "Posted on all 4 pages" button.
--   * Bookings: Arriving and Did not arrive statuses; a sale logged from the booking's name is linked to it (marks it
--     Done); the waiver name, when different from the Facebook name, is used in all records.
--   * Service log: "Service has before and after photo?" (unticked = only the signed waiver is needed).
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'promo_post_done') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.promos ADD COLUMN IF NOT EXISTS pay_options text CHECK (pay_options IS NULL OR pay_options IN ('FULL','INSTALLMENT'));
ALTER TABLE public.promos ADD COLUMN IF NOT EXISTS max_payments smallint CHECK (max_payments IS NULL OR max_payments BETWEEN 2 AND 6);
ALTER TABLE public.promo_clients ADD COLUMN IF NOT EXISTS payments smallint NOT NULL DEFAULT 1 CHECK (payments BETWEEN 1 AND 6);

-- Who posts promos: owners, the GM, CSRs and marketing.
CREATE OR REPLACE FUNCTION private.is_poster(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_management(p_user) OR EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = p_user AND g.revoked_at IS NULL
    AND g.role_code IN ('CSR','MARKETING'))
$$;
REVOKE ALL ON FUNCTION private.is_poster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_poster(uuid) TO authenticated;

-- Payment options of a draft (owners and the GM). Full only, or installments up to p_max monthly payments.
CREATE OR REPLACE FUNCTION public.set_promo_payment(p_id uuid, p_options text, p_max integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_opt text := upper(coalesce(p_options, 'FULL'));
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF v_opt NOT IN ('FULL','INSTALLMENT') OR (v_opt = 'INSTALLMENT' AND (p_max IS NULL OR p_max NOT BETWEEN 2 AND 6)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  UPDATE public.promos SET pay_options = v_opt, max_payments = CASE WHEN v_opt = 'INSTALLMENT' THEN p_max END, updated_at = now()
  WHERE id = p_id AND organization_id = private.current_org_id() AND state = 'DRAFT';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_promo_payment(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_promo_payment(uuid, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION private.promo_setup(p_promo uuid, p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p public.promos; it jsonb; v_parts jsonb := '[]'::jsonb; v_names text[] := '{}'; v_name text; v_svc uuid; v_comm bigint;
  v_n integer; v_prices bigint[]; v_pay uuid; v_single boolean; v_base text;
BEGIN
  SELECT * INTO p FROM public.promos WHERE id = p_promo FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p.parts IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'parts', p.parts); END IF;
  -- update-0091: a promo sold on installments always gets a payment line, so money and sessions are logged apart.
  v_single := jsonb_array_length(p.items) = 1 AND p.sessions <= 15 AND coalesce(p.pay_options, 'FULL') <> 'INSTALLMENT';
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

-- update-0091: one more argument (before/after photos taken?), so the old version is replaced.
DROP FUNCTION IF EXISTS public.log_promo_visit(uuid, jsonb, uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, uuid, jsonb, boolean, integer);
CREATE OR REPLACE FUNCTION public.log_promo_visit(p_promo_client uuid, p_new jsonb, p_branch uuid, p_date date, p_service uuid,
  p_amount_cents bigint, p_type text, p_employee uuid, p_partner uuid, p_note text, p_client text, p_price_note text,
  p_folder uuid, p_photos jsonb, p_share boolean, p_session integer, p_before_after boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  e public.promo_clients; p public.promos; part jsonb; v_pay boolean; v_used integer := 0; v_n integer := 1; v_total integer := 1;
  v_paid bigint := 0; r jsonb; v_new boolean := p_promo_client IS NULL; v_client text := nullif(btrim(coalesce(p_client, '')), '');
  v_dup uuid; v_contact text; v_payments integer := 1; v_used_all integer := 0; v_allowed integer;
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
    -- update-0091: on a promo with payment options, sessions follow payments (each payment unlocks its share).
    IF p.pay_options IS NOT NULL AND p.pay_service_id IS NOT NULL THEN
      IF NOT v_new THEN
        SELECT count(*) INTO v_used_all FROM public.service_logs WHERE promo_client_id = e.id AND state <> 'REJECTED'
          AND service_id IN (SELECT (x ->> 'service_id')::uuid FROM jsonb_array_elements(p.parts) x);
      END IF;
      v_allowed := CASE WHEN p.price_cents > 0 THEN least(p.sessions, (p.sessions::bigint * v_paid / p.price_cents)::integer) ELSE p.sessions END;
      IF v_used_all + 1 > v_allowed THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PROMO_PAY_FIRST',
          'due', greatest(0, (p.price_cents * (v_used_all + 1) + p.sessions - 1) / p.sessions - v_paid), 'used', v_used_all, 'of', p.sessions);
      END IF;
    END IF;
  ELSE
    IF coalesce(p_amount_cents, 0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
    IF v_paid + p_amount_cents > p.price_cents THEN
      RETURN jsonb_build_object('ok', false, 'error', 'PROMO_OVERPAID', 'balance', greatest(0, p.price_cents - v_paid));
    END IF;
  END IF;

  BEGIN
    IF v_new THEN
      v_contact := nullif(left(btrim(coalesce(p_new ->> 'contact', '')), 40), '');
      -- update-0091: full payment (1) or the client's number of monthly payments, up to the promo's limit.
      v_payments := CASE WHEN p.pay_options = 'INSTALLMENT' AND coalesce(p_new ->> 'payments', '') ~ '^[1-6]$'
                         THEN least(coalesce(p.max_payments, 1), (p_new ->> 'payments')::integer) ELSE 1 END;
      INSERT INTO public.promo_clients (organization_id, promo_id, client_name, contact, branch_id, start_on, ends_on, price_cents, schedule, created_by, payments)
      VALUES (v_org, p.id, v_client, v_contact, p_branch, p_date, (p_date + make_interval(months => p.valid_months))::date - 1, p.price_cents,
        private.promo_clean_schedule(p.parts, p_new -> 'schedule', p_date, ((p_date + make_interval(months => p.valid_months))::date - 1)), v_user, v_payments)
      RETURNING * INTO e;
    END IF;
    PERFORM set_config('hermosa.promo_client', e.id::text, true);
    PERFORM set_config('hermosa.session_no', v_n::text, true);
    PERFORM set_config('hermosa.no_ba', CASE WHEN p_before_after IS FALSE THEN '1' ELSE '' END, true);
    r := public.log_client_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, p_note, 'PAID', true,
      e.client_name, p_price_note, p_folder, p_photos, p_share);
    PERFORM set_config('hermosa.promo_client', '', true);
    PERFORM set_config('hermosa.session_no', '', true);
    PERFORM set_config('hermosa.no_ba', '', true);
    IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RAISE EXCEPTION 'PROMO_ROLLBACK'; END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'PROMO_ROLLBACK' THEN RAISE; END IF;
    PERFORM set_config('hermosa.promo_client', '', true);
    PERFORM set_config('hermosa.session_no', '', true);
    PERFORM set_config('hermosa.no_ba', '', true);
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
REVOKE ALL ON FUNCTION public.log_promo_visit(uuid, jsonb, uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, uuid, jsonb, boolean, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_promo_visit(uuid, jsonb, uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, uuid, jsonb, boolean, integer, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.promo_log_options() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id();
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_log_somewhere() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  RETURN jsonb_build_object('ok', true,
    'promos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'state', p.state, 'months', p.valid_months,
        'price_cents', p.price_cents, 'pay_service_id', p.pay_service_id, 'parts', p.parts,
        'sessions', p.sessions, 'pay_options', p.pay_options, 'max_payments', p.max_payments) ORDER BY p.approved_at)
      FROM public.promos p WHERE p.organization_id = v_org AND p.parts IS NOT NULL
        AND (p.state = 'APPROVED' OR EXISTS (SELECT 1 FROM public.promo_clients c WHERE c.promo_id = p.id AND c.state = 'ACTIVE'))), '[]'::jsonb),
    'clients', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'promo_id', c.promo_id, 'client', c.client_name, 'branch_id', c.branch_id,
        'start_on', c.start_on, 'ends_on', c.ends_on, 'price_cents', c.price_cents, 'payments', c.payments,
        'paid_cents', (SELECT coalesce(sum(l.amount_paid_cents), 0) FROM public.service_logs l WHERE l.promo_client_id = c.id AND l.state <> 'REJECTED'),
        'used', (SELECT coalesce(jsonb_object_agg(u.service_id, u.n), '{}'::jsonb) FROM (
            SELECT l.service_id, count(*) n FROM public.service_logs l WHERE l.promo_client_id = c.id AND l.state <> 'REJECTED' GROUP BY l.service_id) u))
        ORDER BY c.client_name)
      FROM public.promo_clients c WHERE c.organization_id = v_org AND c.state = 'ACTIVE'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.promo_log_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_log_options() TO authenticated;

-- ---------- Promo posts: the posting calendar of each approved promo ----------
CREATE TABLE IF NOT EXISTS public.promo_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  promo_id uuid NOT NULL REFERENCES public.promos(id) ON DELETE CASCADE,
  title text NOT NULL,
  slot text NOT NULL CHECK (slot IN ('LAUNCH','REMINDER','LAST_DAYS','LAST_DAY')),
  due_on date NOT NULL,
  feed_path text, story_path text,                      -- promo-posts/<promo>/<file>.jpg
  feed_caption text CHECK (feed_caption IS NULL OR length(feed_caption) <= 3000),
  story_caption text CHECK (story_caption IS NULL OR length(story_caption) <= 1000),
  pricing_text text CHECK (pricing_text IS NULL OR length(pricing_text) <= 3000),
  announce_text text CHECK (announce_text IS NULL OR length(announce_text) <= 4000),
  announce_photo text,                                  -- chat/<All staff room>/<approver>/<file>.jpg
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','POSTED','SKIPPED')),
  via text CHECK (via IS NULL OR via IN ('CSR','META')),
  meta_result jsonb,                                    -- per page: {page: {feed: id, story: id, error}}
  posted_by uuid REFERENCES public.app_users(id),
  posted_at timestamptz,
  announced_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_id, slot)
);
CREATE INDEX IF NOT EXISTS promo_posts_due ON public.promo_posts (organization_id, state, due_on);
ALTER TABLE public.promo_posts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.promo_posts TO authenticated;
DROP POLICY IF EXISTS promo_posts_read ON public.promo_posts;
CREATE POLICY promo_posts_read ON public.promo_posts FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.is_poster(private.current_user_id()));

-- Post images: promo-posts/<promo id>/<file>.jpg. Management uploads; posters (CSRs too) can see.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('promo-posts', 'promo-posts', false, 10485760, ARRAY['image/jpeg','image/png'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS promo_posts_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY promo_posts_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'promo-posts' AND private.is_management(private.current_user_id()))$p$;
    EXECUTE 'DROP POLICY IF EXISTS promo_posts_update ON storage.objects';
    EXECUTE $p$CREATE POLICY promo_posts_update ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'promo-posts' AND private.is_management(private.current_user_id()))$p$;
    EXECUTE 'DROP POLICY IF EXISTS promo_posts_read ON storage.objects';
    EXECUTE $p$CREATE POLICY promo_posts_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'promo-posts' AND private.is_poster(private.current_user_id()))$p$;
  END IF;
END $$;

-- Make (or remake) an approved promo's posting calendar. p_posts: [{slot, due_on, feed_path, story_path, feed_caption, story_caption}].
-- Posts already up stay as they are. CSRs get a notice for the launch.
CREATE OR REPLACE FUNCTION public.promo_post_ready(p_promo uuid, p_posts jsonb, p_pricing text, p_announce text, p_announce_photo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); p public.promos; x jsonb; v_room uuid; v_n integer := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO p FROM public.promos WHERE id = p_promo AND organization_id = v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p.state <> 'APPROVED' THEN RETURN jsonb_build_object('ok', false, 'error', 'PROMO_NOT_RUNNING'); END IF;
  IF p_posts IS NULL OR jsonb_typeof(p_posts) <> 'array' OR jsonb_array_length(p_posts) NOT BETWEEN 1 AND 4 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT id INTO v_room FROM public.chat_rooms WHERE organization_id = v_org AND auto_key = 'ALL';
  -- The announcement photo must be the approver's own upload in the All staff chat folder.
  IF p_announce_photo IS NOT NULL AND (v_room IS NULL OR p_announce_photo !~ ('^' || v_room::text || '/' || v_user::text || '/[A-Za-z0-9-]+\.(jpg|png)$')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  DELETE FROM public.promo_posts WHERE promo_id = p.id AND state = 'READY';
  FOR x IN SELECT * FROM jsonb_array_elements(p_posts) LOOP
    IF coalesce(x ->> 'slot', '') NOT IN ('LAUNCH','REMINDER','LAST_DAYS','LAST_DAY') OR coalesce(x ->> 'due_on', '') !~ '^\d{4}-\d{2}-\d{2}$'
       OR coalesce(x ->> 'story_path', '') !~ ('^' || p.id::text || '/[A-Za-z0-9-]+\.jpg$')
       OR (x ->> 'feed_path' IS NOT NULL AND (x ->> 'feed_path') !~ ('^' || p.id::text || '/[A-Za-z0-9-]+\.jpg$')) THEN
      RAISE EXCEPTION 'BAD_POST';
    END IF;
    INSERT INTO public.promo_posts (organization_id, promo_id, title, slot, due_on, feed_path, story_path, feed_caption, story_caption,
      pricing_text, announce_text, announce_photo, created_by)
    VALUES (v_org, p.id, p.title, x ->> 'slot', (x ->> 'due_on')::date, x ->> 'feed_path', x ->> 'story_path',
      left(x ->> 'feed_caption', 3000), left(x ->> 'story_caption', 1000), left(p_pricing, 3000),
      CASE WHEN x ->> 'slot' = 'LAUNCH' THEN left(p_announce, 4000) END, CASE WHEN x ->> 'slot' = 'LAUNCH' THEN p_announce_photo END, v_user)
    ON CONFLICT (promo_id, slot) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END LOOP;
  -- CSRs (and marketing) are told there's a new promo to post.
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT v_org, u.id, 'PROMO_POST', left('New promo to post: ' || p.title, 200),
    'FB post + Story on all 4 pages. Open Promo posts for the photos and captions.', '/promos/post', v_user
  FROM public.app_users u JOIN public.role_grants g ON g.user_id = u.id
  WHERE u.organization_id = v_org AND u.active AND g.revoked_at IS NULL AND g.role_code IN ('CSR','MARKETING') AND u.id <> v_user
    AND EXISTS (SELECT 1 FROM public.promo_posts pp WHERE pp.promo_id = p.id AND pp.slot = 'LAUNCH' AND pp.state = 'READY');
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'BAD_POST' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.promo_post_ready(uuid, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_post_ready(uuid, jsonb, text, text, text) TO authenticated;

-- The All staff announcement for a launch, sent once, from the owner who approved the promo (photo + text, @all).
CREATE OR REPLACE FUNCTION private.promo_announce(p_post uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pp public.promo_posts; v_room uuid; v_sender uuid; m public.chat_messages%ROWTYPE; v_title text;
BEGIN
  SELECT * INTO pp FROM public.promo_posts WHERE id = p_post FOR UPDATE;
  IF NOT FOUND OR pp.slot <> 'LAUNCH' OR pp.announced_at IS NOT NULL OR pp.announce_text IS NULL THEN RETURN false; END IF;
  SELECT id INTO v_room FROM public.chat_rooms WHERE organization_id = pp.organization_id AND auto_key = 'ALL';
  IF v_room IS NULL THEN RETURN false; END IF;
  v_sender := pp.created_by;
  IF NOT EXISTS (SELECT 1 FROM public.chat_members WHERE room_id = v_room AND user_id = v_sender) THEN RETURN false; END IF;
  INSERT INTO public.chat_messages (room_id, sender_id, body, photo_path, from_management, mentions, mention_all)
  VALUES (v_room, v_sender, pp.announce_text, pp.announce_photo, private.is_management(v_sender), '{}', true)
  RETURNING * INTO m;
  v_title := left(coalesce((SELECT display_name FROM public.app_users WHERE id = v_sender), 'Management') || ' tagged everyone in All staff', 200);
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT pp.organization_id, cm.user_id, 'CHAT_MENTION', v_title, left(pp.announce_text, 1000), '/chat/' || v_room::text, v_sender
  FROM public.chat_members cm WHERE cm.room_id = v_room AND cm.user_id <> v_sender;
  UPDATE public.chat_rooms SET last_message_at = m.created_at WHERE id = v_room;
  UPDATE public.promo_posts SET announced_at = now() WHERE id = pp.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION private.promo_announce(uuid) FROM PUBLIC, anon, authenticated;

-- Mark a post as up on all 4 pages (CSR: posted by hand; META: the app published it). The launch is then announced.
CREATE OR REPLACE FUNCTION public.promo_post_done(p_post uuid, p_via text, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); pp public.promo_posts; v_via text := upper(coalesce(p_via, 'CSR')); v_ann boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_poster(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF v_via NOT IN ('CSR','META') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT * INTO pp FROM public.promo_posts WHERE id = p_post AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF pp.state = 'READY' THEN
    UPDATE public.promo_posts SET state = 'POSTED', via = v_via, posted_by = v_user, posted_at = now(),
      meta_result = CASE WHEN v_via = 'META' THEN p_result ELSE meta_result END WHERE id = pp.id;
    v_ann := private.promo_announce(pp.id);
    -- The rest of management hears it's live.
    IF pp.slot = 'LAUNCH' THEN
      PERFORM private.notify_management(NULL, 'PROMO', 'Promo posted: ' || pp.title,
        'FB post + Story are up on all 4 pages' || CASE WHEN v_ann THEN ', and All staff was told.' ELSE '.' END, '/promos/post');
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'announced', v_ann);
END $$;
REVOKE ALL ON FUNCTION public.promo_post_done(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_post_done(uuid, text, jsonb) TO authenticated;

-- A partial Meta run (some pages failed): keep what went up so a retry posts only the missing pages.
CREATE OR REPLACE FUNCTION public.promo_post_result(p_post uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL OR NOT private.is_poster(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  UPDATE public.promo_posts SET meta_result = p_result WHERE id = p_post AND organization_id = private.current_org_id() AND state = 'READY';
  RETURN jsonb_build_object('ok', FOUND);
END $$;
REVOKE ALL ON FUNCTION public.promo_post_result(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_post_result(uuid, jsonb) TO authenticated;

-- Skip a reminder Story (management).
CREATE OR REPLACE FUNCTION public.promo_post_skip(p_post uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL OR NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  UPDATE public.promo_posts SET state = 'SKIPPED', posted_by = v_user, posted_at = now()
  WHERE id = p_post AND organization_id = private.current_org_id() AND state = 'READY';
  RETURN jsonb_build_object('ok', FOUND);
END $$;
REVOKE ALL ON FUNCTION public.promo_post_skip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promo_post_skip(uuid) TO authenticated;


-- ---------- Bookings: Arriving and Did not arrive (CHRIS Nov 27) ----------
-- Arriving = the client confirmed they're on their way today. Every Arriving client must be closed the same day,
-- within clinic hours (by 7 PM), as Arrived or Did not arrive (NO_SHOW). CSRs get a task to confirm with the branch.
-- Clients who did not arrive go to Sales › Follow-ups like Unresponsive ones.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.bookings'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%UNRESPONSIVE%' LOOP
    EXECUTE format('ALTER TABLE public.bookings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('BOOKED','CONFIRMED','ARRIVING','ARRIVED','DONE','NO_SHOW','UNRESPONSIVE','CANCELLED'));

CREATE OR REPLACE FUNCTION public.set_booking_status(p_id uuid, p_status text, p_new_date date, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.bookings%ROWTYPE; v_user uuid := private.current_user_id(); v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT private.can_see_bookings(b.branch_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p_status = 'RESCHEDULED' THEN
    IF p_new_date IS NULL OR p_new_date < v_today OR p_new_date > v_today + 365 OR p_new_date = b.appointment_date THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE');
    END IF;
    UPDATE public.bookings SET appointment_date = p_new_date, status = 'BOOKED', resched_count = resched_count + 1,
      rescheduled_from = b.appointment_date, status_note = v_note,
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status = 'NOTE' THEN
    UPDATE public.bookings SET status_note = v_note, status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status IN ('ARRIVING','ARRIVED','DONE','NO_SHOW','UNRESPONSIVE') THEN
    UPDATE public.bookings SET status = p_status, status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status IN ('BOOKED','CONFIRMED','CANCELLED') THEN
    IF NOT private.can_book() THEN RETURN private.deny(b.branch_id, 'booking'); END IF;
    UPDATE public.bookings SET status = p_status, status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  PERFORM private.audit(b.branch_id, 'BOOKING_' || p_status, 'booking', p_id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.log_booking_followup(p_booking uuid, p_channel text, p_outcome text, p_new_date date, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  b public.bookings%ROWTYPE; v_user uuid := private.current_user_id(); v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), ''); v_channel text := upper(coalesce(p_channel, ''));
  v_outcome text := upper(coalesce(p_outcome, ''));
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_book() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF v_channel NOT IN ('CALL','FACEBOOK','SMS','OTHER') OR v_outcome NOT IN ('STILL_UNRESPONSIVE','REBOOKED','CANCELLED') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_booking AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF b.status NOT IN ('UNRESPONSIVE','NO_SHOW') THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_UNRESPONSIVE'); END IF;
  IF v_outcome = 'REBOOKED' AND (p_new_date IS NULL OR p_new_date < v_today OR p_new_date > v_today + 365) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE');
  END IF;

  INSERT INTO public.booking_followups (organization_id, booking_id, channel, outcome, old_date, new_date, note, created_by)
  VALUES (b.organization_id, b.id, v_channel, v_outcome, b.appointment_date, CASE WHEN v_outcome = 'REBOOKED' THEN p_new_date END, v_note, v_user);

  IF v_outcome = 'REBOOKED' THEN
    UPDATE public.bookings SET appointment_date = p_new_date, status = 'BOOKED', resched_count = resched_count + 1,
      rescheduled_from = CASE WHEN p_new_date <> b.appointment_date THEN b.appointment_date ELSE rescheduled_from END,
      status_note = coalesce(v_note, 'Rebooked after follow-up'), status_by = v_user, status_at = now(), updated_at = now()
    WHERE id = b.id;
  ELSIF v_outcome = 'CANCELLED' THEN
    UPDATE public.bookings SET status = 'CANCELLED', status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = b.id;
  ELSE
    UPDATE public.bookings SET updated_at = now() WHERE id = b.id; -- still unresponsive: wakes the live board
  END IF;
  PERFORM private.audit(b.branch_id, 'BOOKING_FOLLOWUP_' || v_outcome, 'booking', b.id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------- Bookings → Service log (CHRIS Nov 27) ----------
-- An Arriving or Arrived client's name opens the Service log with them filled in, and the entry is linked to the booking,
-- so the same visit isn't recorded twice. waiver_name: the name on the waiver when it differs from the Facebook name
-- the client booked with; it then takes priority on every record (the booked Facebook name is kept).
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS waiver_name text CHECK (waiver_name IS NULL OR length(btrim(waiver_name)) BETWEEN 2 AND 120);
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.bookings(id);
CREATE INDEX IF NOT EXISTS service_logs_booking ON public.service_logs (booking_id) WHERE booking_id IS NOT NULL;

-- Approved entries are locked; the booking link and waiver name may still be set on them (nothing else).
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
  -- update-0091: linking an entry to its booking may change only the booking link and the client name (waiver name).
  IF current_setting('hermosa.booking_link', true) = 'on'
     AND (to_jsonb(NEW) - 'booking_id' - 'client_name') = (to_jsonb(OLD) - 'booking_id' - 'client_name') THEN RETURN NEW; END IF;
  -- update-0085: marking a Hiko balance paid after a DP may change only the DP flag, the effective rate and the price note.
  IF current_setting('hermosa.after_dp', true) = 'on'
     AND (to_jsonb(NEW) - 'after_dp' - 'rate_bp' - 'price_note') = (to_jsonb(OLD) - 'after_dp' - 'rate_bp' - 'price_note') THEN RETURN NEW; END IF;
  -- update-0079: re-numbering may change the entry number only.
  IF current_setting('hermosa.log_renumber', true) = 'on'
     AND (to_jsonb(NEW) - 'log_no') = (to_jsonb(OLD) - 'log_no') THEN RETURN NEW; END IF;
  -- update-0073: change_service_date may move the date only.
  IF current_setting('hermosa.log_redate', true) = 'on'
     AND (to_jsonb(NEW) - 'service_date') = (to_jsonb(OLD) - 'service_date') THEN RETURN NEW; END IF;
  IF current_setting('hermosa.photo_sharing', true) = 'on'
     AND (to_jsonb(NEW) - 'share_ok' - 'photos_due' - 'photo_folder') = (to_jsonb(OLD) - 'share_ok' - 'photos_due' - 'photo_folder') THEN RETURN NEW; END IF;
  IF OLD.state <> 'PENDING' THEN RAISE EXCEPTION 'SERVICE_LOG_ALREADY_DECIDED'; END IF;
  IF (NEW.branch_id, NEW.service_date, NEW.service_id, NEW.amount_paid_cents, NEW.commission_type, NEW.performer_id,
      NEW.assistant_id, NEW.rate_bp, NEW.lead_share_bp, NEW.created_by, NEW.receipt_no)
     IS DISTINCT FROM (OLD.branch_id, OLD.service_date, OLD.service_id, OLD.amount_paid_cents, OLD.commission_type,
      OLD.performer_id, OLD.assistant_id, OLD.rate_bp, OLD.lead_share_bp, OLD.created_by, OLD.receipt_no)
     OR (NEW.visit_kind IS DISTINCT FROM OLD.visit_kind AND OLD.visit_kind <> 'PAID') THEN
    RAISE EXCEPTION 'SERVICE_LOG_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

-- Set or clear (same as the Facebook name) the waiver name. Whoever can mark the booking.
CREATE OR REPLACE FUNCTION public.set_booking_waiver(p_id uuid, p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.bookings%ROWTYPE; v_user uuid := private.current_user_id(); v_name text := nullif(btrim(coalesce(p_name, '')), '');
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT private.can_see_bookings(b.branch_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF v_name IS NOT NULL AND length(v_name) NOT BETWEEN 2 AND 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'CLIENT_NAME_REQUIRED'); END IF;
  IF v_name IS NOT NULL AND lower(v_name) = lower(btrim(b.client_name)) THEN v_name := NULL; END IF;
  UPDATE public.bookings SET waiver_name = v_name, updated_at = now() WHERE id = b.id;
  -- Entries already linked to this booking follow the waiver name.
  PERFORM set_config('hermosa.booking_link', 'on', true);
  UPDATE public.service_logs SET client_name = coalesce(v_name, b.client_name) WHERE booking_id = b.id;
  PERFORM set_config('hermosa.booking_link', '', true);
  PERFORM private.audit(b.branch_id, 'BOOKING_WAIVER_NAME', 'booking', b.id::text, jsonb_build_object('waiver_name', b.waiver_name), jsonb_build_object('waiver_name', v_name));
  RETURN jsonb_build_object('ok', true, 'name', coalesce(v_name, b.client_name));
END $$;
REVOKE ALL ON FUNCTION public.set_booking_waiver(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_waiver(uuid, text) TO authenticated;

-- Link a Service log entry just saved to the booking it came from; the booking becomes Done.
CREATE OR REPLACE FUNCTION public.link_booking_log(p_booking uuid, p_log uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.bookings%ROWTYPE; l record; v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_booking AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT private.can_see_bookings(b.branch_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  SELECT id, branch_id, created_by, booking_id, client_name INTO l FROM public.service_logs WHERE id = p_log AND organization_id = b.organization_id;
  IF NOT FOUND OR l.branch_id <> b.branch_id OR (l.created_by <> v_user AND NOT private.is_management(v_user)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  PERFORM set_config('hermosa.booking_link', 'on', true);
  UPDATE public.service_logs SET booking_id = b.id, client_name = coalesce(b.waiver_name, l.client_name) WHERE id = l.id;
  PERFORM set_config('hermosa.booking_link', '', true);
  IF b.status IN ('BOOKED','CONFIRMED','ARRIVING','ARRIVED') THEN
    UPDATE public.bookings SET status = 'DONE', status_by = v_user, status_at = now(), updated_at = now() WHERE id = b.id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.link_booking_log(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_booking_log(uuid, uuid) TO authenticated;

-- ---------- Service log: "Service has before and after photo?" (CHRIS Nov 27) ----------
-- Ticked by default. Unticked, the entry needs no before and after photos (the signed waiver is still needed), and the
-- entry remembers it (before_after = false) so nobody chases photos that were never taken.
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS before_after boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.log_client_visit(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_note text, p_kind text, p_confirm boolean,
  p_client text, p_price_note text, p_folder uuid, p_photos jsonb, p_share boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text := upper(coalesce(p_kind, 'PAID')); v_client text := nullif(btrim(coalesce(p_client, '')), '');
  v_pnote text := nullif(left(btrim(coalesce(p_price_note, '')), 300), ''); v_price bigint; v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_prefix text; ph jsonb; r jsonb; v_id uuid; v_pos integer := 0; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
  n_w integer; n_b integer; n_a integer; v_found boolean; v_mgmt boolean := private.is_management(private.current_user_id());
  v_due boolean := false; v_svc text; v_code text; e record;
  v_ba boolean := coalesce(current_setting('hermosa.no_ba', true), '') <> '1';
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN RETURN private.deny(p_branch, 'service_log'); END IF;
  IF NOT public.can_log_services_now() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_TIMED_IN'); END IF;
  IF v_client IS NULL OR length(v_client) < 2 OR length(v_client) > 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'CLIENT_NAME_REQUIRED'); END IF;
  SELECT price_cents INTO v_price FROM public.services WHERE id = p_service AND organization_id = private.current_org_id();
  IF v_kind = 'PAID' AND v_price IS NOT NULL AND v_price > 0 AND p_amount_cents IS DISTINCT FROM v_price AND coalesce(length(v_pnote), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PRICE_NOTE_REQUIRED');
  END IF;
  -- Photos: in this branch's folder for this visit, at most 20, a kind each, and (where Storage is installed) already uploaded.
  IF jsonb_typeof(v_photos) <> 'array' OR jsonb_array_length(v_photos) > 20 OR p_folder IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  v_prefix := p_branch::text || '/' || p_folder::text || '/';
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    IF coalesce(ph ->> 'kind', '') NOT IN ('WAIVER','BEFORE','AFTER')
       OR coalesce(ph ->> 'path', '') !~ ('^' || v_prefix || '[a-z]+-[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$')
       OR (ph ->> 'thumb' IS NOT NULL AND (ph ->> 'thumb') !~ ('^' || v_prefix || 'thumb-[0-9a-f-]{36}\.jpg$')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF v_storage THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''client-photos'' AND o.name = $1)' INTO v_found USING ph ->> 'path';
      IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_NOT_UPLOADED'); END IF;
    END IF;
  END LOOP;
  SELECT count(*) FILTER (WHERE x ->> 'kind' = 'WAIVER'), count(*) FILTER (WHERE x ->> 'kind' = 'BEFORE'), count(*) FILTER (WHERE x ->> 'kind' = 'AFTER')
  INTO n_w, n_b, n_a FROM jsonb_array_elements(v_photos) x;
  -- update-0060 (CHRIS Nov 26): owners and the GM need no photos at all: their entries are never "photos missing".
  -- update-0091 (CHRIS Nov 27): a service with no before and after photo (unticked) needs only the waiver.
  v_due := NOT v_mgmt AND v_kind IN ('PAID','BACKJOB') AND (n_w < 2 OR (v_ba AND (n_b < 1 OR n_a < 1)));
  IF v_due AND NOT v_mgmt THEN
    IF n_w < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'WAIVER_PHOTOS_REQUIRED'); END IF;
    IF v_ba AND (n_b < 1 OR n_a < 1) THEN RETURN jsonb_build_object('ok', false, 'error', 'BEFORE_AFTER_REQUIRED'); END IF;
  END IF;

  r := public.log_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, NULL, p_note, v_kind, p_confirm);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = v_client, list_price_cents = v_price, price_note = v_pnote,
    share_ok = coalesce(p_share, false), photo_folder = p_folder, photos_due = v_due, before_after = v_ba WHERE id = v_id;
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
    VALUES (private.current_org_id(), v_id, p_branch, ph ->> 'kind', ph ->> 'path', ph ->> 'thumb', v_pos, private.current_user_id());
    v_pos := v_pos + 1;
  END LOOP;
  IF v_due THEN PERFORM private.notify_photos_due(v_id); END IF;
  -- update-0060: an entry added by owners or the GM is approved right away (no second sign-off).
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = private.current_user_id(), decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r || jsonb_build_object('photos_due', v_due);
END $$;

-- The Service log's call (session number, and now the before/after tick). Replaces the update-0064 version.
DROP FUNCTION IF EXISTS public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean, integer);
CREATE OR REPLACE FUNCTION public.log_client_visit(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_note text, p_kind text, p_confirm boolean,
  p_client text, p_price_note text, p_folder uuid, p_photos jsonb, p_share boolean, p_session integer, p_before_after boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb;
BEGIN
  IF p_session IS NULL OR p_session < 1 OR p_session > 15 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  PERFORM set_config('hermosa.session_no', p_session::text, true);
  PERFORM set_config('hermosa.no_ba', CASE WHEN p_before_after IS FALSE THEN '1' ELSE '' END, true);
  r := public.log_client_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, p_note, p_kind, p_confirm,
                               p_client, p_price_note, p_folder, p_photos, p_share);
  PERFORM set_config('hermosa.session_no', '', true);
  PERFORM set_config('hermosa.no_ba', '', true);
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean, integer, boolean) TO authenticated;

SELECT 'update-0091 is installed' AS result;
