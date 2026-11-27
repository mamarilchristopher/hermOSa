-- Hermosa OS update-0100: Business › Expenses (CHRIS Nov 28). Safe to run again.
-- SQL Editor: https://supabase.com/dashboard/project/bnopatuopnenbdhrecdt/sql/new
-- "Expenses ... for all management members to see and manage. Salaries, benefits, utilities, rent ... ad spend should
--  automatically be reported by windsor" + "not table but feature with UI. actionable dashboard".
--   1. expense_categories: the list management picks from (and adds to). Monthly bills (rent, electricity, ...) feed
--      the "Due this month" cards; an optional monthly budget per category.
--   2. expenses: one row per bill or purchase, per branch or company-wide (branch empty), with up to 5 receipt photos
--      in a private folder. Corrections keep who and when; removing needs a reason and keeps the row (voided).
--   3. expense_auto(month): what the app fills by itself: salaries and commissions from FINAL payroll cutoffs (by each
--      person's home branch) and Meta ad spend from the Windsor feed (by the Facebook page, before VAT; the page adds
--      12% and marks it *), or the monthly ad spend table for months the feed doesn't cover.
-- Who: owners and the GM see and manage everything; Finance can see and add; Auditors can see.
-- CHECK FIRST (changes nothing):
-- select case when to_regclass('public.expenses') is not null then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

CREATE OR REPLACE FUNCTION private.can_see_expenses() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_management(private.current_user_id()) OR private.has_role(ARRAY['FINANCE','AUDITOR'], NULL)
$$;
REVOKE ALL ON FUNCTION private.can_see_expenses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_see_expenses() TO authenticated;
CREATE OR REPLACE FUNCTION private.can_manage_expenses() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_management(private.current_user_id()) OR private.has_role(ARRAY['FINANCE'], NULL)
$$;
REVOKE ALL ON FUNCTION private.can_manage_expenses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_manage_expenses() TO authenticated;

-- 1. Categories. kind: MONTHLY = a bill expected every month; ONE_OFF = purchases; AUTO = filled by the app.
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  grp text NOT NULL DEFAULT 'BUSINESS' CHECK (grp IN ('AUTO','FIXED','PEOPLE','CLINIC','BUSINESS')),
  kind text NOT NULL DEFAULT 'ONE_OFF' CHECK (kind IN ('MONTHLY','ONE_OFF','AUTO')),
  auto_source text CHECK (auto_source IN ('PAYROLL','META_ADS')),
  budget_cents bigint CHECK (budget_cents IS NULL OR budget_cents BETWEEN 0 AND 100000000000),
  sort integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  CHECK ((kind = 'AUTO') = (auto_source IS NOT NULL))
);

-- 2. Expenses. branch_id NULL = company-wide (shared costs).
CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid REFERENCES public.branches(id),
  category_id uuid NOT NULL REFERENCES public.expense_categories(id),
  spent_on date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000000),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 120),
  payee text CHECK (payee IS NULL OR length(payee) <= 80),
  paid_via text CHECK (paid_via IS NULL OR paid_via IN ('CASH','BANK','GCASH','CARD','OTHER')),
  receipt_paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(receipt_paths) <= 5),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.app_users(id),
  updated_at timestamptz,
  voided_by uuid REFERENCES public.app_users(id),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 200)
);
CREATE INDEX IF NOT EXISTS expenses_month ON public.expenses (organization_id, spent_on);

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_categories_read ON public.expense_categories;
CREATE POLICY expense_categories_read ON public.expense_categories FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_see_expenses());
DROP POLICY IF EXISTS expenses_read ON public.expenses;
CREATE POLICY expenses_read ON public.expenses FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_see_expenses());
REVOKE INSERT, UPDATE, DELETE ON public.expense_categories, public.expenses FROM anon, authenticated;
GRANT SELECT ON public.expense_categories, public.expenses TO authenticated;

-- Starting categories (CHRIS can rename, hide or add more in the app). Adds only missing names; safe to run again.
CREATE OR REPLACE FUNCTION private.seed_expense_categories() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $seed$
INSERT INTO public.expense_categories (organization_id, name, grp, kind, auto_source, sort)
SELECT o.id, c.name, c.grp, c.kind, c.src, c.sort
FROM public.organizations o CROSS JOIN (VALUES
  ('Salaries & commissions', 'AUTO', 'AUTO', 'PAYROLL', 1),
  ('Meta ad spend', 'AUTO', 'AUTO', 'META_ADS', 2),
  ('Rent', 'FIXED', 'MONTHLY', NULL, 10),
  ('Electricity', 'FIXED', 'MONTHLY', NULL, 11),
  ('Water', 'FIXED', 'MONTHLY', NULL, 12),
  ('Internet & phone', 'FIXED', 'MONTHLY', NULL, 13),
  ('Association dues / CUSA', 'FIXED', 'MONTHLY', NULL, 14),
  ('Software & subscriptions', 'FIXED', 'MONTHLY', NULL, 15),
  ('Government shares (employer)', 'PEOPLE', 'MONTHLY', NULL, 20),
  ('HMO & insurance', 'PEOPLE', 'MONTHLY', NULL, 21),
  ('Staff meals & pantry', 'PEOPLE', 'ONE_OFF', NULL, 22),
  ('Uniforms', 'PEOPLE', 'ONE_OFF', NULL, 23),
  ('Training', 'PEOPLE', 'ONE_OFF', NULL, 24),
  ('Medical supplies & threads', 'CLINIC', 'ONE_OFF', NULL, 30),
  ('Injectables & products', 'CLINIC', 'ONE_OFF', NULL, 31),
  ('Doctor fees', 'CLINIC', 'ONE_OFF', NULL, 32),
  ('Equipment repairs', 'CLINIC', 'ONE_OFF', NULL, 33),
  ('Equipment purchase', 'CLINIC', 'ONE_OFF', NULL, 34),
  ('Laundry & linens', 'CLINIC', 'ONE_OFF', NULL, 35),
  ('Medical waste disposal', 'CLINIC', 'MONTHLY', NULL, 36),
  ('Cleaning', 'CLINIC', 'ONE_OFF', NULL, 37),
  ('Other marketing', 'BUSINESS', 'ONE_OFF', NULL, 40),
  ('Permits & licenses', 'BUSINESS', 'ONE_OFF', NULL, 41),
  ('Taxes', 'BUSINESS', 'ONE_OFF', NULL, 42),
  ('Accountant & legal', 'BUSINESS', 'ONE_OFF', NULL, 43),
  ('Bank, card & GCash fees', 'BUSINESS', 'ONE_OFF', NULL, 44),
  ('Transport & delivery', 'BUSINESS', 'ONE_OFF', NULL, 45),
  ('Repairs & maintenance', 'BUSINESS', 'ONE_OFF', NULL, 46),
  ('Security', 'BUSINESS', 'MONTHLY', NULL, 47),
  ('Pest control', 'BUSINESS', 'MONTHLY', NULL, 48),
  ('Miscellaneous / petty cash', 'BUSINESS', 'ONE_OFF', NULL, 49)
) AS c(name, grp, kind, src, sort)
ON CONFLICT (organization_id, name) DO NOTHING;
$seed$;
REVOKE ALL ON FUNCTION private.seed_expense_categories() FROM PUBLIC, anon, authenticated;
SELECT private.seed_expense_categories();

-- Add or correct an expense. p: {id?, branch_id?, category_id, spent_on, amount_cents, description, payee?, paid_via?, receipts?: [path]}
CREATE OR REPLACE FUNCTION public.save_expense(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; old public.expenses%ROWTYPE;
  v_branch uuid; v_cat public.expense_categories%ROWTYPE; v_date date; v_amt bigint; v_desc text; v_paths text[];
  v_path text; v_found boolean; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_manage_expenses() THEN RETURN private.deny(NULL, 'expense'); END IF;
  BEGIN
    v_id := nullif(p ->> 'id', '')::uuid;
    v_branch := nullif(p ->> 'branch_id', '')::uuid;
    v_date := (p ->> 'spent_on')::date;
    v_amt := (p ->> 'amount_cents')::bigint;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END;
  v_desc := btrim(coalesce(p ->> 'description', ''));
  SELECT * INTO v_cat FROM public.expense_categories WHERE id = nullif(p ->> 'category_id', '')::uuid AND organization_id = v_org;
  IF NOT FOUND OR v_cat.kind = 'AUTO' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_CATEGORY'); END IF;
  IF v_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches WHERE id = v_branch AND organization_id = v_org) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF v_date IS NULL OR v_date > (now() AT TIME ZONE 'Asia/Manila')::date + 31 OR v_date < date '2020-01-01' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_DATE');
  END IF;
  IF v_amt IS NULL OR v_amt < 1 OR v_amt > 100000000000 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_AMOUNT'); END IF;
  IF length(v_desc) < 2 OR length(v_desc) > 120 OR length(coalesce(p ->> 'payee', '')) > 80 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF p ->> 'paid_via' IS NOT NULL AND p ->> 'paid_via' NOT IN ('CASH','BANK','GCASH','CARD','OTHER') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT coalesce(array_agg(x), '{}') INTO v_paths FROM jsonb_array_elements_text(coalesce(p -> 'receipts', '[]'::jsonb)) x;
  IF cardinality(v_paths) > 5 THEN RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY'); END IF;
  IF v_id IS NOT NULL THEN
    SELECT * INTO old FROM public.expenses WHERE id = v_id AND organization_id = v_org AND voided_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  END IF;
  FOREACH v_path IN ARRAY v_paths LOOP
    IF v_path !~ ('^' || v_org::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif|pdf)$') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF v_storage AND NOT (v_id IS NOT NULL AND v_path = ANY (old.receipt_paths)) THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''expense-receipts'' AND o.name = $1)' INTO v_found USING v_path;
      IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_NOT_UPLOADED'); END IF;
    END IF;
  END LOOP;
  IF v_id IS NULL THEN
    INSERT INTO public.expenses (organization_id, branch_id, category_id, spent_on, amount_cents, description, payee, paid_via, receipt_paths, created_by)
    VALUES (v_org, v_branch, v_cat.id, v_date, v_amt, v_desc, nullif(btrim(coalesce(p ->> 'payee', '')), ''), p ->> 'paid_via', v_paths, v_user)
    RETURNING id INTO v_id;
    PERFORM private.audit(v_branch, 'EXPENSE_ADDED', 'expense', v_id::text, NULL, jsonb_build_object('amount_cents', v_amt, 'category', v_cat.name, 'date', v_date));
  ELSE
    UPDATE public.expenses SET branch_id = v_branch, category_id = v_cat.id, spent_on = v_date, amount_cents = v_amt, description = v_desc,
      payee = nullif(btrim(coalesce(p ->> 'payee', '')), ''), paid_via = p ->> 'paid_via', receipt_paths = v_paths,
      updated_by = v_user, updated_at = now()
    WHERE id = v_id;
    PERFORM private.audit(v_branch, 'EXPENSE_CHANGED', 'expense', v_id::text,
      jsonb_build_object('amount_cents', old.amount_cents, 'date', old.spent_on, 'branch', old.branch_id, 'category', old.category_id, 'description', old.description),
      jsonb_build_object('amount_cents', v_amt, 'date', v_date, 'branch', v_branch, 'category', v_cat.id, 'description', v_desc));
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.save_expense(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_expense(jsonb) TO authenticated;

-- Remove an expense entered by mistake (kept, marked removed, with the reason). Owners and the GM, or whoever added it.
CREATE OR REPLACE FUNCTION public.void_expense(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); e public.expenses%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO e FROM public.expenses WHERE id = p_id AND organization_id = private.current_org_id() AND voided_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user) OR (e.created_by = v_user AND private.can_manage_expenses())) THEN RETURN private.deny(e.branch_id, 'expense'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(p_reason) > 200 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.expenses SET voided_by = v_user, voided_at = now(), void_reason = btrim(p_reason) WHERE id = p_id;
  PERFORM private.audit(e.branch_id, 'EXPENSE_REMOVED', 'expense', p_id::text, jsonb_build_object('amount_cents', e.amount_cents, 'date', e.spent_on), jsonb_build_object('reason', btrim(p_reason)));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.void_expense(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_expense(uuid, text) TO authenticated;

-- Add or change a category (owners and the GM). p: {id?, name, grp, kind (MONTHLY|ONE_OFF), budget_cents?, active?}
CREATE OR REPLACE FUNCTION public.save_expense_category(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; c public.expense_categories%ROWTYPE;
  v_name text := btrim(coalesce(p ->> 'name', '')); v_budget bigint;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN private.deny(NULL, 'expense_category'); END IF;
  BEGIN
    v_id := nullif(p ->> 'id', '')::uuid;
    v_budget := nullif(p ->> 'budget_cents', '')::bigint;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END;
  IF v_budget IS NOT NULL AND (v_budget < 0 OR v_budget > 100000000000) THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_AMOUNT'); END IF;
  IF v_id IS NULL THEN
    IF length(v_name) < 2 OR length(v_name) > 60 OR coalesce(p ->> 'grp', 'BUSINESS') NOT IN ('FIXED','PEOPLE','CLINIC','BUSINESS')
       OR coalesce(p ->> 'kind', 'ONE_OFF') NOT IN ('MONTHLY','ONE_OFF') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF EXISTS (SELECT 1 FROM public.expense_categories WHERE organization_id = v_org AND lower(name) = lower(v_name)) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE');
    END IF;
    INSERT INTO public.expense_categories (organization_id, name, grp, kind, budget_cents, sort)
    VALUES (v_org, v_name, coalesce(p ->> 'grp', 'BUSINESS'), coalesce(p ->> 'kind', 'ONE_OFF'), v_budget,
            (SELECT coalesce(max(sort), 0) + 1 FROM public.expense_categories WHERE organization_id = v_org))
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO c FROM public.expense_categories WHERE id = v_id AND organization_id = v_org;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
    IF v_name <> '' AND (length(v_name) > 60 OR length(v_name) < 2) THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
    IF v_name <> '' AND lower(v_name) <> lower(c.name) AND EXISTS (SELECT 1 FROM public.expense_categories WHERE organization_id = v_org AND lower(name) = lower(v_name)) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE');
    END IF;
    UPDATE public.expense_categories SET
      name = CASE WHEN v_name <> '' THEN v_name ELSE name END,
      kind = CASE WHEN c.kind <> 'AUTO' AND p ->> 'kind' IN ('MONTHLY','ONE_OFF') THEN p ->> 'kind' ELSE kind END,
      grp = CASE WHEN c.kind <> 'AUTO' AND p ->> 'grp' IN ('FIXED','PEOPLE','CLINIC','BUSINESS') THEN p ->> 'grp' ELSE grp END,
      budget_cents = CASE WHEN p ? 'budget_cents' THEN v_budget ELSE budget_cents END,
      active = CASE WHEN p ? 'active' THEN coalesce((p ->> 'active')::boolean, active) ELSE active END
    WHERE id = v_id;
  END IF;
  PERFORM private.audit(NULL, 'EXPENSE_CATEGORY_SAVED', 'expense_category', v_id::text, NULL, p);
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.save_expense_category(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_expense_category(jsonb) TO authenticated;

-- 3. What the app fills by itself for a month (and the month before, for the ▲▼ comparison).
--   payroll: [{run, start, end, branch_id, gross_cents, people}] from FINAL cutoffs ending in the month, by home branch.
--   ads: [{d, branch, cents}] Meta spend BEFORE VAT per day and branch (by Facebook page), newest copy of each ad-day;
--        months the Windsor feed doesn't cover come from ad_spend_monthly as one row dated the 1st (monthly = true).
CREATE OR REPLACE FUNCTION public.expense_auto(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_pay jsonb; v_ads jsonb := '[]'::jsonb; v_last date; v_loaded timestamptz; v_monthly jsonb;
  v_pages jsonb := '{"103117851723422":"QC_MAIN","101404945363588":"FAIRVIEW","112393681804031":"STA_MARIA","257589974108824":"MARIKINA"}';
BEGIN
  IF NOT private.can_see_expenses() THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('run', x.run_id, 'start', x.period_start, 'end', x.period_end, 'branch_id', x.branch_id,
           'gross_cents', x.gross, 'people', x.people) ORDER BY x.period_start, x.branch_id), '[]'::jsonb) INTO v_pay
  FROM (SELECT r.id AS run_id, r.period_start, r.period_end, e.branch_id, sum(s.gross_cents) AS gross, count(*) AS people
        FROM public.payroll_runs r JOIN public.payslips s ON s.run_id = r.id JOIN public.employees e ON e.id = s.employee_id
        WHERE r.organization_id = v_org AND r.state = 'FINAL' AND r.period_end BETWEEN p_from AND p_to
        GROUP BY r.id, r.period_start, r.period_end, e.branch_id) x;
  IF to_regclass('ads_feed.meta_ads_daily') IS NOT NULL THEN
    EXECUTE $q$
      WITH latest AS (
        SELECT DISTINCT ON (d.date, d.ad_id) d.date, d.actor_id, d.spend
        FROM ads_feed.meta_ads_daily d
        WHERE d.date BETWEEN $1 AND $2 AND d.ad_id IS NOT NULL AND $3 ? d.actor_id
        ORDER BY d.date, d.ad_id, d._loaded_at DESC)
      SELECT coalesce(jsonb_agg(jsonb_build_object('d', t.date, 'branch', t.code, 'cents', t.cents) ORDER BY t.date, t.code), '[]'::jsonb), max(t.date)
      FROM (SELECT l.date, $3 ->> l.actor_id AS code, round(sum(coalesce(l.spend, 0)) * 100)::bigint AS cents FROM latest l GROUP BY l.date, $3 ->> l.actor_id) t
    $q$ INTO v_ads, v_last USING p_from, p_to, v_pages;
    EXECUTE 'SELECT max(_loaded_at) FROM ads_feed.meta_ads_daily' INTO v_loaded;
  END IF;
  -- Months with no feed rows at all: the monthly table (owners/GM keep it on the Ads page).
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', m.month, 'branch', b.code, 'cents', m.cents, 'monthly', true, 'through', m.through) ORDER BY m.month, b.code), '[]'::jsonb)
    INTO v_monthly
  FROM (SELECT a.month, a.branch_id, sum(a.spend_cents) AS cents, max(a.through) AS through FROM public.ad_spend_monthly a
        WHERE a.organization_id = v_org AND a.month BETWEEN date_trunc('month', p_from)::date AND p_to GROUP BY a.month, a.branch_id) m
  JOIN public.branches b ON b.id = m.branch_id
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_ads, '[]'::jsonb)) z WHERE date_trunc('month', (z ->> 'd')::date) = m.month);
  RETURN jsonb_build_object('ok', true, 'payroll', v_pay, 'ads', coalesce(v_ads, '[]'::jsonb) || v_monthly, 'ads_last_date', v_last, 'ads_loaded_at', v_loaded);
END $$;
REVOKE ALL ON FUNCTION public.expense_auto(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_auto(date, date) TO authenticated;

-- Receipts: private folder "expense-receipts", <organization>/<random id>.<ext>, photos or PDFs up to 15 MB.
CREATE OR REPLACE FUNCTION private.can_open_expense_receipt(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.can_see_expenses() AND split_part(p_name, '/', 1) = private.current_org_id()::text
$$;
REVOKE ALL ON FUNCTION private.can_open_expense_receipt(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_open_expense_receipt(text) TO authenticated;
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('expense-receipts', 'expense-receipts', false, 15728640, ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS expense_receipts_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY expense_receipts_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'expense-receipts' AND split_part(name, '/', 1) = private.current_org_id()::text AND private.can_manage_expenses())$p$;
    EXECUTE 'DROP POLICY IF EXISTS expense_receipts_read ON storage.objects';
    EXECUTE $p$CREATE POLICY expense_receipts_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'expense-receipts' AND private.can_open_expense_receipt(name))$p$;
    EXECUTE 'DROP POLICY IF EXISTS expense_receipts_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY expense_receipts_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'expense-receipts' AND owner_id = auth.uid()::text
             AND NOT EXISTS (SELECT 1 FROM public.expenses e WHERE name = ANY (e.receipt_paths)))$p$;
  END IF;
END $$;
