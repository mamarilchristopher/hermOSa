-- update-0047: payroll rules from the owners' answers (Nov 25, 2026).
--   * A day's pay of a monthly salary = monthly / 26 (was x 12 / 313).
--   * SSS, PhilHealth and Pag-IBIG are deducted in full on the 1st-15th cutoff (organizations.payroll_rules.statutory_cutoff:
--     FIRST, SECOND or SPLIT).
--   * Working a special non-working day pays +30% (payroll_rules.special_worked_premium, on) and a regular holiday worked
--     pays double, for everyone except CSRs (contractors on basic pay only: no holiday premiums).
--   * Lates are not deducted from pay by default (NTE / IR only); the per-person switch stays.
--   * Declared salary per person (optional): government shares and the tax on basic pay use it instead of the actual rate.
--   * 13th month pay: a month's basic pay x months worked in the year / 12, prorated from the start date for staff hired
--     in the year (CHRIS: from Jan 1, 2026), less unpaid absences on final payslips / 12. CSRs (contractors) excluded.
--     Added as a non-taxable line on a draft cutoff's payslips (due by Dec 24).
--   * COLA per person: a monthly amount paid in full on the 1st-15th cutoff, not taxed. Only an Owner sets it; when the
--     GM changes it, the change waits for an Owner to approve (CHRIS Nov 25).

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS payroll_rules jsonb NOT NULL
  DEFAULT '{"statutory_cutoff": "FIRST", "special_worked_premium": true, "daily_divisor": 26}';
UPDATE public.organizations SET payroll_rules = payroll_rules || '{"special_worked_premium": true}';
ALTER TABLE public.pay_settings ADD COLUMN IF NOT EXISTS declared_cents bigint CHECK (declared_cents IS NULL OR (declared_cents >= 0 AND declared_cents <= 100000000));
ALTER TABLE public.pay_settings ADD COLUMN IF NOT EXISTS cola_cents bigint NOT NULL DEFAULT 0 CHECK (cola_cents >= 0 AND cola_cents <= 10000000);
ALTER TABLE public.pay_settings ALTER COLUMN deduct_lates SET DEFAULT false;
UPDATE public.pay_settings SET deduct_lates = false;

DROP FUNCTION IF EXISTS public.save_pay_settings(uuid, text, bigint, bigint, boolean, boolean, boolean);
CREATE OR REPLACE FUNCTION public.save_pay_settings(p_employee uuid, p_basis text, p_rate_cents bigint, p_allowance_cents bigint,
  p_statutory boolean, p_tax boolean, p_deduct_lates boolean, p_declared_cents bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); v_prior jsonb;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'pay_settings'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee AND organization_id = v_org) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  IF p_basis NOT IN ('MONTHLY','DAILY') OR p_rate_cents IS NULL OR p_rate_cents < 0 OR p_rate_cents > 100000000
     OR coalesce(p_allowance_cents, 0) < 0 OR coalesce(p_allowance_cents, 0) > 10000000
     OR coalesce(p_declared_cents, 0) < 0 OR coalesce(p_declared_cents, 0) > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT to_jsonb(s) - 'updated_by' - 'updated_at' INTO v_prior FROM public.pay_settings s WHERE employee_id = p_employee;
  INSERT INTO public.pay_settings (employee_id, organization_id, basis, rate_cents, allowance_cents, statutory, tax, deduct_lates, declared_cents, updated_by)
  VALUES (p_employee, v_org, p_basis, p_rate_cents, coalesce(p_allowance_cents, 0), coalesce(p_statutory, true), coalesce(p_tax, true),
          coalesce(p_deduct_lates, false), p_declared_cents, v_me)
  ON CONFLICT (employee_id) DO UPDATE SET basis = EXCLUDED.basis, rate_cents = EXCLUDED.rate_cents, allowance_cents = EXCLUDED.allowance_cents,
    statutory = EXCLUDED.statutory, tax = EXCLUDED.tax, deduct_lates = EXCLUDED.deduct_lates, declared_cents = EXCLUDED.declared_cents,
    updated_by = v_me, updated_at = now();
  PERFORM private.audit(NULL, 'PAY_SETTINGS_SAVED', 'employee', p_employee::text, v_prior,
    jsonb_build_object('basis', p_basis, 'rate_cents', p_rate_cents, 'allowance_cents', p_allowance_cents, 'statutory', p_statutory,
                       'tax', p_tax, 'deduct_lates', p_deduct_lates, 'declared_cents', p_declared_cents));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.save_pay_settings(uuid, text, bigint, bigint, boolean, boolean, boolean, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pay_settings(uuid, text, bigint, bigint, boolean, boolean, boolean, bigint) TO authenticated;

-- Owners and the GM change the company-wide rules.
CREATE OR REPLACE FUNCTION public.save_payroll_rules(p_statutory_cutoff text, p_special_worked_premium boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prior jsonb;
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'payroll_rules'); END IF;
  IF p_statutory_cutoff NOT IN ('FIRST','SECOND','SPLIT') THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_RULE'); END IF;
  SELECT payroll_rules INTO v_prior FROM public.organizations WHERE id = private.current_org_id();
  UPDATE public.organizations SET payroll_rules = coalesce(payroll_rules, '{}')
    || jsonb_build_object('statutory_cutoff', p_statutory_cutoff, 'special_worked_premium', coalesce(p_special_worked_premium, false))
  WHERE id = private.current_org_id();
  PERFORM private.audit(NULL, 'PAYROLL_RULES_SAVED', 'organization', private.current_org_id()::text, v_prior,
    jsonb_build_object('statutory_cutoff', p_statutory_cutoff, 'special_worked_premium', p_special_worked_premium));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.save_payroll_rules(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_payroll_rules(text, boolean) TO authenticated;

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
    AND NOT EXISTS (SELECT 1 FROM public.commission_paid cp WHERE cp.commission_line_id = c.id);
  IF v_comm > 0 THEN v_earn := v_earn || jsonb_build_object('label', 'Commission (' || jsonb_array_length(v_comm_list) || ')', 'amount', v_comm); END IF;
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

-- ---------- 13th month pay ----------
CREATE OR REPLACE FUNCTION public.thirteenth_month(p_year integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_y0 date; v_y1 date;
BEGIN
  IF NOT private.can_payroll() THEN RETURN '[]'::jsonb; END IF;
  v_y0 := make_date(p_year, 1, 1); v_y1 := make_date(p_year, 12, 31);
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x ->> 'name') FROM (
    SELECT jsonb_build_object('employee_id', e.id, 'name', e.full_name, 'uid', e.uid, 'hire_date', e.hire_date,
      'monthly', m.monthly, 'months', round(m.months, 2), 'prorated', m.prorated, 'absences', m.absences,
      'amount', greatest(0, round((m.monthly * m.months - m.absences) / 12.0))::bigint) AS x
    FROM public.employees e JOIN public.pay_settings ps ON ps.employee_id = e.id
    CROSS JOIN LATERAL (SELECT
      CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents ELSE ps.rate_cents * 26 END AS monthly,
      CASE WHEN e.hire_date IS NOT NULL AND e.hire_date > v_y0 THEN greatest(0, (v_y1 - e.hire_date + 1)) * 12.0 / (v_y1 - v_y0 + 1) ELSE 12 END AS months,
      (e.hire_date IS NOT NULL AND e.hire_date > v_y0) AS prorated,
      coalesce((SELECT sum((d ->> 'amount')::bigint) FROM public.payslips p JOIN public.payroll_runs r ON r.id = p.run_id,
                  jsonb_array_elements(p.deductions) d
                WHERE p.employee_id = e.id AND r.state = 'FINAL' AND extract(year FROM r.period_start) = p_year
                  AND d ->> 'label' LIKE 'Absences%'), 0) AS absences) m
    WHERE e.organization_id = v_org AND e.active AND upper(coalesce(e.position, '')) <> 'CSR'
      AND (e.hire_date IS NULL OR e.hire_date <= v_y1)) q), '[]'::jsonb);
END $$;

-- Adds each person's 13th month pay as a non-taxable line on a draft cutoff (once per person per year).
CREATE OR REPLACE FUNCTION public.add_thirteenth_month(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); r public.payroll_runs%ROWTYPE; x jsonb; v_label text; v_n integer := 0;
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'payroll'); END IF;
  SELECT * INTO r FROM public.payroll_runs WHERE id = p_run AND organization_id = v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF r.state = 'FINAL' THEN RETURN jsonb_build_object('ok', false, 'error', 'PAYROLL_IS_FINAL'); END IF;
  v_label := '13th month pay ' || extract(year FROM r.period_start)::int;
  FOR x IN SELECT * FROM jsonb_array_elements(public.thirteenth_month(extract(year FROM r.period_start)::int)) LOOP
    CONTINUE WHEN (x ->> 'amount')::bigint <= 0;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.payslips WHERE run_id = p_run AND employee_id = (x ->> 'employee_id')::uuid);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.payslip_adjustments a JOIN public.payroll_runs rr ON rr.id = a.run_id
                          WHERE a.employee_id = (x ->> 'employee_id')::uuid AND a.label = v_label);
    INSERT INTO public.payslip_adjustments (run_id, organization_id, employee_id, kind, label, amount_cents, taxable, created_by)
    VALUES (p_run, v_org, (x ->> 'employee_id')::uuid, 'EARNING', v_label, (x ->> 'amount')::bigint, false, v_me);
    PERFORM private.compute_payslip(p_run, (x ->> 'employee_id')::uuid);
    v_n := v_n + 1;
  END LOOP;
  PERFORM private.audit(NULL, 'THIRTEENTH_MONTH_ADDED', 'payroll_run', p_run::text, NULL, jsonb_build_object('people', v_n));
  RETURN jsonb_build_object('ok', true, 'added', v_n);
END $$;
REVOKE ALL ON FUNCTION public.thirteenth_month(integer), public.add_thirteenth_month(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.thirteenth_month(integer), public.add_thirteenth_month(uuid) TO authenticated;

-- COLA changes. An Owner's change applies at once; the GM's waits for an Owner (one waiting change per person).
CREATE TABLE IF NOT EXISTS public.cola_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  old_cents bigint NOT NULL DEFAULT 0,
  new_cents bigint NOT NULL CHECK (new_cents >= 0 AND new_cents <= 10000000),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','REJECTED')),
  requested_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS cola_requests_pending ON public.cola_requests (organization_id) WHERE state = 'PENDING';
ALTER TABLE public.cola_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.cola_requests TO authenticated;
DROP POLICY IF EXISTS cola_requests_read ON public.cola_requests;
CREATE POLICY cola_requests_read ON public.cola_requests FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_payroll());

CREATE OR REPLACE FUNCTION public.request_cola(p_employee uuid, p_cents bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); v_old bigint; v_owner boolean; v_name text;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'cola'); END IF;
  IF p_cents IS NULL OR p_cents < 0 OR p_cents > 10000000 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT s.cola_cents, e.full_name INTO v_old, v_name FROM public.pay_settings s JOIN public.employees e ON e.id = s.employee_id
  WHERE s.employee_id = p_employee AND s.organization_id = v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_PAY_RATE'); END IF;
  v_owner := private.has_role(ARRAY['OWNER'], NULL);
  -- A newer change replaces one still waiting.
  UPDATE public.cola_requests SET state = 'REJECTED', decided_by = v_me, decided_at = now()
  WHERE employee_id = p_employee AND state = 'PENDING';
  IF v_owner THEN
    INSERT INTO public.cola_requests (organization_id, employee_id, old_cents, new_cents, state, requested_by, decided_by, decided_at)
    VALUES (v_org, p_employee, v_old, p_cents, 'APPROVED', v_me, v_me, now());
    UPDATE public.pay_settings SET cola_cents = p_cents, updated_by = v_me, updated_at = now() WHERE employee_id = p_employee;
    PERFORM private.audit(NULL, 'COLA_SET', 'employee', p_employee::text, jsonb_build_object('cola_cents', v_old), jsonb_build_object('cola_cents', p_cents));
    RETURN jsonb_build_object('ok', true, 'applied', true);
  END IF;
  INSERT INTO public.cola_requests (organization_id, employee_id, old_cents, new_cents, requested_by)
  VALUES (v_org, p_employee, v_old, p_cents, v_me);
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT v_org, u.id, 'COLA_REQUEST', 'COLA change to approve',
         left(v_name || ': ₱' || to_char(v_old / 100.0, 'FM999,990') || ' → ₱' || to_char(p_cents / 100.0, 'FM999,990') || ' a month. Asked by '
           || coalesce((SELECT display_name FROM public.app_users WHERE id = v_me), 'the GM') || '.', 1000), '/payroll', v_me
  FROM public.app_users u JOIN public.role_grants g ON g.user_id = u.id
  WHERE u.organization_id = v_org AND u.active AND g.revoked_at IS NULL AND g.role_code = 'OWNER' AND u.id <> v_me;
  PERFORM private.audit(NULL, 'COLA_REQUESTED', 'employee', p_employee::text, jsonb_build_object('cola_cents', v_old), jsonb_build_object('cola_cents', p_cents));
  RETURN jsonb_build_object('ok', true, 'applied', false);
END $$;

-- Owners only (not the GM): approve or turn down a waiting COLA change.
CREATE OR REPLACE FUNCTION public.decide_cola(p_request uuid, p_approve boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id(); q public.cola_requests;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN RETURN private.deny(NULL, 'cola_approve'); END IF;
  SELECT * INTO q FROM public.cola_requests WHERE id = p_request AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF q.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_DECIDED'); END IF;
  UPDATE public.cola_requests SET state = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END, decided_by = v_me, decided_at = now() WHERE id = q.id;
  IF p_approve THEN
    UPDATE public.pay_settings SET cola_cents = q.new_cents, updated_by = v_me, updated_at = now() WHERE employee_id = q.employee_id;
  END IF;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT q.organization_id, q.requested_by, 'COLA_DECIDED', CASE WHEN p_approve THEN 'COLA change approved' ELSE 'COLA change not approved' END,
         left(e.full_name || ': ₱' || to_char(q.new_cents / 100.0, 'FM999,990') || ' a month.', 1000), '/payroll', v_me
  FROM public.employees e WHERE e.id = q.employee_id AND q.requested_by <> v_me;
  PERFORM private.audit(NULL, CASE WHEN p_approve THEN 'COLA_APPROVED' ELSE 'COLA_REJECTED' END, 'employee', q.employee_id::text,
    jsonb_build_object('cola_cents', q.old_cents), jsonb_build_object('cola_cents', q.new_cents));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.request_cola(uuid, bigint), public.decide_cola(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_cola(uuid, bigint), public.decide_cola(uuid, boolean) TO authenticated;

-- Recompute open (draft) payrolls with the new rules.
DO $$ DECLARE r record; BEGIN FOR r IN SELECT id FROM public.payroll_runs WHERE state = 'DRAFT' LOOP PERFORM private.compute_run(r.id); END LOOP; END $$;
