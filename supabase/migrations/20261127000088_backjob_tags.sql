-- Hermosa OS update-0088: backjob tracking per client and per staff. Safe to run again.
-- SQL Editor: https://supabase.com/dashboard/project/bnopatuopnenbdhrecdt/sql/new
-- update-0088 (CHRIS Nov 27): "backjob tagging and tracking for customers and for staff that handled them would be
-- helpful as backjobs and recurring issues are sometimes common and some staff get it more often than others."
-- Every Backjob entry gets a tag: the original treatment it fixes (found automatically: the client's latest paid entry
-- of the same service), the staff who did that treatment, and what needed fixing. Owners and the GM see the totals
-- per staff, per client and per service on Clinic › Backjobs, and can change any tag. Old backjobs are tagged too.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'tag_backjob') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

CREATE TABLE IF NOT EXISTS public.backjob_tags (
  service_log_id uuid PRIMARY KEY REFERENCES public.service_logs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  original_log_id uuid REFERENCES public.service_logs(id) ON DELETE SET NULL,
  staff_id uuid REFERENCES public.employees(id),
  reason text CHECK (reason IS NULL OR reason IN ('UNEVEN','THREAD','SWELLING','REACTION','FADED','NOT_SATISFIED','OTHER')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  tagged_by uuid REFERENCES public.app_users(id),
  tagged_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backjob_tags_staff_idx ON public.backjob_tags (organization_id, staff_id);
ALTER TABLE public.backjob_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backjob_tags_read ON public.backjob_tags;
CREATE POLICY backjob_tags_read ON public.backjob_tags FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.is_management(private.current_user_id()));
REVOKE INSERT, UPDATE, DELETE ON public.backjob_tags FROM anon, authenticated;
GRANT SELECT ON public.backjob_tags TO authenticated;

-- The client's treatment a backjob fixes: their latest paid entry of the same service on or before the backjob
-- (any service when there is none). Same client = same name, ignoring case and extra spaces.
CREATE OR REPLACE FUNCTION private.backjob_original(p_log uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id FROM public.service_logs b JOIN public.service_logs o
    ON o.organization_id = b.organization_id AND o.id <> b.id AND o.state <> 'REJECTED' AND coalesce(o.visit_kind, 'PAID') = 'PAID'
   AND lower(regexp_replace(btrim(o.client_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(b.client_name), '\s+', ' ', 'g'))
   AND o.service_date <= b.service_date
  WHERE b.id = p_log AND coalesce(btrim(b.client_name), '') <> ''
  ORDER BY (o.service_id = b.service_id) DESC, o.service_date DESC, o.created_at DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION private.backjob_original(uuid) FROM PUBLIC, anon, authenticated;

-- Tag (or re-tag) a backjob. p_staff / p_original NULL = found automatically. Who: owners and the GM any time, or
-- whoever logged it while it still waits for sign-off.
CREATE OR REPLACE FUNCTION public.tag_backjob(p_log uuid, p_staff uuid, p_reason text, p_note text, p_original uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs; v_orig uuid; v_staff uuid; v_reason text := nullif(upper(btrim(coalesce(p_reason, ''))), '');
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF coalesce(l.visit_kind, 'PAID') <> 'BACKJOB' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_BACKJOB'); END IF;
  IF NOT (private.is_management(v_user) OR (l.created_by = v_user AND l.state = 'PENDING')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED');
  END IF;
  IF v_reason IS NOT NULL AND v_reason NOT IN ('UNEVEN','THREAD','SWELLING','REACTION','FADED','NOT_SATISFIED','OTHER') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REASON');
  END IF;
  IF p_original IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_logs o WHERE o.id = p_original AND o.organization_id = l.organization_id AND o.id <> l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF p_staff IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = p_staff AND e.organization_id = l.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  v_orig := coalesce(p_original, private.backjob_original(l.id));
  v_staff := coalesce(p_staff, (SELECT o.performer_id FROM public.service_logs o WHERE o.id = v_orig));
  INSERT INTO public.backjob_tags (service_log_id, organization_id, original_log_id, staff_id, reason, note, tagged_by, tagged_at)
  VALUES (l.id, l.organization_id, v_orig, v_staff, v_reason, nullif(btrim(coalesce(p_note, '')), ''), v_user, now())
  ON CONFLICT (service_log_id) DO UPDATE SET original_log_id = EXCLUDED.original_log_id, staff_id = EXCLUDED.staff_id,
    reason = EXCLUDED.reason, note = EXCLUDED.note, tagged_by = EXCLUDED.tagged_by, tagged_at = now();
  RETURN jsonb_build_object('ok', true, 'id', l.id, 'original', v_orig, 'staff', v_staff);
END $$;
REVOKE ALL ON FUNCTION public.tag_backjob(uuid, uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tag_backjob(uuid, uuid, text, text, uuid) TO authenticated;

-- Backjobs logged before this update: link them the same way (no reason yet).
INSERT INTO public.backjob_tags (service_log_id, organization_id, original_log_id, staff_id)
SELECT b.id, b.organization_id, x.orig, (SELECT o.performer_id FROM public.service_logs o WHERE o.id = x.orig)
FROM public.service_logs b CROSS JOIN LATERAL (SELECT private.backjob_original(b.id) AS orig) x
WHERE coalesce(b.visit_kind, 'PAID') = 'BACKJOB' AND b.state <> 'REJECTED'
ON CONFLICT (service_log_id) DO NOTHING;
