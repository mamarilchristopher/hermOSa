-- update-0065 (CHRIS Nov 26): a Late NTE explanation needs photo proof (1 to 3 photos), e.g. a photo of the heavy
-- traffic, or for "hard to book a ride" a screenshot of the ride app booking made before 10 AM.
-- Photos live in the private "nte-proofs" bucket as <nte id>/<random id>.<ext>. The employee uploads them while the
-- NTE is open; they and the people who manage their schedule (owners, the GM, their branch manager) can view them.
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS proof_paths text[];

CREATE OR REPLACE FUNCTION private.nte_proof_access(p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.late_ntes n
    WHERE p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$'
      AND n.id = substr(p_name, 1, 36)::uuid AND n.organization_id = private.current_org_id()
      AND CASE WHEN p_write THEN n.employee_id = private.my_employee_id() AND n.state = 'OPEN'
               ELSE n.employee_id = private.my_employee_id() OR private.can_schedule(n.employee_id) END)
$$;
REVOKE ALL ON FUNCTION private.nte_proof_access(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.nte_proof_access(text, boolean) TO authenticated;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('nte-proofs', 'nte-proofs', false, 15728640, ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS nte_proof_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY nte_proof_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'nte-proofs' AND private.nte_proof_access(name, true))$p$;
    EXECUTE 'DROP POLICY IF EXISTS nte_proof_read ON storage.objects';
    EXECUTE $p$CREATE POLICY nte_proof_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'nte-proofs' AND private.nte_proof_access(name, false))$p$;
  END IF;
END $$;

-- The explanation now comes with its photo proof.
CREATE OR REPLACE FUNCTION public.explain_nte(p_id uuid, p_text text, p_proof text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.late_ntes%ROWTYPE; p text; v_found boolean; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
BEGIN
  SELECT * INTO n FROM public.late_ntes WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR n.employee_id IS DISTINCT FROM private.my_employee_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF n.state <> 'OPEN' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF length(btrim(coalesce(p_text, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  IF p_proof IS NULL OR cardinality(p_proof) < 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'PROOF_REQUIRED'); END IF;
  IF cardinality(p_proof) > 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  FOREACH p IN ARRAY p_proof LOOP
    IF p IS NULL OR p !~ ('^' || p_id::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF v_storage THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''nte-proofs'' AND o.name = $1)' INTO v_found USING p;
      IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_NOT_UPLOADED'); END IF;
    END IF;
  END LOOP;
  UPDATE public.late_ntes SET state = 'EXPLAINED', explanation = left(btrim(p_text), 2000), explained_at = now(), proof_paths = p_proof WHERE id = p_id;
  PERFORM private.audit(n.branch_id, 'NTE_EXPLAINED', 'late_nte', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.explain_nte(uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.explain_nte(uuid, text, text[]) TO authenticated;

-- The old two-part version (no photo) is no longer accepted.
CREATE OR REPLACE FUNCTION public.explain_nte(p_id uuid, p_text text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('ok', false, 'error', 'PROOF_REQUIRED')
$$;

-- The list includes the proof photos (paths only; the app signs them for viewing).
CREATE OR REPLACE FUNCTION public.late_nte_list(p_month date, p_employee uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s),
  n AS (
    SELECT x.*, e.full_name, e.uid, e.position, b.name AS branch,
           x.employee_id = private.my_employee_id() AS mine,
           private.can_schedule(x.employee_id) AND x.employee_id IS DISTINCT FROM private.my_employee_id() AS can_manage
    FROM public.late_ntes x JOIN public.employees e ON e.id = x.employee_id LEFT JOIN public.branches b ON b.id = x.branch_id, m
    WHERE x.organization_id = private.current_org_id()
      AND x.work_date >= m.s AND x.work_date < (m.s + interval '1 month')::date
      AND (p_employee IS NULL OR x.employee_id = p_employee)
      AND (private.can_schedule(x.employee_id) OR x.employee_id = private.my_employee_id())
  )
  SELECT jsonb_build_object('month', (SELECT s FROM m),
    'grace', (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()),
    'ir_minutes', (SELECT ir_late_minutes FROM public.organizations WHERE id = private.current_org_id()),
    'ntes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nte_no', nte_no, 'employee_id', employee_id, 'name', full_name, 'uid', uid, 'position', position,
      'branch', branch, 'work_date', work_date, 'shift_start', to_char(shift_start, 'HH24:MI'), 'time_in', to_char(time_in AT TIME ZONE 'Asia/Manila', 'HH24:MI'),
      'late_minutes', late_minutes, 'respond_by', respond_by, 'state', state, 'explanation', explanation, 'explained_at', explained_at, 'void_reason', void_reason,
      'proof_paths', proof_paths,
      'ir_id', ir_id, 'mine', mine, 'can_manage', can_manage) ORDER BY work_date DESC, nte_no DESC) FROM n), '[]'::jsonb))
$$;
