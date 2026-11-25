-- update-0053: client photos in the service log (CHRIS, Nov 26, 2026).
--   * Every service logged now has the client's name. The list price fills in; a different price (discount) needs a note,
--     and a discounted price earns 5% of what was paid instead of the set commission.
--   * Paid visits and backjobs need photos: the waiver (2 pages) and at least one before and one after photo.
--     Originals are kept at full quality in a private folder ("client-photos"); a small preview is saved next to each.
--   * "Client allowed sharing of photos" files the before/after photos in the Social media tab too.
--   * Client archive: owners and the GM see every branch; branch staff see their branch. Social media: owners, the GM,
--     marketing and CSRs (before/after photos only, never waivers).

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS client_name text CHECK (client_name IS NULL OR length(btrim(client_name)) BETWEEN 2 AND 120);
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS list_price_cents bigint;
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS price_note text CHECK (price_note IS NULL OR length(price_note) <= 300);
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS share_ok boolean NOT NULL DEFAULT false;
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS photo_folder uuid;

CREATE TABLE IF NOT EXISTS public.service_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_log_id uuid NOT NULL REFERENCES public.service_logs(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  kind text NOT NULL CHECK (kind IN ('WAIVER','BEFORE','AFTER')),
  path text NOT NULL UNIQUE,
  thumb_path text UNIQUE,
  position integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_photos_log ON public.service_photos (service_log_id);
ALTER TABLE public.service_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_photos FROM PUBLIC, anon, authenticated;

-- Who sees a branch's client archive (waivers and before/after): owners, the GM, and that branch's staff.
CREATE OR REPLACE FUNCTION private.can_see_archive(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER','MANAGER','CLINICIAN','CASHIER'], p_branch)
$$;
-- Who sees the Social media tab (shared before/after photos only): owners, the GM, marketing and CSRs.
CREATE OR REPLACE FUNCTION private.can_see_social() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER','MARKETING','CSR'], NULL) OR private.is_gm()
$$;
REVOKE ALL ON FUNCTION private.can_see_archive(uuid), private.can_see_social() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_see_archive(uuid), private.can_see_social() TO authenticated;

-- May the signed-in person open this file? (used by the private folder's read rule)
CREATE OR REPLACE FUNCTION private.can_open_client_photo(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.service_photos p JOIN public.service_logs l ON l.id = p.service_log_id
                 WHERE (p.path = p_name OR p.thumb_path = p_name) AND p.organization_id = private.current_org_id()
                   AND (private.can_see_archive(p.branch_id) OR (private.can_see_social() AND l.share_ok AND p.kind <> 'WAIVER')))
$$;
REVOKE ALL ON FUNCTION private.can_open_client_photo(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_open_client_photo(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.log_service(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_receipt text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_type text; v_lead uuid; v_assist uuid;
  v_rate integer := 500; v_share integer := 6000;
  v_total bigint; v_lead_cents bigint; v_id uuid;
  lead_ok boolean; assist_ok boolean; v_fixed bigint; v_price bigint;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN
    RETURN private.deny(p_branch, 'service_log');
  END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents < 0 OR p_amount_cents > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  SELECT commission_cents, price_cents INTO v_fixed, v_price FROM public.services WHERE id = p_service AND organization_id = v_org AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;
  -- update-0053: a discounted price (less than the list price) earns 5% of what was actually paid, not the set commission.
  IF v_fixed IS NOT NULL AND v_price IS NOT NULL AND p_amount_cents > 0 AND p_amount_cents < v_price THEN v_fixed := NULL; END IF;
  -- update-0042: a service with a set commission pays that amount (split 60/40 for lead/assist) on any paid visit;
  -- otherwise 5% of the amount paid. The stored rate is the effective one, for the record.
  IF v_fixed IS NOT NULL AND coalesce(p_amount_cents, 0) > 0 THEN
    v_rate := least(10000, ((v_fixed * 10000 + p_amount_cents / 2) / p_amount_cents)::integer);
  END IF;
  v_type := upper(coalesce(p_type, 'LEAD'));
  IF v_type = 'ASSIST' THEN v_type := 'LEAD'; v_lead := p_partner; v_assist := p_employee;
  ELSIF v_type = 'LEAD' THEN v_lead := p_employee; v_assist := p_partner;
  ELSIF v_type IN ('SOLO','NONCOMMI') THEN v_lead := p_employee; v_assist := NULL;
  ELSE RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF v_lead IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'EMPLOYEE_REQUIRED'); END IF;
  IF v_type = 'LEAD' AND v_assist IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'ASSISTANT_REQUIRED'); END IF;
  IF v_assist = v_lead THEN RETURN jsonb_build_object('ok', false, 'error', 'SAME_PERSON'); END IF;
  SELECT commission_eligible INTO lead_ok FROM public.employees WHERE id = v_lead AND organization_id = v_org AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  IF v_assist IS NOT NULL THEN
    SELECT commission_eligible INTO assist_ok FROM public.employees WHERE id = v_assist AND organization_id = v_org AND active;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  END IF;

  INSERT INTO public.service_logs (organization_id, branch_id, service_date, service_id, amount_paid_cents, commission_type,
    performer_id, assistant_id, rate_bp, lead_share_bp, receipt_no, note, created_by)
  VALUES (v_org, p_branch, p_date, p_service, p_amount_cents, v_type, v_lead, v_assist,
    CASE WHEN v_type = 'NONCOMMI' THEN 0 ELSE v_rate END, v_share,
    nullif(btrim(coalesce(p_receipt, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), v_user)
  RETURNING id INTO v_id;

  -- Commission in centavos, rounded half up; the lead's share is rounded and the assistant gets the rest.
  -- update-0048: a follow-up dose already paid for (price 0 with a set commission) still pays its set commission.
  v_total := CASE WHEN v_fixed IS NOT NULL AND (p_amount_cents > 0 OR coalesce(v_price, 0) = 0) THEN v_fixed ELSE (p_amount_cents * v_rate + 5000) / 10000 END;
  IF v_type = 'SOLO' AND lead_ok THEN
    INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (v_id, v_lead, 'SOLO', v_total);
  ELSIF v_type = 'LEAD' THEN
    v_lead_cents := (v_total * v_share + 5000) / 10000;
    IF lead_ok THEN
      INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (v_id, v_lead, 'LEAD', v_lead_cents);
    END IF;
    IF assist_ok THEN
      INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (v_id, v_assist, 'ASSIST', v_total - v_lead_cents);
    END IF;
  END IF;

  PERFORM private.audit(p_branch, 'SERVICE_LOGGED', 'service_log', v_id::text, NULL,
    jsonb_build_object('date', p_date, 'type', v_type, 'amount_paid_cents', p_amount_cents));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'state', 'PENDING');
END $$;
REVOKE ALL ON FUNCTION public.log_service(uuid, date, uuid, bigint, text, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_service(uuid, date, uuid, bigint, text, uuid, uuid, text, text) TO authenticated;

-- Log a client's visit with their name and photos. Photos are uploaded first to client-photos/<branch>/<folder>/.
-- p_photos: [{"kind": "WAIVER"|"BEFORE"|"AFTER", "path": "...", "thumb": "..."}]
CREATE OR REPLACE FUNCTION public.log_client_visit(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_note text, p_kind text, p_confirm boolean,
  p_client text, p_price_note text, p_folder uuid, p_photos jsonb, p_share boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text := upper(coalesce(p_kind, 'PAID')); v_client text := nullif(btrim(coalesce(p_client, '')), '');
  v_pnote text := nullif(left(btrim(coalesce(p_price_note, '')), 300), ''); v_price bigint; v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_prefix text; ph jsonb; r jsonb; v_id uuid; v_pos integer := 0; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
  n_w integer; n_b integer; n_a integer; v_found boolean;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN RETURN private.deny(p_branch, 'service_log'); END IF;
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
  IF v_kind IN ('PAID','BACKJOB') THEN
    IF n_w < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'WAIVER_PHOTOS_REQUIRED'); END IF;
    IF n_b < 1 OR n_a < 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'BEFORE_AFTER_REQUIRED'); END IF;
  END IF;

  r := public.log_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, NULL, p_note, v_kind, p_confirm);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = v_client, list_price_cents = v_price, price_note = v_pnote,
    share_ok = coalesce(p_share, false) AND (n_b + n_a) > 0, photo_folder = p_folder WHERE id = v_id;
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
    VALUES (private.current_org_id(), v_id, p_branch, ph ->> 'kind', ph ->> 'path', ph ->> 'thumb', v_pos, private.current_user_id());
    v_pos := v_pos + 1;
  END LOOP;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean) TO authenticated;

-- One month of client folders: each visit with its client, service, branch, lead/assist and photos.
-- p_social: only visits whose client allowed sharing, before/after photos only (the Social media tab).
CREATE OR REPLACE FUNCTION public.client_photo_folders(p_month date, p_branch uuid, p_social boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
      'branch_id', l.branch_id, 'branch', b.name, 'lead', pe.full_name, 'assist', ae.full_name, 'type', l.commission_type,
      'kind', l.visit_kind, 'share_ok', l.share_ok, 'state', l.state,
      'photos', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'path', p.path, 'thumb', p.thumb_path)
                   ORDER BY CASE p.kind WHEN 'BEFORE' THEN 1 WHEN 'AFTER' THEN 2 ELSE 3 END, p.position), '[]'::jsonb)
                 FROM public.service_photos p WHERE p.service_log_id = l.id AND (NOT coalesce(p_social, false) OR p.kind <> 'WAIVER')))
    ORDER BY l.service_date DESC, l.created_at DESC), '[]'::jsonb)
  FROM public.service_logs l CROSS JOIN m
  LEFT JOIN public.services sv ON sv.id = l.service_id
  LEFT JOIN public.branches b ON b.id = l.branch_id
  LEFT JOIN public.employees pe ON pe.id = l.performer_id
  LEFT JOIN public.employees ae ON ae.id = l.assistant_id
  WHERE l.organization_id = private.current_org_id() AND l.client_name IS NOT NULL
    AND l.service_date >= m.s AND l.service_date < (m.s + interval '1 month')::date
    AND (p_branch IS NULL OR l.branch_id = p_branch) AND l.state <> 'REJECTED'
    AND EXISTS (SELECT 1 FROM public.service_photos p WHERE p.service_log_id = l.id)
    AND CASE WHEN coalesce(p_social, false) THEN private.can_see_social() AND l.share_ok ELSE private.can_see_archive(l.branch_id) END
$$;
REVOKE ALL ON FUNCTION public.client_photo_folders(date, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_photo_folders(date, uuid, boolean) TO authenticated;

-- Owners and the GM can change the sharing choice later (e.g. the client changed their mind).
CREATE OR REPLACE FUNCTION public.set_photo_sharing(p_log uuid, p_share boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs%ROWTYPE;
BEGIN
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'photo_sharing'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  -- Not an entry field, so it can change after sign-off: written around the entry guard.
  PERFORM set_config('hermosa.photo_sharing', 'on', true);
  UPDATE public.service_logs SET share_ok = coalesce(p_share, false) WHERE id = p_log;
  PERFORM private.audit(l.branch_id, 'PHOTO_SHARING_SET', 'service_log', p_log::text, jsonb_build_object('share_ok', l.share_ok), jsonb_build_object('share_ok', p_share));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_photo_sharing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_photo_sharing(uuid, boolean) TO authenticated;

-- The entry guard (update-0020) lets the sharing choice change on a signed-off entry, through set_photo_sharing only.
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED'; END IF;
  IF current_setting('hermosa.photo_sharing', true) = 'on'
     AND (to_jsonb(NEW) - 'share_ok') = (to_jsonb(OLD) - 'share_ok') THEN RETURN NEW; END IF;
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

-- Private photo folder: client-photos/<branch>/<visit folder>/<file>. Full-size originals (up to 30 MB each).
-- Staff who log services at a branch upload into it; opening a file follows the archive / social media rules above.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('client-photos', 'client-photos', false, 31457280, ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS client_photos_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY client_photos_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'client-photos' AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
                  AND private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], ((storage.foldername(name))[1])::uuid))$p$;
    EXECUTE 'DROP POLICY IF EXISTS client_photos_read ON storage.objects';
    EXECUTE $p$CREATE POLICY client_photos_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'client-photos' AND private.can_open_client_photo(name))$p$;
  END IF;
END $$;
