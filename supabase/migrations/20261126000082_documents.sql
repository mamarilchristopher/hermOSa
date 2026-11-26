-- update-0082 (CHRIS Nov 26): Documents, a folder page for the clinic's approved forms.
--   * Each document (e.g. the Declaration and Consent Form) keeps every version: the newest is the current one,
--     older ones stay listed under "Old versions".
--   * Everyone in the app can open them as a PDF inside the app, download them and share them.
--   * Owners and the GM upload a new version (PDF) or remove one added by mistake.
--   * The forms approved so far are loaded here: the current version, the Nov 23 revamp and the original forms.
--     Those built-in files are blank client forms served with the app; new uploads go to a private folder.

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  doc_key text NOT NULL CHECK (doc_key ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  category text NOT NULL DEFAULT 'Client forms' CHECK (length(btrim(category)) BETWEEN 2 AND 60),
  version text NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 30),
  note text CHECK (note IS NULL OR length(note) <= 300),
  file_path text NOT NULL,
  file_name text NOT NULL,
  approved_on date, -- NULL = an old form from before Hermosa OS, date unknown
  created_by uuid REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid REFERENCES public.app_users(id),
  UNIQUE (organization_id, file_path)
);
CREATE INDEX IF NOT EXISTS documents_key_idx ON public.documents (organization_id, doc_key);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_read ON public.documents;
CREATE POLICY documents_read ON public.documents FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND removed_at IS NULL);
REVOKE INSERT, UPDATE, DELETE ON public.documents FROM anon, authenticated;
GRANT SELECT ON public.documents TO authenticated;

-- Add a version (owners and the GM). The PDF is uploaded first to the private "documents" folder as <doc_key>/<uuid>.pdf.
-- A new doc_key starts a new document; for an existing one the title and category stay as they are.
CREATE OR REPLACE FUNCTION public.add_document_version(p_key text, p_title text, p_category text, p_version text,
  p_note text, p_path text, p_file_name text, p_approved_on date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; v_found boolean;
  v_title text; v_cat text; v_key text := lower(btrim(coalesce(p_key, '')));
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN private.deny(NULL, 'document'); END IF;
  IF v_key !~ '^[a-z0-9][a-z0-9-]{1,59}$' OR coalesce(btrim(p_version), '') = '' OR length(btrim(p_version)) > 30
     OR coalesce(p_path, '') !~ ('^' || v_key || '/[0-9a-f-]{36}\.pdf$') OR coalesce(btrim(p_file_name), '') = ''
     OR length(coalesce(p_note, '')) > 300 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT title, category INTO v_title, v_cat FROM public.documents
  WHERE organization_id = v_org AND doc_key = v_key ORDER BY created_at DESC LIMIT 1;
  IF v_title IS NULL THEN
    v_title := btrim(coalesce(p_title, '')); v_cat := coalesce(nullif(btrim(coalesce(p_category, '')), ''), 'Client forms');
    IF length(v_title) < 2 OR length(v_title) > 120 OR length(v_cat) > 60 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  END IF;
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''documents'' AND o.name = $1)' INTO v_found USING p_path;
    IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'FILE_NOT_UPLOADED'); END IF;
  END IF;
  INSERT INTO public.documents (organization_id, doc_key, title, category, version, note, file_path, file_name, approved_on, created_by)
  VALUES (v_org, v_key, v_title, v_cat, btrim(p_version), nullif(btrim(coalesce(p_note, '')), ''), p_path, left(btrim(p_file_name), 160),
          coalesce(p_approved_on, (now() AT TIME ZONE 'Asia/Manila')::date), v_user)
  RETURNING id INTO v_id;
  PERFORM private.audit(NULL, 'DOCUMENT_VERSION_ADDED', 'document', v_id::text, NULL, jsonb_build_object('doc', v_key, 'version', btrim(p_version)));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.add_document_version(text, text, text, text, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_document_version(text, text, text, text, text, text, text, date) TO authenticated;

-- Remove a version added by mistake (owners and the GM). It disappears from the page; the record stays for the audit trail.
CREATE OR REPLACE FUNCTION public.remove_document_version(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); d public.documents%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(v_user) THEN RETURN private.deny(NULL, 'document'); END IF;
  SELECT * INTO d FROM public.documents WHERE id = p_id AND organization_id = private.current_org_id() AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  UPDATE public.documents SET removed_at = now(), removed_by = v_user WHERE id = p_id;
  PERFORM private.audit(NULL, 'DOCUMENT_VERSION_REMOVED', 'document', p_id::text, jsonb_build_object('doc', d.doc_key, 'version', d.version), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.remove_document_version(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_document_version(uuid) TO authenticated;

-- Private folder for uploaded PDFs (up to 25 MB). Everyone signed in can open a listed one; owners and the GM upload.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('documents', 'documents', false, 26214400, ARRAY['application/pdf'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS documents_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY documents_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'documents' AND private.is_management(private.current_user_id())
                  AND name ~ '^[a-z0-9][a-z0-9-]{1,59}/[0-9a-f-]{36}\.pdf$')$p$;
    EXECUTE 'DROP POLICY IF EXISTS documents_read ON storage.objects';
    EXECUTE $p$CREATE POLICY documents_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'documents' AND (private.is_management(private.current_user_id())
             OR EXISTS (SELECT 1 FROM public.documents d WHERE d.file_path = name AND d.organization_id = private.current_org_id() AND d.removed_at IS NULL)))$p$;
    EXECUTE 'DROP POLICY IF EXISTS documents_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY documents_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'documents' AND private.is_management(private.current_user_id())
             AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.file_path = name))$p$;
  END IF;
END $$;

-- The forms approved so far (files ship with the app under /forms/). Safe to run again.
INSERT INTO public.documents (organization_id, doc_key, title, category, version, note, file_path, file_name, approved_on, created_at)
SELECT o.id, v.doc_key, v.title, v.category, v.version, v.note, v.file_path, v.file_name, v.approved_on, v.created_at
FROM public.organizations o
CROSS JOIN (VALUES
  ('declaration-consent', 'Declaration and Consent Form', 'Client forms', 'Original', 'The form used before the Nov 2026 revamp.',
     'static:/forms/declaration-consent-original.pdf', 'Hermosa-Declaration-and-Waiver-Form-Original.pdf', NULL::date, '2026-11-23 00:00:01+08'::timestamptz),
  ('declaration-consent', 'Declaration and Consent Form', 'Client forms', 'Version 2', 'Revamp: clearer wording, same 2 pages, black and white print.',
     'static:/forms/declaration-consent-v2.pdf', 'Hermosa-Declaration-and-Consent-Form-v2.pdf', '2026-11-23'::date, '2026-11-23 00:00:02+08'),
  ('declaration-consent', 'Declaration and Consent Form', 'Client forms', 'Version 3', 'Adds the Service log code box (SL-YYMM-0000) on both pages.',
     'static:/forms/declaration-consent-v3.pdf', 'Hermosa-Declaration-and-Consent-Form-v3.pdf', '2026-11-26'::date, '2026-11-26 00:00:03+08'),
  ('novoform-waiver', 'Novoform Client Details and Waiver Form', 'Client forms', 'Original', 'Version 11, used before the Nov 2026 revamp.',
     'static:/forms/novoform-waiver-original.pdf', 'Hermosa-Novoform-Waiver-Original.pdf', NULL, '2026-11-23 00:00:01+08'),
  ('novoform-waiver', 'Novoform Client Details and Waiver Form', 'Client forms', 'Version 2', 'Revamp: clearer wording and the full health checklist.',
     'static:/forms/novoform-waiver-v2.pdf', 'Hermosa-Novoform-Client-Details-and-Waiver-Form-v2.pdf', '2026-11-23', '2026-11-23 00:00:02+08'),
  ('payment-confirmation', 'Client Payment Confirmation', 'Client forms', 'Original', 'The slip used before the Nov 2026 revamp.',
     'static:/forms/payment-confirmation-original.pdf', 'Hermosa-Payment-Confirmation-Original.pdf', NULL, '2026-11-23 00:00:01+08'),
  ('payment-confirmation', 'Client Payment Confirmation', 'Client forms', 'Version 2', 'Revamp: 2 slips per page, branch and payment reference no.',
     'static:/forms/payment-confirmation-v2.pdf', 'Hermosa-Client-Payment-Confirmation-v2.pdf', '2026-11-23', '2026-11-23 00:00:02+08'),
  ('stock-inside', 'Stock Inventory: Inside the Cabinet', 'Inventory', 'Original', 'The tracker used before the Nov 2026 revamp.',
     'static:/forms/stock-inside-original.pdf', 'Hermosa-Stock-Inside-the-Cabinet-Original.pdf', NULL, '2026-11-23 00:00:01+08'),
  ('stock-inside', 'Stock Inventory: Inside the Cabinet', 'Inventory', 'Version 2', 'Revamp: Counted by / Checked by rows, sizes split.',
     'static:/forms/stock-inside-v2.pdf', 'Hermosa-Stock-Inventory-Inside-the-Cabinet-v2.pdf', '2026-11-23', '2026-11-23 00:00:02+08'),
  ('stock-outside', 'Stock Inventory: Outside the Cabinet', 'Inventory', 'Original', 'The tracker used before the Nov 2026 revamp.',
     'static:/forms/stock-outside-original.pdf', 'Hermosa-Stock-Outside-the-Cabinet-Original.pdf', NULL, '2026-11-23 00:00:01+08'),
  ('stock-outside', 'Stock Inventory: Outside the Cabinet', 'Inventory', 'Version 2', 'Revamp: Counted by / Checked by rows.',
     'static:/forms/stock-outside-v2.pdf', 'Hermosa-Stock-Inventory-Outside-the-Cabinet-v2.pdf', '2026-11-23', '2026-11-23 00:00:02+08'),
  ('daily-supply', 'Daily Supply Inventory Tracker', 'Inventory', 'Original', 'The tracker used before the Nov 2026 revamp.',
     'static:/forms/daily-supply-original.pdf', 'Hermosa-Daily-Supply-Tracker-Original.pdf', NULL, '2026-11-23 00:00:01+08'),
  ('daily-supply', 'Daily Supply Inventory Tracker', 'Inventory', 'Version 2', 'Revamp: cleaner layout for daily use.',
     'static:/forms/daily-supply-v2.pdf', 'Hermosa-Daily-Supply-Inventory-Tracker-v2.pdf', '2026-11-23', '2026-11-23 00:00:02+08')
) AS v(doc_key, title, category, version, note, file_path, file_name, approved_on, created_at)
ON CONFLICT (organization_id, file_path) DO NOTHING;
