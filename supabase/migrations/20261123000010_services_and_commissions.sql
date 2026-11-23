-- HERMOSA OS 0010: daily service log and staff commissions (owner request 2026-11-23, approved features
-- master, employee, sessions, salescomm, incentives; built ahead of Releases 4 and 7 at the owner's request).
-- Rules from the owner:
--   * Commission = 5% of the amount paid for the service (package/promo special cases come later).
--   * Types: SOLO (100% to the performer), LEAD + ASSIST (60/40 split), NONCOMMI (no commission).
--   * Staff who are not commission-based get no commission line.
--   * A manager (the general manager, or the branch manager, or an owner) signs off each entry, one by one.
--   * Entries unsigned for more than a day raise a notice for managers and owners.
-- Rates are copied onto every entry so later rule changes never rewrite history.

CREATE TABLE public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  position text CHECK (position IS NULL OR length(position) <= 80),
  commission_eligible boolean NOT NULL DEFAULT true,
  app_user_id uuid UNIQUE REFERENCES public.app_users(id),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX services_unique_name ON public.services (organization_id, lower(btrim(name)));

CREATE TABLE public.service_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  service_date date NOT NULL,
  service_id uuid NOT NULL REFERENCES public.services(id),
  amount_paid_cents bigint NOT NULL CHECK (amount_paid_cents >= 0),
  commission_type text NOT NULL CHECK (commission_type IN ('SOLO','LEAD','NONCOMMI')),
  performer_id uuid NOT NULL REFERENCES public.employees(id),  -- the lead for LEAD, the performer otherwise
  assistant_id uuid REFERENCES public.employees(id),
  rate_bp integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),          -- 500 = 5%
  lead_share_bp integer NOT NULL CHECK (lead_share_bp BETWEEN 0 AND 10000), -- 6000 = 60%
  receipt_no text CHECK (receipt_no IS NULL OR length(receipt_no) <= 40),
  note text CHECK (note IS NULL OR length(note) <= 300),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','REJECTED')),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  CONSTRAINT lead_needs_assistant CHECK ((commission_type = 'LEAD') = (assistant_id IS NOT NULL)),
  CONSTRAINT assistant_differs CHECK (assistant_id IS NULL OR assistant_id <> performer_id)
);
CREATE INDEX service_logs_branch_date ON public.service_logs (branch_id, service_date);
CREATE INDEX service_logs_pending ON public.service_logs (service_date) WHERE state = 'PENDING';

CREATE TABLE public.commission_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_log_id uuid NOT NULL REFERENCES public.service_logs(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  role text NOT NULL CHECK (role IN ('SOLO','LEAD','ASSIST')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (service_log_id, employee_id)  -- one person is never paid twice for the same service
);
CREATE INDEX commission_lines_employee ON public.commission_lines (employee_id);

-- Entries are never deleted; only the decision fields may change, once, from PENDING.
CREATE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED'; END IF;
  IF OLD.state <> 'PENDING' THEN RAISE EXCEPTION 'SERVICE_LOG_ALREADY_DECIDED'; END IF;
  IF (NEW.branch_id, NEW.service_date, NEW.service_id, NEW.amount_paid_cents, NEW.commission_type, NEW.performer_id,
      NEW.assistant_id, NEW.rate_bp, NEW.lead_share_bp, NEW.created_by)
     IS DISTINCT FROM (OLD.branch_id, OLD.service_date, OLD.service_id, OLD.amount_paid_cents, OLD.commission_type,
      OLD.performer_id, OLD.assistant_id, OLD.rate_bp, OLD.lead_share_bp, OLD.created_by) THEN
    RAISE EXCEPTION 'SERVICE_LOG_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_logs_guard BEFORE UPDATE OR DELETE ON public.service_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_service_logs();
CREATE FUNCTION public.guard_commission_lines() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'COMMISSION_LINES_ARE_IMMUTABLE'; END $$;
CREATE TRIGGER commission_lines_guard BEFORE UPDATE OR DELETE ON public.commission_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_commission_lines();

-- Row-level security ----------------------------------------------------------
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.employees, public.services, public.service_logs, public.commission_lines TO authenticated;

-- Anyone working at a branch can see who works there (to pick names) and the branch's daily service log.
CREATE POLICY employees_read ON public.employees FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (
    private.has_role(ARRAY['OWNER','FINANCE','HR','AUDITOR'], NULL)
    OR private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN','HR','INVENTORY'], branch_id)
    OR app_user_id = private.current_user_id()));
CREATE POLICY services_read ON public.services FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id());
CREATE POLICY service_logs_read ON public.service_logs FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (
    private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN','HR','AUDITOR'], branch_id)));
-- Commission amounts: management for the branch, HR/finance/auditor, or the employee themself.
CREATE POLICY commission_lines_read ON public.commission_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_logs l WHERE l.id = service_log_id AND l.organization_id = private.current_org_id()
                 AND private.has_role(ARRAY['OWNER','FINANCE','MANAGER','HR','AUDITOR'], l.branch_id))
         OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.app_user_id = private.current_user_id()));

-- API -------------------------------------------------------------------------
CREATE FUNCTION public.save_employee(p_id uuid, p_branch uuid, p_name text, p_position text, p_commission boolean,
  p_app_user uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  e public.employees%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','HR','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'employee'); END IF;
  IF coalesce(length(btrim(p_name)), 0) < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  IF p_app_user IS NOT NULL AND NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(p_branch, 'employee.link_login');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, btrim(p_name), nullif(btrim(coalesce(p_position, '')), ''), coalesce(p_commission, true), p_app_user, v_user)
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'EMPLOYEE_ADDED', 'employee', v_id::text, NULL,
      jsonb_build_object('commission_eligible', coalesce(p_commission, true)));
    RETURN jsonb_build_object('ok', true, 'id', v_id);
  END IF;
  SELECT * INTO e FROM public.employees WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','HR','MANAGER'], e.branch_id) THEN RETURN private.deny(e.branch_id, 'employee'); END IF;
  UPDATE public.employees SET branch_id = p_branch, full_name = btrim(p_name),
    position = nullif(btrim(coalesce(p_position, '')), ''), commission_eligible = coalesce(p_commission, e.commission_eligible),
    app_user_id = CASE WHEN private.has_role(ARRAY['OWNER'], NULL) THEN p_app_user ELSE e.app_user_id END,
    active = coalesce(p_active, e.active)
  WHERE id = p_id;
  PERFORM private.audit(p_branch, 'EMPLOYEE_UPDATED', 'employee', p_id::text,
    jsonb_build_object('branch_id', e.branch_id, 'commission_eligible', e.commission_eligible, 'active', e.active),
    jsonb_build_object('branch_id', p_branch, 'commission_eligible', p_commission, 'active', p_active));
  RETURN jsonb_build_object('ok', true, 'id', p_id);
END $$;

CREATE FUNCTION public.add_service(p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','MANAGER'], NULL)
          OR EXISTS (SELECT 1 FROM public.branches b WHERE b.organization_id = v_org AND private.has_role(ARRAY['MANAGER'], b.id))) THEN
    RETURN private.deny(NULL, 'service');
  END IF;
  IF coalesce(length(btrim(p_name)), 0) < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  SELECT id INTO v_id FROM public.services WHERE organization_id = v_org AND lower(btrim(name)) = lower(btrim(p_name));
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'id', v_id, 'duplicate', true); END IF;
  INSERT INTO public.services (organization_id, name, created_by) VALUES (v_org, btrim(p_name), v_user) RETURNING id INTO v_id;
  PERFORM private.audit(NULL, 'SERVICE_ADDED', 'service', v_id::text, NULL, jsonb_build_object('name', btrim(p_name)));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- p_type: 'LEAD' (p_employee leads, p_partner assisted), 'ASSIST' (p_employee assisted, p_partner led),
-- 'SOLO', or 'NONCOMMI'. ASSIST is stored as the same LEAD entry so the pair is never paid twice.
CREATE FUNCTION public.log_service(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_receipt text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_type text; v_lead uuid; v_assist uuid;
  v_rate integer := 500; v_share integer := 6000;
  v_total bigint; v_lead_cents bigint; v_id uuid;
  lead_ok boolean; assist_ok boolean;
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
  IF NOT EXISTS (SELECT 1 FROM public.services WHERE id = p_service AND organization_id = v_org AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE');
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
  v_total := (p_amount_cents * v_rate + 5000) / 10000;
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

-- Manager sign-off, one entry at a time. Owners, and managers for that branch (a company-wide MANAGER grant
-- is the general manager). Nobody signs off an entry they logged or are paid on, except an MFA owner while the
-- pre-launch switch is off (0006/0009).
CREATE FUNCTION public.decide_service_log(p_log uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  l public.service_logs%ROWTYPE;
  v_involved boolean;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','MANAGER'], l.branch_id) THEN
    RETURN private.deny(l.branch_id, 'service_log.decide');
  END IF;
  v_involved := l.created_by = v_user OR EXISTS (
    SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user);
  IF v_involved AND NOT private.owner_may_self_confirm(l.branch_id) THEN
    RETURN private.deny(l.branch_id, 'service_log.decide', 'SELF_APPROVAL_DENIED');
  END IF;
  IF l.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF NOT coalesce(p_approve, false) AND coalesce(length(btrim(p_note)), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED');
  END IF;
  UPDATE public.service_logs SET state = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END,
    decided_by = v_user, decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
  WHERE id = p_log;
  PERFORM private.audit(l.branch_id, CASE WHEN p_approve THEN 'SERVICE_LOG_APPROVED' ELSE 'SERVICE_LOG_REJECTED' END,
    'service_log', p_log::text, jsonb_build_object('state', 'PENDING'),
    jsonb_build_object('note', p_note, 'self_approved', v_involved));
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END);
END $$;

-- Days with entries still unsigned after more than a day, for branches the caller can sign off.
CREATE FUNCTION public.overdue_commission_days() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('branch_id', x.branch_id, 'code', x.code, 'name', x.name,
           'date', x.service_date, 'pending', x.n) ORDER BY x.service_date, x.code), '[]'::jsonb)
  FROM (SELECT l.branch_id, b.code, b.name, l.service_date, count(*) AS n
        FROM public.service_logs l JOIN public.branches b ON b.id = l.branch_id
        WHERE l.organization_id = private.current_org_id() AND l.state = 'PENDING'
          AND l.service_date < (now() AT TIME ZONE 'Asia/Manila')::date - 1
          AND private.has_role(ARRAY['OWNER','MANAGER'], l.branch_id)
        GROUP BY l.branch_id, b.code, b.name, l.service_date) x
$$;

REVOKE ALL ON FUNCTION public.save_employee(uuid, uuid, text, text, boolean, uuid, boolean), public.add_service(text),
  public.log_service(uuid, date, uuid, bigint, text, uuid, uuid, text, text), public.decide_service_log(uuid, boolean, text),
  public.overdue_commission_days(), public.guard_service_logs(), public.guard_commission_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_employee(uuid, uuid, text, text, boolean, uuid, boolean), public.add_service(text),
  public.log_service(uuid, date, uuid, bigint, text, uuid, uuid, text, text), public.decide_service_log(uuid, boolean, text),
  public.overdue_commission_days() TO authenticated;
