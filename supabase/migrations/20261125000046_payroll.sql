-- update-0046: payroll and payslips.
--   * Pay settings per staff member (monthly or daily rate, allowance per cutoff, switches for government deductions,
--     tax and late deductions). Owners and the GM set them.
--   * Holidays (regular / special), editable by owners and the GM; Nov-Dec 2026 seeded.
--   * Payroll per cutoff (1st-15th, 16th-month end): computed from the schedule, time clock, leave, irregular days and
--     signed-off commissions; extra lines (overtime, cash advance, loans) added by hand; finalized by an owner or the GM.
--   * Payslips: staff see their own once the payroll is final; each commission is paid once.
-- PH rules used (accountant to confirm): SSS employee 5% of the monthly salary credit (P5,000-P35,000, P500 steps);
-- PhilHealth employee 2.5% of basic (floor P10,000, ceiling P100,000); Pag-IBIG employee 2% (1% up to P1,500) of at most
-- P10,000; withholding tax from the semi-monthly table (TRAIN, 2023 onward). Daily rate of a monthly salary = monthly x 12 / 313.

CREATE OR REPLACE FUNCTION private.can_payroll() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()
$$;
REVOKE ALL ON FUNCTION private.can_payroll() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_payroll() TO authenticated;

CREATE TABLE IF NOT EXISTS public.pay_settings (
  employee_id uuid PRIMARY KEY REFERENCES public.employees(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  basis text NOT NULL CHECK (basis IN ('MONTHLY','DAILY')),
  rate_cents bigint NOT NULL CHECK (rate_cents >= 0 AND rate_cents <= 100000000),
  allowance_cents bigint NOT NULL DEFAULT 0 CHECK (allowance_cents >= 0 AND allowance_cents <= 10000000),
  statutory boolean NOT NULL DEFAULT true,
  tax boolean NOT NULL DEFAULT true,
  deduct_lates boolean NOT NULL DEFAULT true,
  updated_by uuid NOT NULL REFERENCES public.app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.holidays (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  holiday_date date NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  kind text NOT NULL CHECK (kind IN ('REGULAR','SPECIAL')),
  PRIMARY KEY (organization_id, holiday_date)
);

CREATE SEQUENCE IF NOT EXISTS public.payslip_no_seq;

CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','FINAL')),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz,
  finalized_by uuid REFERENCES public.app_users(id),
  finalized_at timestamptz,
  UNIQUE (organization_id, period_start),
  CHECK (extract(day FROM period_start) IN (1, 16) AND period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS public.payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.payroll_runs(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  slip_no text NOT NULL DEFAULT 'PS-' || lpad(nextval('public.payslip_no_seq')::text, 4, '0'),
  basis text NOT NULL,
  rate_cents bigint NOT NULL,
  earnings jsonb NOT NULL DEFAULT '[]',
  deductions jsonb NOT NULL DEFAULT '[]',
  commissions jsonb NOT NULL DEFAULT '[]',
  attendance jsonb NOT NULL DEFAULT '{}',
  gross_cents bigint NOT NULL DEFAULT 0,
  deductions_cents bigint NOT NULL DEFAULT 0,
  net_cents bigint NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id),
  UNIQUE (slip_no)
);
CREATE INDEX IF NOT EXISTS payslips_employee ON public.payslips (employee_id);

CREATE TABLE IF NOT EXISTS public.payslip_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.payroll_runs(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  kind text NOT NULL CHECK (kind IN ('EARNING','DEDUCTION')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 60),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  taxable boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payslip_adjustments_run ON public.payslip_adjustments (run_id, employee_id);

-- Each commission line is paid on one final payslip only.
CREATE TABLE IF NOT EXISTS public.commission_paid (
  commission_line_id uuid PRIMARY KEY REFERENCES public.commission_lines(id),
  payslip_id uuid NOT NULL REFERENCES public.payslips(id)
);

ALTER TABLE public.pay_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslip_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_paid ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.pay_settings, public.holidays, public.payroll_runs, public.payslips, public.payslip_adjustments, public.commission_paid TO authenticated;

DROP POLICY IF EXISTS pay_settings_read ON public.pay_settings;
CREATE POLICY pay_settings_read ON public.pay_settings FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (private.can_payroll() OR employee_id = private.my_employee_id()));
DROP POLICY IF EXISTS holidays_read ON public.holidays;
CREATE POLICY holidays_read ON public.holidays FOR SELECT TO authenticated USING (organization_id = private.current_org_id());
DROP POLICY IF EXISTS payroll_runs_read ON public.payroll_runs;
CREATE POLICY payroll_runs_read ON public.payroll_runs FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (private.can_payroll() OR state = 'FINAL'));
DROP POLICY IF EXISTS payslips_read ON public.payslips;
CREATE POLICY payslips_read ON public.payslips FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (private.can_payroll()
         OR (employee_id = private.my_employee_id() AND EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id = run_id AND r.state = 'FINAL'))));
DROP POLICY IF EXISTS payslip_adjustments_read ON public.payslip_adjustments;
CREATE POLICY payslip_adjustments_read ON public.payslip_adjustments FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_payroll());
DROP POLICY IF EXISTS commission_paid_read ON public.commission_paid;
CREATE POLICY commission_paid_read ON public.commission_paid FOR SELECT TO authenticated USING (private.can_payroll());

-- A final payroll can't change.
CREATE OR REPLACE FUNCTION public.guard_payroll_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_run uuid;
BEGIN
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    IF OLD.state = 'FINAL' THEN RAISE EXCEPTION 'PAYROLL_IS_FINAL'; END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_run := CASE WHEN TG_OP = 'INSERT' THEN NEW.run_id ELSE OLD.run_id END;
  IF EXISTS (SELECT 1 FROM public.payroll_runs WHERE id = v_run AND state = 'FINAL') THEN RAISE EXCEPTION 'PAYROLL_IS_FINAL'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS payroll_runs_final ON public.payroll_runs;
CREATE TRIGGER payroll_runs_final BEFORE UPDATE OR DELETE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_final();
DROP TRIGGER IF EXISTS payslips_final ON public.payslips;
CREATE TRIGGER payslips_final BEFORE INSERT OR UPDATE OR DELETE ON public.payslips FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_final();
DROP TRIGGER IF EXISTS payslip_adjustments_final ON public.payslip_adjustments;
CREATE TRIGGER payslip_adjustments_final BEFORE INSERT OR UPDATE OR DELETE ON public.payslip_adjustments FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_final();

-- ---------- PH contribution tables (monthly amounts in centavos) ----------
CREATE OR REPLACE FUNCTION private.sss_ee(p_monthly bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (least(3500000, greatest(500000, 50000 * floor((p_monthly + 25000) / 50000.0)::bigint)) * 5 / 100)::bigint
$$;
CREATE OR REPLACE FUNCTION private.philhealth_ee(p_monthly bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT round(least(10000000, greatest(1000000, p_monthly)) * 0.025)::bigint
$$;
CREATE OR REPLACE FUNCTION private.pagibig_ee(p_monthly bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT round(least(1000000, p_monthly) * CASE WHEN p_monthly <= 150000 THEN 0.01 ELSE 0.02 END)::bigint
$$;
-- Semi-monthly withholding tax (BIR table, 2023 onward) on taxable pay for one cutoff.
CREATE OR REPLACE FUNCTION private.wtax_semi(p_taxable bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT round(CASE
    WHEN p_taxable <= 1041700 THEN 0
    WHEN p_taxable <= 1666600 THEN (p_taxable - 1041700) * 0.15
    WHEN p_taxable <= 3333200 THEN 93750 + (p_taxable - 1666700) * 0.20
    WHEN p_taxable <= 8333200 THEN 427070 + (p_taxable - 3333300) * 0.25
    WHEN p_taxable <= 33333200 THEN 1677070 + (p_taxable - 8333300) * 0.30
    ELSE 9177070 + (p_taxable - 33333300) * 0.35 END)::bigint
$$;

-- ---------- Settings ----------
CREATE OR REPLACE FUNCTION public.save_pay_settings(p_employee uuid, p_basis text, p_rate_cents bigint, p_allowance_cents bigint,
  p_statutory boolean, p_tax boolean, p_deduct_lates boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); v_prior jsonb;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'pay_settings'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee AND organization_id = v_org) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  IF p_basis NOT IN ('MONTHLY','DAILY') OR p_rate_cents IS NULL OR p_rate_cents < 0 OR p_rate_cents > 100000000
     OR coalesce(p_allowance_cents, 0) < 0 OR coalesce(p_allowance_cents, 0) > 10000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT to_jsonb(s) - 'updated_by' - 'updated_at' INTO v_prior FROM public.pay_settings s WHERE employee_id = p_employee;
  INSERT INTO public.pay_settings (employee_id, organization_id, basis, rate_cents, allowance_cents, statutory, tax, deduct_lates, updated_by)
  VALUES (p_employee, v_org, p_basis, p_rate_cents, coalesce(p_allowance_cents, 0), coalesce(p_statutory, true), coalesce(p_tax, true), coalesce(p_deduct_lates, true), v_me)
  ON CONFLICT (employee_id) DO UPDATE SET basis = EXCLUDED.basis, rate_cents = EXCLUDED.rate_cents, allowance_cents = EXCLUDED.allowance_cents,
    statutory = EXCLUDED.statutory, tax = EXCLUDED.tax, deduct_lates = EXCLUDED.deduct_lates, updated_by = v_me, updated_at = now();
  PERFORM private.audit(NULL, 'PAY_SETTINGS_SAVED', 'employee', p_employee::text, v_prior,
    jsonb_build_object('basis', p_basis, 'rate_cents', p_rate_cents, 'allowance_cents', p_allowance_cents, 'statutory', p_statutory, 'tax', p_tax, 'deduct_lates', p_deduct_lates));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.save_holiday(p_date date, p_name text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id();
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'holiday'); END IF;
  IF p_date IS NULL OR length(btrim(coalesce(p_name, ''))) < 2 OR p_kind NOT IN ('REGULAR','SPECIAL') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_HOLIDAY'); END IF;
  INSERT INTO public.holidays (organization_id, holiday_date, name, kind) VALUES (v_org, p_date, left(btrim(p_name), 80), p_kind)
  ON CONFLICT (organization_id, holiday_date) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind;
  PERFORM private.audit(NULL, 'HOLIDAY_SAVED', 'holiday', p_date::text, NULL, jsonb_build_object('name', p_name, 'kind', p_kind));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.delete_holiday(p_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'holiday'); END IF;
  DELETE FROM public.holidays WHERE organization_id = private.current_org_id() AND holiday_date = p_date;
  PERFORM private.audit(NULL, 'HOLIDAY_DELETED', 'holiday', p_date::text);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------- Computing one payslip ----------
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
BEGIN
  SELECT * INTO r FROM public.payroll_runs WHERE id = p_run;
  SELECT * INTO ps FROM public.pay_settings WHERE employee_id = p_employee;
  IF NOT FOUND THEN DELETE FROM public.payslips WHERE run_id = p_run AND employee_id = p_employee; RETURN; END IF;
  SELECT late_grace_minutes INTO v_grace FROM public.organizations WHERE id = r.organization_id;
  v_first := extract(day FROM r.period_start) = 1;
  v_daily := CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents * 12 / 313.0 ELSE ps.rate_cents END;
  v_monthly_base := CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents ELSE ps.rate_cents * 26 END;

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
  IF v_reg_worked > 0 THEN
    v_hol := v_hol + round(v_daily * v_reg_worked);
    v_earn := v_earn || jsonb_build_object('label', 'Regular holiday worked (+100%, ' || v_reg_worked || ' day' || CASE WHEN v_reg_worked > 1 THEN 's' ELSE '' END || ')', 'amount', round(v_daily * v_reg_worked));
  END IF;
  IF v_spec_worked > 0 THEN
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
  IF ps.statutory THEN
    v_sss := CASE WHEN v_first THEN private.sss_ee(v_monthly_base) / 2 ELSE private.sss_ee(v_monthly_base) - private.sss_ee(v_monthly_base) / 2 END;
    v_ph := CASE WHEN v_first THEN private.philhealth_ee(v_monthly_base) / 2 ELSE private.philhealth_ee(v_monthly_base) - private.philhealth_ee(v_monthly_base) / 2 END;
    v_pi := CASE WHEN v_first THEN private.pagibig_ee(v_monthly_base) / 2 ELSE private.pagibig_ee(v_monthly_base) - private.pagibig_ee(v_monthly_base) / 2 END;
    v_ded := v_ded || jsonb_build_object('label', 'SSS premium', 'amount', v_sss)
                   || jsonb_build_object('label', 'PhilHealth', 'amount', v_ph)
                   || jsonb_build_object('label', 'Pag-IBIG fund', 'amount', v_pi);
  END IF;
  IF ps.tax THEN
    v_taxable := greatest(0, v_gross - v_nontax - v_abs - v_late - v_sss - v_ph - v_pi);
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

CREATE OR REPLACE FUNCTION private.compute_run(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e record; v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.payroll_runs WHERE id = p_run;
  DELETE FROM public.payslips p WHERE p.run_id = p_run
    AND NOT EXISTS (SELECT 1 FROM public.pay_settings s JOIN public.employees x ON x.id = s.employee_id WHERE s.employee_id = p.employee_id AND x.active);
  FOR e IN SELECT x.id FROM public.employees x JOIN public.pay_settings s ON s.employee_id = x.id WHERE x.organization_id = v_org AND x.active LOOP
    PERFORM private.compute_payslip(p_run, e.id);
  END LOOP;
  UPDATE public.payroll_runs SET computed_at = now() WHERE id = p_run;
END $$;
REVOKE ALL ON FUNCTION private.compute_run(uuid) FROM PUBLIC, anon, authenticated;

-- Opens (or recomputes) the payroll for the cutoff that holds p_date.
CREATE OR REPLACE FUNCTION public.open_payroll(p_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); v_s date; v_e date; v_id uuid; v_state text;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'payroll'); END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date + 31 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  v_s := CASE WHEN extract(day FROM p_date) <= 15 THEN date_trunc('month', p_date)::date ELSE date_trunc('month', p_date)::date + 15 END;
  v_e := CASE WHEN extract(day FROM p_date) <= 15 THEN date_trunc('month', p_date)::date + 14 ELSE (date_trunc('month', p_date) + interval '1 month - 1 day')::date END;
  SELECT id, state INTO v_id, v_state FROM public.payroll_runs WHERE organization_id = v_org AND period_start = v_s;
  IF v_id IS NULL THEN
    INSERT INTO public.payroll_runs (organization_id, period_start, period_end, created_by) VALUES (v_org, v_s, v_e, v_me) RETURNING id INTO v_id;
    v_state := 'DRAFT';
  END IF;
  IF v_state = 'DRAFT' THEN PERFORM private.compute_run(v_id); END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'state', v_state);
END $$;

CREATE OR REPLACE FUNCTION public.add_payslip_adjustment(p_run uuid, p_employee uuid, p_kind text, p_label text, p_amount_cents bigint, p_taxable boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); v_id uuid;
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'payroll'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_runs WHERE id = p_run AND organization_id = v_org AND state = 'DRAFT') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYROLL_IS_FINAL'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payslips WHERE run_id = p_run AND employee_id = p_employee) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  IF p_kind NOT IN ('EARNING','DEDUCTION') OR length(btrim(coalesce(p_label, ''))) < 2 OR coalesce(p_amount_cents, 0) <= 0 OR p_amount_cents > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  INSERT INTO public.payslip_adjustments (run_id, organization_id, employee_id, kind, label, amount_cents, taxable, created_by)
  VALUES (p_run, v_org, p_employee, p_kind, left(btrim(p_label), 60), p_amount_cents, coalesce(p_taxable, true), v_me) RETURNING id INTO v_id;
  PERFORM private.compute_payslip(p_run, p_employee);
  PERFORM private.audit(NULL, 'PAYSLIP_ADJUSTED', 'payslip_adjustment', v_id::text, NULL,
    jsonb_build_object('employee_id', p_employee, 'kind', p_kind, 'label', p_label, 'amount_cents', p_amount_cents));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.remove_payslip_adjustment(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.payslip_adjustments%ROWTYPE;
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'payroll'); END IF;
  SELECT * INTO a FROM public.payslip_adjustments WHERE id = p_id AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF EXISTS (SELECT 1 FROM public.payroll_runs WHERE id = a.run_id AND state = 'FINAL') THEN RETURN jsonb_build_object('ok', false, 'error', 'PAYROLL_IS_FINAL'); END IF;
  DELETE FROM public.payslip_adjustments WHERE id = p_id;
  PERFORM private.compute_payslip(a.run_id, a.employee_id);
  PERFORM private.audit(NULL, 'PAYSLIP_ADJUSTMENT_REMOVED', 'payslip_adjustment', p_id::text, to_jsonb(a), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Final: recompute once more, lock, mark commissions paid, tell each person their payslip is ready.
CREATE OR REPLACE FUNCTION public.finalize_payroll(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_me uuid := private.current_user_id(); r public.payroll_runs%ROWTYPE; v_n integer;
BEGIN
  IF NOT private.can_payroll() THEN RETURN private.deny(NULL, 'payroll'); END IF;
  SELECT * INTO r FROM public.payroll_runs WHERE id = p_run AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF r.state = 'FINAL' THEN RETURN jsonb_build_object('ok', false, 'error', 'PAYROLL_IS_FINAL'); END IF;
  IF (now() AT TIME ZONE 'Asia/Manila')::date < r.period_end THEN RETURN jsonb_build_object('ok', false, 'error', 'CUTOFF_NOT_OVER'); END IF;
  PERFORM private.compute_run(p_run);
  INSERT INTO public.commission_paid (commission_line_id, payslip_id)
  SELECT (c ->> 'id')::uuid, p.id FROM public.payslips p, jsonb_array_elements(p.commissions) c WHERE p.run_id = p_run
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO v_n FROM public.payslips WHERE run_id = p_run;
  UPDATE public.payroll_runs SET state = 'FINAL', finalized_by = v_me, finalized_at = now() WHERE id = p_run;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT v_org, e.app_user_id, 'PAYSLIP_READY', 'Your payslip is ready',
         'Payslip ' || p.slip_no || ' for ' || to_char(r.period_start, 'Mon FMDD') || ' to ' || to_char(r.period_end, 'Mon FMDD, YYYY') || '. Tap to view or save it.',
         '/payslips/' || p.id, v_me
  FROM public.payslips p JOIN public.employees e ON e.id = p.employee_id WHERE p.run_id = p_run AND e.app_user_id IS NOT NULL;
  PERFORM private.audit(NULL, 'PAYROLL_FINALIZED', 'payroll_run', p_run::text, NULL, jsonb_build_object('payslips', v_n));
  RETURN jsonb_build_object('ok', true, 'payslips', v_n);
END $$;

REVOKE ALL ON FUNCTION public.save_pay_settings(uuid, text, bigint, bigint, boolean, boolean, boolean), public.save_holiday(date, text, text),
  public.delete_holiday(date), public.open_payroll(date), public.add_payslip_adjustment(uuid, uuid, text, text, bigint, boolean),
  public.remove_payslip_adjustment(uuid), public.finalize_payroll(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pay_settings(uuid, text, bigint, bigint, boolean, boolean, boolean), public.save_holiday(date, text, text),
  public.delete_holiday(date), public.open_payroll(date), public.add_payslip_adjustment(uuid, uuid, text, text, bigint, boolean),
  public.remove_payslip_adjustment(uuid), public.finalize_payroll(uuid) TO authenticated;

-- PH holidays for the rest of 2026 (owners and the GM can add or change any).
INSERT INTO public.holidays (organization_id, holiday_date, name, kind)
SELECT o.id, v.d::date, v.n, v.k FROM public.organizations o,
  (VALUES ('2026-11-30', 'Bonifacio Day', 'REGULAR'), ('2026-12-08', 'Feast of the Immaculate Conception', 'SPECIAL'),
          ('2026-12-24', 'Christmas Eve', 'SPECIAL'), ('2026-12-25', 'Christmas Day', 'REGULAR'),
          ('2026-12-30', 'Rizal Day', 'REGULAR'), ('2026-12-31', 'Last Day of the Year', 'SPECIAL')) AS v(d, n, k)
ON CONFLICT DO NOTHING;
