-- update-0076 (v0.76.0, CHRIS Nov 26): "ALL MANAGEMENT should get a Proof of payment for confirmation urgent notice whenever a
-- proof of payment is attached. This allows us to check if the transfer went in."
-- Owners and the GM get an urgent notice (and phone push) for every attached proof, then mark it Received or Not received.
-- The person who attached it is told the result.

CREATE TABLE IF NOT EXISTS public.payment_checks (
  service_log_id uuid PRIMARY KEY REFERENCES public.service_logs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RECEIVED','NOT_RECEIVED')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_checks_pending_idx ON public.payment_checks (organization_id) WHERE state = 'PENDING';
ALTER TABLE public.payment_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_checks_read ON public.payment_checks;
CREATE POLICY payment_checks_read ON public.payment_checks FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_see_payment_proof(service_log_id));
REVOKE INSERT, UPDATE, DELETE ON public.payment_checks FROM anon, authenticated;
GRANT SELECT ON public.payment_checks TO authenticated;
-- Proofs attached before this update wait for confirmation too.
INSERT INTO public.payment_checks (service_log_id, organization_id, branch_id)
SELECT DISTINCT p.service_log_id, p.organization_id, p.branch_id FROM public.payment_proofs p ON CONFLICT (service_log_id) DO NOTHING;

-- The urgent notice to every owner and the GM (not the person who attached it).
CREATE OR REPLACE FUNCTION private.notify_payment_proof(p_log uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l record;
BEGIN
  SELECT s.id, s.organization_id, s.service_date, s.client_name, s.amount_paid_cents, b.name AS branch, sv.name AS service INTO l
  FROM public.service_logs s JOIN public.branches b ON b.id = s.branch_id LEFT JOIN public.services sv ON sv.id = s.service_id WHERE s.id = p_log;
  -- One notice per entry at a time: an older unread one for the same entry is replaced.
  DELETE FROM public.notifications WHERE kind = 'PAYMENT_PROOF' AND read_at IS NULL AND link LIKE '%entry=' || p_log::text;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT l.organization_id, u.id, 'PAYMENT_PROOF', 'Urgent: confirm proof of payment',
    coalesce(l.client_name, 'Client') || ' · ' || coalesce(l.service, 'service') || ' · ₱' || to_char(l.amount_paid_cents / 100.0, 'FM999,999,990.00') ||
    ' · ' || l.branch || ', ' || to_char(l.service_date, 'Mon FMDD') || '. Check that the transfer came in, then mark it Received or Not received.',
    '/clinic/payments?month=' || to_char(l.service_date, 'YYYY-MM') || '&entry=' || l.id::text, private.current_user_id()
  FROM public.app_users u
  WHERE u.organization_id = l.organization_id AND u.active AND coalesce(u.join_status, 'APPROVED') = 'APPROVED'
    AND private.is_management(u.id) AND u.id IS DISTINCT FROM private.current_user_id();
END $$;
REVOKE ALL ON FUNCTION private.notify_payment_proof(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_payment_proof(p_log uuid, p_photos jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  ph jsonb; v_found boolean; v_storage boolean := to_regclass('storage.objects') IS NOT NULL; v_have integer; v_prefix text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user) OR l.created_by = v_user
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user)
          OR EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = v_user AND g.revoked_at IS NULL AND (g.branch_id = l.branch_id OR g.branch_id IS NULL))) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  IF jsonb_typeof(v_photos) <> 'array' OR jsonb_array_length(v_photos) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT count(*) INTO v_have FROM public.payment_proofs WHERE service_log_id = p_log;
  IF v_have + jsonb_array_length(v_photos) > 5 THEN RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY'); END IF;
  v_prefix := l.branch_id::text || '/[0-9a-f-]{36}/';
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    IF coalesce(ph ->> 'path', '') !~ ('^' || v_prefix || 'proof-[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$')
       OR (ph ->> 'thumb' IS NOT NULL AND (ph ->> 'thumb') !~ ('^' || v_prefix || 'thumb-[0-9a-f-]{36}\.jpg$')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF v_storage THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''payment-proofs'' AND o.name = $1)' INTO v_found USING ph ->> 'path';
      IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_NOT_UPLOADED'); END IF;
    END IF;
  END LOOP;
  INSERT INTO public.payment_proofs (organization_id, service_log_id, branch_id, path, thumb_path, created_by)
  SELECT l.organization_id, p_log, l.branch_id, x ->> 'path', x ->> 'thumb', v_user FROM jsonb_array_elements(v_photos) x
  ON CONFLICT (path) DO NOTHING;
  -- update-0076 (CHRIS Nov 26): every proof goes to management to confirm the transfer came in.
  INSERT INTO public.payment_checks (service_log_id, organization_id, branch_id, state)
  VALUES (p_log, l.organization_id, l.branch_id, 'PENDING')
  ON CONFLICT (service_log_id) DO UPDATE SET state = 'PENDING', note = NULL, decided_by = NULL, decided_at = NULL, updated_at = now();
  PERFORM private.notify_payment_proof(p_log);
  PERFORM private.audit(l.branch_id, 'PAYMENT_PROOF_ADDED', 'service_log', p_log::text, NULL, jsonb_build_object('count', jsonb_array_length(v_photos)));
  RETURN jsonb_build_object('ok', true, 'count', (SELECT count(*) FROM public.payment_proofs WHERE service_log_id = p_log));
END $$;
REVOKE ALL ON FUNCTION public.add_payment_proof(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_payment_proof(uuid, jsonb) TO authenticated;

-- Owners and the GM: was the money received?
CREATE OR REPLACE FUNCTION public.confirm_payment(p_log uuid, p_received boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); k public.payment_checks%ROWTYPE; l record; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF v_user IS NULL OR NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  SELECT * INTO k FROM public.payment_checks WHERE service_log_id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p_received IS NULL OR length(coalesce(v_note, '')) > 300 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  UPDATE public.payment_checks SET state = CASE WHEN p_received THEN 'RECEIVED' ELSE 'NOT_RECEIVED' END, note = v_note,
    decided_by = v_user, decided_at = now(), updated_at = now() WHERE service_log_id = p_log;
  -- Done for everyone in management.
  UPDATE public.notifications SET read_at = now() WHERE kind = 'PAYMENT_PROOF' AND read_at IS NULL AND link LIKE '%entry=' || p_log::text;
  -- Tell whoever attached the proof.
  SELECT s.service_date, s.client_name, b.code, sv.name AS service INTO l
  FROM public.service_logs s JOIN public.branches b ON b.id = s.branch_id LEFT JOIN public.services sv ON sv.id = s.service_id WHERE s.id = p_log;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT k.organization_id, p.created_by, CASE WHEN p_received THEN 'PAYMENT_RECEIVED' ELSE 'PAYMENT_NOT_RECEIVED' END,
    CASE WHEN p_received THEN 'Payment received ✓' ELSE 'Payment not received' END,
    coalesce(l.client_name, 'Client') || ' · ' || coalesce(l.service, 'service') || ', ' || to_char(l.service_date, 'Mon FMDD') ||
    CASE WHEN p_received THEN '. Management confirmed the transfer came in.' ELSE '. Management could not find this transfer.' END ||
    coalesce(' Note: ' || v_note, ''),
    '/services?date=' || l.service_date::text || '&branch=' || l.code || '&entry=' || p_log::text, v_user
  FROM public.payment_proofs p WHERE p.service_log_id = p_log AND p.created_by IS DISTINCT FROM v_user;
  PERFORM private.audit(k.branch_id, CASE WHEN p_received THEN 'PAYMENT_RECEIVED' ELSE 'PAYMENT_NOT_RECEIVED' END, 'service_log', p_log::text,
    jsonb_build_object('state', k.state), jsonb_build_object('note', v_note));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.confirm_payment(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.payment_proof_folders(p_month date, p_branch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
      'branch_id', l.branch_id, 'branch', b.name, 'amount_cents', l.amount_paid_cents, 'kind', l.visit_kind, 'state', l.state,
      'check', (SELECT jsonb_build_object('state', k.state, 'note', k.note, 'by', u2.display_name, 'at', k.decided_at)
                FROM public.payment_checks k LEFT JOIN public.app_users u2 ON u2.id = k.decided_by WHERE k.service_log_id = l.id),
      'proofs', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path, 'thumb', p.thumb_path, 'by', u.display_name, 'at', p.created_at)
                   ORDER BY p.created_at), '[]'::jsonb)
                 FROM public.payment_proofs p LEFT JOIN public.app_users u ON u.id = p.created_by WHERE p.service_log_id = l.id))
    ORDER BY l.service_date DESC, lower(coalesce(l.client_name, '')), l.created_at), '[]'::jsonb)
  FROM public.service_logs l CROSS JOIN m
  LEFT JOIN public.services sv ON sv.id = l.service_id
  LEFT JOIN public.branches b ON b.id = l.branch_id
  WHERE l.organization_id = private.current_org_id()
    AND l.service_date >= m.s AND l.service_date < (m.s + interval '1 month')::date
    AND (p_branch IS NULL OR l.branch_id = p_branch)
    AND EXISTS (SELECT 1 FROM public.payment_proofs p WHERE p.service_log_id = l.id)
    AND private.can_see_payment_proof(l.id)
$$;
REVOKE ALL ON FUNCTION public.payment_proof_folders(date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payment_proof_folders(date, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_payment_proof(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); p public.payment_proofs%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.payment_proofs WHERE id = p_id AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (p.created_by = v_user OR private.is_management(v_user)) THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  DELETE FROM public.payment_proofs WHERE id = p_id;
  -- update-0076: no proofs left, nothing to confirm.
  IF NOT EXISTS (SELECT 1 FROM public.payment_proofs WHERE service_log_id = p.service_log_id) THEN
    DELETE FROM public.payment_checks WHERE service_log_id = p.service_log_id;
    DELETE FROM public.notifications WHERE kind = 'PAYMENT_PROOF' AND read_at IS NULL AND link LIKE '%entry=' || p.service_log_id::text;
  END IF;
  PERFORM private.audit(p.branch_id, 'PAYMENT_PROOF_REMOVED', 'service_log', p.service_log_id::text, jsonb_build_object('path', p.path), NULL);
  RETURN jsonb_build_object('ok', true, 'path', p.path, 'thumb', p.thumb_path);
END $$;
REVOKE ALL ON FUNCTION public.remove_payment_proof(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_payment_proof(uuid) TO authenticated;
