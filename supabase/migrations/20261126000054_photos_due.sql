-- update-0054: photos due (CHRIS, Nov 26, 2026).
--   * Owners and the GM can log a service without the client photos and waiver.
--   * The lead and assist on that entry then get an urgent notice on Home: add the before/after photos and both waiver pages.
--   * Only staff who are timed in today (Time clock: timed in, not yet timed out) can add Service log entries.
--     Owners and the GM can always add them.
--   * Until they're added, that entry's commission doesn't count toward their totals or payroll (it's paid on the next
--     payroll after the photos are added).

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS photos_due boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS service_logs_photos_due ON public.service_logs (organization_id) WHERE photos_due;

-- The entry guard: photo fields (sharing choice, photos due, photo folder) may change on a signed-off entry,
-- through set_photo_sharing / add_visit_photos only.
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED'; END IF;
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

-- Urgent notice to the lead and assist (those with a login) on an entry missing its photos.
CREATE OR REPLACE FUNCTION private.notify_photos_due(p_log uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l record;
BEGIN
  SELECT s.id, s.organization_id, s.service_date, s.client_name, b.code, sv.name AS service INTO l
  FROM public.service_logs s JOIN public.branches b ON b.id = s.branch_id LEFT JOIN public.services sv ON sv.id = s.service_id WHERE s.id = p_log;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT l.organization_id, e.app_user_id, 'PHOTOS_DUE', 'Urgent: add the client photos and waiver',
    coalesce(l.client_name, 'Client') || ' · ' || coalesce(l.service, 'service') || ', ' || to_char(l.service_date, 'Mon FMDD') ||
    '. Add the before and after photos and both waiver pages. Your commission for this entry won''t count toward your totals until they''re added.',
    '/services?date=' || l.service_date::text || '&branch=' || l.code || '&entry=' || l.id::text, private.current_user_id()
  FROM public.service_logs s JOIN public.employees e ON e.id IN (s.performer_id, s.assistant_id)
  WHERE s.id = p_log AND e.app_user_id IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION private.notify_photos_due(uuid) FROM PUBLIC, anon, authenticated;

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
  -- update-0054: owners and the GM may log without photos; the lead and assist are then asked to add them.
  v_due := v_kind IN ('PAID','BACKJOB') AND (n_w < 2 OR n_b < 1 OR n_a < 1);
  IF v_due AND NOT v_mgmt THEN
    IF n_w < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'WAIVER_PHOTOS_REQUIRED'); END IF;
    IF n_b < 1 OR n_a < 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'BEFORE_AFTER_REQUIRED'); END IF;
  END IF;

  r := public.log_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, NULL, p_note, v_kind, p_confirm);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = v_client, list_price_cents = v_price, price_note = v_pnote,
    share_ok = coalesce(p_share, false), photo_folder = p_folder, photos_due = v_due WHERE id = v_id;
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
    VALUES (private.current_org_id(), v_id, p_branch, ph ->> 'kind', ph ->> 'path', ph ->> 'thumb', v_pos, private.current_user_id());
    v_pos := v_pos + 1;
  END LOOP;
  IF v_due THEN PERFORM private.notify_photos_due(v_id); END IF;
  RETURN r || jsonb_build_object('photos_due', v_due);
END $$;

-- Add photos to an entry that's missing them: the lead, the assist, whoever logged it, or owners and the GM.
CREATE OR REPLACE FUNCTION public.add_visit_photos(p_log uuid, p_folder uuid, p_photos jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_folder uuid; v_prefix text; ph jsonb; v_found boolean; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
  v_pos integer; n_w integer; n_b integer; n_a integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user) OR l.created_by = v_user
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user)) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  v_folder := coalesce(l.photo_folder, p_folder);
  IF v_folder IS NULL OR jsonb_typeof(v_photos) <> 'array' OR jsonb_array_length(v_photos) = 0 OR jsonb_array_length(v_photos) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  v_prefix := l.branch_id::text || '/' || v_folder::text || '/';
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
  SELECT coalesce(max(position) + 1, 0) INTO v_pos FROM public.service_photos WHERE service_log_id = p_log;
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
    VALUES (l.organization_id, p_log, l.branch_id, ph ->> 'kind', ph ->> 'path', ph ->> 'thumb', v_pos, v_user)
    ON CONFLICT (path) DO NOTHING;
    v_pos := v_pos + 1;
  END LOOP;
  SELECT count(*) FILTER (WHERE kind = 'WAIVER'), count(*) FILTER (WHERE kind = 'BEFORE'), count(*) FILTER (WHERE kind = 'AFTER')
  INTO n_w, n_b, n_a FROM public.service_photos WHERE service_log_id = p_log;
  PERFORM set_config('hermosa.photo_sharing', 'on', true);
  UPDATE public.service_logs SET photo_folder = v_folder, photos_due = l.photos_due AND NOT (n_w >= 2 AND n_b >= 1 AND n_a >= 1) WHERE id = p_log;
  PERFORM set_config('hermosa.photo_sharing', 'off', true);
  IF l.photos_due AND n_w >= 2 AND n_b >= 1 AND n_a >= 1 THEN
    UPDATE public.notifications SET read_at = now() WHERE kind = 'PHOTOS_DUE' AND read_at IS NULL AND link LIKE '%&entry=' || p_log::text;
  END IF;
  RETURN jsonb_build_object('ok', true, 'complete', n_w >= 2 AND n_b >= 1 AND n_a >= 1, 'waivers', n_w, 'before', n_b, 'after', n_a);
END $$;
REVOKE ALL ON FUNCTION public.add_visit_photos(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_visit_photos(uuid, uuid, jsonb) TO authenticated;

-- Home: my entries still waiting for photos (as lead or assist).
CREATE OR REPLACE FUNCTION public.my_photos_due() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
           'branch', b.code, 'amount', (SELECT coalesce(sum(c.amount_cents), 0) FROM public.commission_lines c WHERE c.service_log_id = l.id AND c.employee_id = e.id))
         ORDER BY l.service_date), '[]'::jsonb)
  FROM public.service_logs l JOIN public.employees e ON e.id IN (l.performer_id, l.assistant_id)
  JOIN public.branches b ON b.id = l.branch_id LEFT JOIN public.services sv ON sv.id = l.service_id
  WHERE l.photos_due AND l.state <> 'REJECTED' AND e.app_user_id = private.current_user_id() AND l.organization_id = private.current_org_id()
$$;
REVOKE ALL ON FUNCTION public.my_photos_due() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_photos_due() TO authenticated;

-- Payroll: commission on an entry with photos still due waits for the next payroll after they're added.
CREATE OR REPLACE FUNCTION private.compute_payslip(p_run uuid, p_employee uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.payroll_runs%ROWTYPE;
  ps public.pay_settings%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_grace integer;
  v_daily numeric; v_monthly_base bigint;
  d record;
  n_worked integer := 0; n_paid_leave integer := 0; n_unpaid_leave integer := 0; n_absent integer := 0;
  v_late_min integer := 0; v_reg_worked integer := 0; v_spec_worked integer := 0; v_reg_off integer := 0;
  absent_dates text[] := '{}'; unpaid_dates text[] := '{}';
  v_basic bigint; v_abs bigint := 0; v_late bigint := 0; v_hol bigint := 0; v_comm bigint := 0;
  v_comm_list jsonb := '[]'; v_earn jsonb := '[]'; v_ded jsonb := '[]';
  v_sss bigint := 0; v_ph bigint := 0; v_pi bigint := 0; v_tax bigint := 0;
  v_gross bigint; v_dtotal bigint; v_taxable bigint; v_nontax bigint := 0;
  a record; v_first boolean;
  v_csr boolean; v_rules jsonb; v_stat_when text; v_special_premium boolean; v_divisor numeric; v_tax_basic bigint;
BEGIN
  SELECT * INTO r FROM public.payroll_runs WHERE id = p_run;
  SELECT * INTO ps FROM public.pay_settings WHERE employee_id = p_employee;
  IF NOT FOUND THEN DELETE FROM public.payslips WHERE run_id = p_run AND employee_id = p_employee; RETURN; END IF;
  SELECT late_grace_minutes, coalesce(payroll_rules, '{}') INTO v_grace, v_rules FROM public.organizations WHERE id = r.organization_id;
  v_stat_when := coalesce(v_rules ->> 'statutory_cutoff', 'FIRST');
  v_special_premium := coalesce((v_rules ->> 'special_worked_premium')::boolean, true);
  v_divisor := coalesce((v_rules ->> 'daily_divisor')::numeric, 26);
  SELECT upper(coalesce(position, '')) = 'CSR' INTO v_csr FROM public.employees WHERE id = p_employee;
  v_first := extract(day FROM r.period_start) = 1;
  v_daily := CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents / v_divisor ELSE ps.rate_cents END;
  -- Government shares (and tax on basic) use the declared salary when one is set.
  v_monthly_base := coalesce(ps.declared_cents, CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents ELSE ps.rate_cents * 26 END);

  -- Day by day from the published schedule.
  FOR d IN
    SELECT s.work_date, s.is_off, s.leave_type, s.start_time, h.kind AS hol,
           (SELECT min(t.punched_at) FROM public.time_punches t WHERE t.employee_id = s.employee_id AND t.work_date = s.work_date AND t.kind = 'IN') AS tin,
           private.is_irregular(s.employee_id, s.work_date) AS irregular,
           EXISTS (SELECT 1 FROM public.leave_requests l WHERE l.employee_id = s.employee_id AND l.state = 'APPROVED' AND l.with_pay
                     AND s.work_date BETWEEN l.start_date AND l.end_date) AS paid_leave
    FROM public.shifts s LEFT JOIN public.holidays h ON h.organization_id = s.organization_id AND h.holiday_date = s.work_date
    WHERE s.employee_id = p_employee AND s.state = 'PUBLISHED' AND s.work_date BETWEEN r.period_start AND r.period_end
    ORDER BY s.work_date
  LOOP
    IF d.is_off THEN
      IF d.leave_type IN ('VL','SL') THEN
        IF d.paid_leave THEN n_paid_leave := n_paid_leave + 1;
        ELSE n_unpaid_leave := n_unpaid_leave + 1; unpaid_dates := unpaid_dates || to_char(d.work_date, 'Mon FMDD'); END IF;
      ELSIF d.leave_type = 'ABSENT' AND d.hol IS DISTINCT FROM 'REGULAR' THEN
        n_absent := n_absent + 1; absent_dates := absent_dates || to_char(d.work_date, 'Mon FMDD');
      ELSIF d.hol = 'REGULAR' THEN v_reg_off := v_reg_off + 1;
      END IF;
    ELSIF d.tin IS NOT NULL THEN
      n_worked := n_worked + 1;
      IF d.hol = 'REGULAR' THEN v_reg_worked := v_reg_worked + 1; ELSIF d.hol = 'SPECIAL' THEN v_spec_worked := v_spec_worked + 1; END IF;
      IF NOT d.irregular THEN
        v_late_min := v_late_min + greatest(0, floor(extract(epoch FROM ((d.tin AT TIME ZONE 'Asia/Manila') - (d.work_date + d.start_time))) / 60)::int - v_grace);
      END IF;
    ELSIF d.work_date < v_today AND NOT d.irregular THEN
      IF d.hol = 'REGULAR' THEN v_reg_off := v_reg_off + 1;   -- regular holiday not worked: paid, not an absence
      ELSE n_absent := n_absent + 1; absent_dates := absent_dates || to_char(d.work_date, 'Mon FMDD'); END IF;
    END IF;
  END LOOP;

  -- Basic pay.
  IF ps.basis = 'MONTHLY' THEN
    v_basic := CASE WHEN v_first THEN ps.rate_cents / 2 ELSE ps.rate_cents - ps.rate_cents / 2 END;
    v_abs := round(v_daily * (n_absent + n_unpaid_leave));
  ELSE
    v_basic := round(v_daily * (n_worked + n_paid_leave + v_reg_off));
  END IF;
  v_earn := v_earn || jsonb_build_object('label', CASE ps.basis WHEN 'MONTHLY' THEN 'Basic pay (half of monthly salary)'
              ELSE 'Basic pay (' || (n_worked + n_paid_leave + v_reg_off) || ' days)' END, 'amount', v_basic);
  IF v_reg_worked > 0 AND NOT v_csr THEN
    v_hol := v_hol + round(v_daily * v_reg_worked);
    v_earn := v_earn || jsonb_build_object('label', 'Regular holiday worked (+100%, ' || v_reg_worked || ' day' || CASE WHEN v_reg_worked > 1 THEN 's' ELSE '' END || ')', 'amount', round(v_daily * v_reg_worked));
  END IF;
  IF v_spec_worked > 0 AND v_special_premium AND NOT v_csr THEN
    v_hol := v_hol + round(v_daily * 0.3 * v_spec_worked);
    v_earn := v_earn || jsonb_build_object('label', 'Special day worked (+30%, ' || v_spec_worked || ' day' || CASE WHEN v_spec_worked > 1 THEN 's' ELSE '' END || ')', 'amount', round(v_daily * 0.3 * v_spec_worked));
  END IF;

  -- Commissions: signed off, dated up to the cutoff's last day, not paid on an earlier final payslip.
  SELECT coalesce(sum(c.amount_cents), 0),
         coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'date', l.service_date, 'service', sv.name, 'role', c.role,
                    'paid', l.amount_paid_cents, 'amount', c.amount_cents) ORDER BY l.service_date, sv.name), '[]')
    INTO v_comm, v_comm_list
  FROM public.commission_lines c JOIN public.service_logs l ON l.id = c.service_log_id JOIN public.services sv ON sv.id = l.service_id
  WHERE c.employee_id = p_employee AND l.state = 'APPROVED' AND l.service_date <= r.period_end
    AND NOT l.photos_due  -- update-0054: held until the client photos and waiver are added
    AND NOT EXISTS (SELECT 1 FROM public.commission_paid cp WHERE cp.commission_line_id = c.id);
  IF v_comm > 0 THEN v_earn := v_earn || jsonb_build_object('label', 'Commission (' || jsonb_array_length(v_comm_list) || ')', 'amount', v_comm); END IF;
  v_nontax := v_nontax + v_comm;   -- commissions are not taxed (CHRIS Nov 25)
  IF ps.allowance_cents > 0 THEN
    v_earn := v_earn || jsonb_build_object('label', 'Allowance', 'amount', ps.allowance_cents);
    v_nontax := v_nontax + ps.allowance_cents;
  END IF;
  IF ps.cola_cents > 0 AND v_first THEN
    v_earn := v_earn || jsonb_build_object('label', 'COLA', 'amount', ps.cola_cents);
    v_nontax := v_nontax + ps.cola_cents;
  END IF;
  FOR a IN SELECT * FROM public.payslip_adjustments WHERE run_id = p_run AND employee_id = p_employee AND kind = 'EARNING' ORDER BY created_at LOOP
    v_earn := v_earn || jsonb_build_object('label', a.label, 'amount', a.amount_cents, 'adjustment', a.id);
    IF NOT a.taxable THEN v_nontax := v_nontax + a.amount_cents; END IF;
  END LOOP;
  SELECT coalesce(sum((x ->> 'amount')::bigint), 0) INTO v_gross FROM jsonb_array_elements(v_earn) x;

  -- Deductions.
  IF v_abs > 0 THEN
    v_ded := v_ded || jsonb_build_object('label', 'Absences (' || array_to_string(absent_dates || unpaid_dates, ', ') || ')', 'amount', v_abs);
  END IF;
  IF ps.deduct_lates AND v_late_min > 0 THEN
    v_late := round(v_daily / 480.0 * v_late_min);
    IF v_late > 0 THEN v_ded := v_ded || jsonb_build_object('label', 'Lates (' || v_late_min || ' min)', 'amount', v_late); END IF;
  END IF;
  IF ps.statutory AND (v_stat_when = 'SPLIT' OR (v_stat_when = 'FIRST') = v_first) THEN
    v_sss := CASE WHEN v_stat_when <> 'SPLIT' THEN private.sss_ee(v_monthly_base) WHEN v_first THEN private.sss_ee(v_monthly_base) / 2 ELSE private.sss_ee(v_monthly_base) - private.sss_ee(v_monthly_base) / 2 END;
    v_ph := CASE WHEN v_stat_when <> 'SPLIT' THEN private.philhealth_ee(v_monthly_base) WHEN v_first THEN private.philhealth_ee(v_monthly_base) / 2 ELSE private.philhealth_ee(v_monthly_base) - private.philhealth_ee(v_monthly_base) / 2 END;
    v_pi := CASE WHEN v_stat_when <> 'SPLIT' THEN private.pagibig_ee(v_monthly_base) WHEN v_first THEN private.pagibig_ee(v_monthly_base) / 2 ELSE private.pagibig_ee(v_monthly_base) - private.pagibig_ee(v_monthly_base) / 2 END;
    v_ded := v_ded || jsonb_build_object('label', 'SSS premium', 'amount', v_sss)
                   || jsonb_build_object('label', 'PhilHealth', 'amount', v_ph)
                   || jsonb_build_object('label', 'Pag-IBIG fund', 'amount', v_pi);
  END IF;
  IF ps.tax THEN
    -- With a declared salary, tax is on half of it (instead of the actual basic) plus the other taxable pay.
    v_tax_basic := CASE WHEN ps.declared_cents IS NOT NULL THEN ps.declared_cents / 2 ELSE v_basic END;
    v_taxable := greatest(0, v_gross - v_basic + v_tax_basic - v_nontax - v_abs - v_late - v_sss - v_ph - v_pi);
    v_tax := private.wtax_semi(v_taxable);
    IF v_tax > 0 THEN v_ded := v_ded || jsonb_build_object('label', 'Withholding tax', 'amount', v_tax); END IF;
  END IF;
  FOR a IN SELECT * FROM public.payslip_adjustments WHERE run_id = p_run AND employee_id = p_employee AND kind = 'DEDUCTION' ORDER BY created_at LOOP
    v_ded := v_ded || jsonb_build_object('label', a.label, 'amount', a.amount_cents, 'adjustment', a.id);
  END LOOP;
  SELECT coalesce(sum((x ->> 'amount')::bigint), 0) INTO v_dtotal FROM jsonb_array_elements(v_ded) x;

  INSERT INTO public.payslips (run_id, organization_id, employee_id, basis, rate_cents, earnings, deductions, commissions, attendance,
                               gross_cents, deductions_cents, net_cents, computed_at)
  VALUES (p_run, r.organization_id, p_employee, ps.basis, ps.rate_cents, v_earn, v_ded, v_comm_list,
          jsonb_build_object('worked', n_worked, 'paid_leave', n_paid_leave, 'unpaid_leave', n_unpaid_leave, 'absent', n_absent,
                             'late_min', v_late_min, 'daily_rate', round(v_daily)),
          v_gross, v_dtotal, v_gross - v_dtotal, now())
  ON CONFLICT (run_id, employee_id) DO UPDATE SET basis = EXCLUDED.basis, rate_cents = EXCLUDED.rate_cents, earnings = EXCLUDED.earnings,
    deductions = EXCLUDED.deductions, commissions = EXCLUDED.commissions, attendance = EXCLUDED.attendance, gross_cents = EXCLUDED.gross_cents,
    deductions_cents = EXCLUDED.deductions_cents, net_cents = EXCLUDED.net_cents, computed_at = now();
END $$;
REVOKE ALL ON FUNCTION private.compute_payslip(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.compute_payslip(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Service log: only staff on duty (timed in today, not timed out) add entries; owners and the GM always can.
CREATE OR REPLACE FUNCTION private.on_duty(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.employees e WHERE e.app_user_id = p_user AND e.active
    AND (SELECT t.kind FROM public.time_punches t WHERE t.employee_id = e.id AND t.work_date = (now() AT TIME ZONE 'Asia/Manila')::date
         ORDER BY t.punched_at DESC LIMIT 1) = 'IN')
$$;
REVOKE ALL ON FUNCTION private.on_duty(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_log_services_now() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_management(private.current_user_id()) OR private.on_duty(private.current_user_id())
$$;
REVOKE ALL ON FUNCTION public.can_log_services_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_log_services_now() TO authenticated;

-- Backstop for every way an entry is added (log_service, log_visit, log_client_visit).
CREATE OR REPLACE FUNCTION private.service_log_on_duty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (private.is_management(NEW.created_by) OR private.on_duty(NEW.created_by)) THEN RAISE EXCEPTION 'NOT_TIMED_IN'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS service_logs_on_duty ON public.service_logs;
CREATE TRIGGER service_logs_on_duty BEFORE INSERT ON public.service_logs FOR EACH ROW EXECUTE FUNCTION private.service_log_on_duty();
