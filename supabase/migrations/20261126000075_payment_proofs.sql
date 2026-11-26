-- update-0075 (v0.75.0, CHRIS Nov 26): proof of payment on service log entries.
-- "Attach proof of payment" (optional, usually for online transfers) when logging or later on any entry.
-- Proofs live in their own private folder ("payment-proofs", <branch>/<visit folder>/proof-<id>.<ext>) and their own
-- Proof of payment tab, sorted by service date, then client name.
-- Who can open them: owners and the GM, whoever logged the entry, its lead and assist, and whoever attached the proof.

CREATE TABLE IF NOT EXISTS public.payment_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_log_id uuid NOT NULL REFERENCES public.service_logs(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  path text NOT NULL UNIQUE,
  thumb_path text,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_proofs_log_idx ON public.payment_proofs (service_log_id);

-- May the signed-in person see this entry's proofs?
CREATE OR REPLACE FUNCTION private.can_see_payment_proof(p_log uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.service_logs l
    WHERE l.id = p_log AND l.organization_id = private.current_org_id()
      AND (private.is_management(private.current_user_id()) OR l.created_by = private.current_user_id()
           OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = private.current_user_id())
           OR EXISTS (SELECT 1 FROM public.payment_proofs pp WHERE pp.service_log_id = l.id AND pp.created_by = private.current_user_id())))
$$;
REVOKE ALL ON FUNCTION private.can_see_payment_proof(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_see_payment_proof(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.can_open_payment_proof(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.payment_proofs p WHERE (p.path = p_name OR p.thumb_path = p_name)
                 AND p.organization_id = private.current_org_id() AND private.can_see_payment_proof(p.service_log_id))
$$;
REVOKE ALL ON FUNCTION private.can_open_payment_proof(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_open_payment_proof(text) TO authenticated;

ALTER TABLE public.payment_proofs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_proofs_read ON public.payment_proofs;
CREATE POLICY payment_proofs_read ON public.payment_proofs FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_see_payment_proof(service_log_id));
REVOKE INSERT, UPDATE, DELETE ON public.payment_proofs FROM anon, authenticated;
GRANT SELECT ON public.payment_proofs TO authenticated;

-- Attach proofs to an entry (any state but rejected): owners and the GM, whoever logged it, its lead or assist,
-- or anyone working at that branch. At most 5 per entry. Files are uploaded first to payment-proofs/<branch>/<folder>/.
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
  PERFORM private.audit(l.branch_id, 'PAYMENT_PROOF_ADDED', 'service_log', p_log::text, NULL, jsonb_build_object('count', jsonb_array_length(v_photos)));
  RETURN jsonb_build_object('ok', true, 'count', (SELECT count(*) FROM public.payment_proofs WHERE service_log_id = p_log));
END $$;
REVOKE ALL ON FUNCTION public.add_payment_proof(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_payment_proof(uuid, jsonb) TO authenticated;

-- Remove a proof: whoever attached it, or owners and the GM. Returns the file names so the app can delete the files.
CREATE OR REPLACE FUNCTION public.remove_payment_proof(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); p public.payment_proofs%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.payment_proofs WHERE id = p_id AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (p.created_by = v_user OR private.is_management(v_user)) THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  DELETE FROM public.payment_proofs WHERE id = p_id;
  PERFORM private.audit(p.branch_id, 'PAYMENT_PROOF_REMOVED', 'service_log', p.service_log_id::text, jsonb_build_object('path', p.path), NULL);
  RETURN jsonb_build_object('ok', true, 'path', p.path, 'thumb', p.thumb_path);
END $$;
REVOKE ALL ON FUNCTION public.remove_payment_proof(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_payment_proof(uuid) TO authenticated;

-- The Proof of payment tab: one month, a folder per entry (client + service date), newest day first, then client A to Z.
CREATE OR REPLACE FUNCTION public.payment_proof_folders(p_month date, p_branch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
      'branch_id', l.branch_id, 'branch', b.name, 'amount_cents', l.amount_paid_cents, 'kind', l.visit_kind, 'state', l.state,
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

-- Private folder for proofs (screenshots and photos, up to 15 MB each).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('payment-proofs', 'payment-proofs', false, 15728640, ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS payment_proofs_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY payment_proofs_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'payment-proofs' AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
                  AND EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = private.current_user_id() AND g.revoked_at IS NULL
                              AND (g.branch_id IS NULL OR g.branch_id = ((storage.foldername(name))[1])::uuid)))$p$;
    EXECUTE 'DROP POLICY IF EXISTS payment_proofs_read ON storage.objects';
    EXECUTE $p$CREATE POLICY payment_proofs_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'payment-proofs' AND private.can_open_payment_proof(name))$p$;
    EXECUTE 'DROP POLICY IF EXISTS payment_proofs_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY payment_proofs_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'payment-proofs' AND (owner_id = auth.uid()::text OR private.is_management(private.current_user_id()))
             AND NOT EXISTS (SELECT 1 FROM public.payment_proofs p WHERE p.path = name OR p.thumb_path = name))$p$;
  END IF;
END $$;
