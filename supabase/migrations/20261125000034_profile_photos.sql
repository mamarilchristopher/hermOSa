-- update-0034: profile pictures (CHRIS, Nov 25 2026). Safe to run more than once.
-- * Every staff member uploads their own photo (square JPEG) from Home. It waits for approval.
-- * Owners and the General Manager approve or send it back with a note (the GM's own photo needs an owner).
-- * The approved photo shows across Hermosa OS. Photos live in a private storage folder, readable only when signed in.

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS photo_path text;

CREATE TABLE IF NOT EXISTS public.profile_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  path text NOT NULL CHECK (path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','RETURNED','SUPERSEDED')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_photos_one_pending ON public.profile_photos (user_id) WHERE state = 'PENDING';
ALTER TABLE public.profile_photos ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.profile_photos TO authenticated;
DROP POLICY IF EXISTS profile_photos_read ON public.profile_photos;
CREATE POLICY profile_photos_read ON public.profile_photos FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (user_id = private.current_user_id() OR private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()));

-- Staff send their photo (already uploaded to profile-photos/<their user id>/...). Replaces one still waiting.
CREATE OR REPLACE FUNCTION public.submit_profile_photo(p_path text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; v_name text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_path IS NULL OR p_path !~ ('^' || v_user::text || '/[0-9a-f-]{36}\.jpg$') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  UPDATE public.profile_photos SET state = 'SUPERSEDED' WHERE user_id = v_user AND state = 'PENDING';
  INSERT INTO public.profile_photos (organization_id, user_id, path) VALUES (v_org, v_user, p_path) RETURNING id INTO v_id;
  SELECT display_name INTO v_name FROM public.app_users WHERE id = v_user;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT v_org, g.user_id, 'PHOTO_SUBMITTED', 'Profile picture to approve',
    left(coalesce(v_name, 'Someone') || ' sent a profile picture for approval.', 1000), '/admin/photos', v_user
  FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id AND u.active
  WHERE g.revoked_at IS NULL AND u.organization_id = v_org AND g.user_id <> v_user
    AND (g.role_code = 'OWNER' OR (g.role_code = 'MANAGER' AND g.branch_id IS NULL));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- Owners and the GM approve (it becomes the person's picture) or send it back with a note.
CREATE OR REPLACE FUNCTION public.decide_profile_photo(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.profile_photos%ROWTYPE; v_me uuid := private.current_user_id(); v_owner boolean;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO r FROM public.profile_photos WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  v_owner := private.has_role(ARRAY['OWNER'], NULL);
  IF NOT (v_owner OR private.is_gm()) THEN RETURN private.deny(NULL, 'profile_photo'); END IF;
  IF r.user_id = v_me AND NOT v_owner THEN RETURN private.deny(NULL, 'profile_photo', 'SELF_APPROVAL_DENIED'); END IF;
  IF r.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF coalesce(p_approve, false) THEN
    UPDATE public.profile_photos SET state = 'APPROVED', decided_by = v_me, decided_at = now() WHERE id = p_id;
    UPDATE public.app_users SET photo_path = r.path WHERE id = r.user_id;
    IF r.user_id <> v_me THEN
      INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
      VALUES (r.organization_id, r.user_id, 'PHOTO_APPROVED', 'Your profile picture was approved', 'It now shows on your account in Hermosa OS.', '/me/photo', v_me);
    END IF;
  ELSE
    IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
    UPDATE public.profile_photos SET state = 'RETURNED', note = left(btrim(p_note), 300), decided_by = v_me, decided_at = now() WHERE id = p_id;
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    VALUES (r.organization_id, r.user_id, 'PHOTO_RETURNED', 'Your profile picture was sent back', left('Please upload another one: ' || btrim(p_note), 1000), '/me/photo', v_me);
  END IF;
  PERFORM private.audit(NULL, CASE WHEN p_approve THEN 'PHOTO_APPROVED' ELSE 'PHOTO_RETURNED' END, 'profile_photo', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.submit_profile_photo(text), public.decide_profile_photo(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_profile_photo(text), public.decide_profile_photo(uuid, boolean, text) TO authenticated;

-- Private photo folder. Each person uploads only into their own folder; anyone signed in can see photos.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('profile-photos', 'profile-photos', false, 1048576, ARRAY['image/jpeg'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS profile_photos_insert_own ON storage.objects';
    EXECUTE $p$CREATE POLICY profile_photos_insert_own ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'profile-photos' AND (storage.foldername(name))[1] = private.current_user_id()::text)$p$;
    EXECUTE 'DROP POLICY IF EXISTS profile_photos_read ON storage.objects';
    EXECUTE $p$CREATE POLICY profile_photos_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'profile-photos' AND private.current_user_id() IS NOT NULL)$p$;
  END IF;
END $$;
