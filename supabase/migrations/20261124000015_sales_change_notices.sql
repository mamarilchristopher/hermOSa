-- HERMOSA OS 0015: sales change notices and two-person rule for repeat changes (owner request 2026-11-24).
--   * Every change to a recorded day's total notifies all other management members (owners, finance and
--     managers of that branch, including the general manager) in the app.
--   * The first change to a day applies as before (at once while the pre-launch switch is off).
--   * Once a day has been changed, any further change needs two people, even before launch: it waits until
--     a different owner, finance or general manager confirms it on Daily Sales.
-- Safe to run more than once.

ALTER TABLE public.sales_corrections ADD COLUMN IF NOT EXISTS needs_two boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  kind text NOT NULL,
  title text NOT NULL CHECK (length(title) <= 200),
  body text CHECK (body IS NULL OR length(body) <= 1000),
  link text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  created_by uuid REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_unread ON public.notifications (user_id, created_at DESC) WHERE read_at IS NULL;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.notifications TO authenticated;
DROP POLICY IF EXISTS notifications_own ON public.notifications;
CREATE POLICY notifications_own ON public.notifications FOR SELECT TO authenticated
  USING (user_id = private.current_user_id());

-- Everyone in management for a branch except the person who acted.
CREATE OR REPLACE FUNCTION private.notify_management(p_branch uuid, p_kind text, p_title text, p_body text, p_link text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_n integer;
BEGIN
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT v_org, u.id, p_kind, left(p_title, 200), left(p_body, 1000), p_link, v_user
  FROM public.app_users u JOIN public.role_grants g ON g.user_id = u.id
  WHERE u.organization_id = v_org AND u.active AND coalesce(u.join_status, 'APPROVED') = 'APPROVED'
    AND g.revoked_at IS NULL AND g.role_code IN ('OWNER','FINANCE','MANAGER')
    AND (g.branch_id IS NULL OR g.branch_id = p_branch)
    AND u.id IS DISTINCT FROM v_user;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION private.correction_text(c public.sales_corrections) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT name FROM public.branches WHERE id = c.branch_id) || ', ' || to_char(c.business_date, 'Mon FMDD, YYYY') || ': ₱' ||
         to_char(c.old_cents / 100.0, 'FM999,999,990.00') || ' → ₱' || to_char(c.new_cents / 100.0, 'FM999,999,990.00') ||
         '. Reason: ' || c.reason || '. By ' || coalesce((SELECT display_name FROM public.app_users WHERE id = c.requested_by), 'someone') || '.'
$$;

CREATE OR REPLACE FUNCTION public.request_sales_correction(p_branch uuid, p_date date, p_cents bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_old bigint; v_id uuid;
  v_two boolean; v_res jsonb; c public.sales_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], p_branch) THEN RETURN private.deny(p_branch, 'sales_correction'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  IF p_cents IS NULL OR p_cents <= 0 OR p_cents > 100000000000 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT sum(gross_cents) INTO v_old FROM public.historical_sales
  WHERE branch_id = p_branch AND posting_date = p_date AND reversed_at IS NULL;
  IF v_old IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CORRECT'); END IF;
  IF v_old = p_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'SAME_AMOUNT'); END IF;
  IF EXISTS (SELECT 1 FROM public.sales_corrections WHERE branch_id = p_branch AND business_date = p_date AND state = 'PENDING') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CORRECTION_PENDING');
  END IF;
  v_two := EXISTS (SELECT 1 FROM public.sales_corrections WHERE branch_id = p_branch AND business_date = p_date AND state = 'APPLIED');
  INSERT INTO public.sales_corrections (organization_id, branch_id, business_date, old_cents, new_cents, reason, requested_by, needs_two)
  VALUES (v_org, p_branch, p_date, v_old, p_cents, left(btrim(p_reason), 500), v_user, v_two) RETURNING * INTO c;
  v_id := c.id;
  PERFORM private.audit(p_branch, 'SALES_CORRECTION_REQUESTED', 'sales_correction', v_id::text,
    jsonb_build_object('cents', v_old), jsonb_build_object('date', p_date, 'cents', p_cents, 'reason', p_reason, 'needs_two', v_two));
  IF NOT v_two AND private.daily_self_publish(p_branch) THEN
    v_res := private.apply_correction(v_id);
    PERFORM private.notify_management(p_branch, 'SALES_CHANGED', 'Sales changed', private.correction_text(c),
      '/sales/daily?month=' || to_char(p_date, 'YYYY-MM'));
    RETURN v_res;
  END IF;
  PERFORM private.notify_management(p_branch, 'SALES_CHANGE_WAITING',
    CASE WHEN v_two THEN 'Sales change needs your confirmation (changed before)' ELSE 'Sales change needs your confirmation' END,
    private.correction_text(c), '/sales/daily?month=' || to_char(p_date, 'YYYY-MM'));
  RETURN jsonb_build_object('ok', true, 'state', 'PENDING', 'id', v_id, 'needs_two', v_two);
END $$;

-- A second person approves or rejects. Owners and finance may always decide; the general manager may decide
-- repeat changes too. Never the requester for a repeat change, even before launch.
CREATE OR REPLACE FUNCTION public.decide_sales_correction(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); c public.sales_corrections%ROWTYPE; v_res jsonb; v_who text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO c FROM public.sales_corrections WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','FINANCE'], c.branch_id) OR (c.needs_two AND private.has_role(ARRAY['MANAGER'], NULL))) THEN
    RETURN private.deny(c.branch_id, 'sales_correction',
      CASE WHEN NOT private.has_mfa() AND EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = v_user AND g.revoked_at IS NULL
                                                    AND g.role_code IN ('OWNER','FINANCE')) THEN 'MFA_REQUIRED' ELSE 'FORBIDDEN' END);
  END IF;
  IF c.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF c.requested_by = v_user AND (c.needs_two OR NOT private.owner_may_self_confirm(c.branch_id)) THEN
    RETURN private.deny(c.branch_id, 'sales_correction', 'SELF_APPROVAL_DENIED');
  END IF;
  SELECT display_name INTO v_who FROM public.app_users WHERE id = v_user;
  IF coalesce(p_approve, false) THEN
    UPDATE public.sales_corrections SET decision_note = nullif(left(btrim(coalesce(p_note, '')), 500), '') WHERE id = p_id;
    v_res := private.apply_correction(p_id);
    PERFORM private.notify_management(c.branch_id, 'SALES_CHANGED', 'Sales change confirmed',
      private.correction_text(c) || ' Confirmed by ' || coalesce(v_who, 'someone') || '.', '/sales/daily?month=' || to_char(c.business_date, 'YYYY-MM'));
    RETURN v_res;
  END IF;
  IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
  UPDATE public.sales_corrections SET state = 'REJECTED', decided_by = v_user, decided_at = now(), decision_note = left(btrim(p_note), 500)
  WHERE id = p_id;
  PERFORM private.audit(c.branch_id, 'SALES_CORRECTION_REJECTED', 'sales_correction', p_id::text, NULL, jsonb_build_object('note', p_note));
  PERFORM private.notify_management(c.branch_id, 'SALES_CHANGE_REJECTED', 'Sales change rejected',
    private.correction_text(c) || ' Rejected by ' || coalesce(v_who, 'someone') || ': ' || left(btrim(p_note), 300), '/sales/daily?month=' || to_char(c.business_date, 'YYYY-MM'));
  RETURN jsonb_build_object('ok', true, 'state', 'REJECTED');
END $$;

-- Mark your own notices read (all of them when p_ids is null).
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_n integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  UPDATE public.notifications SET read_at = now()
  WHERE user_id = v_user AND read_at IS NULL AND (p_ids IS NULL OR id = ANY (p_ids));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'count', v_n);
END $$;

-- Which days were already changed once (a further change needs two people), for the Daily Sales grid.
CREATE OR REPLACE FUNCTION public.changed_sales_days(p_start date, p_end date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_array(c.branch_id, c.business_date)), '[]'::jsonb)
  FROM public.sales_corrections c
  WHERE c.organization_id = private.current_org_id() AND c.state = 'APPLIED'
    AND c.business_date BETWEEN p_start AND p_end
    AND private.has_role(ARRAY['OWNER','FINANCE','AUDITOR','MANAGER'], c.branch_id)
$$;

REVOKE ALL ON FUNCTION private.notify_management(uuid, text, text, text, text), private.correction_text(public.sales_corrections)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]), public.changed_sales_days(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]), public.changed_sales_days(date, date) TO authenticated;
