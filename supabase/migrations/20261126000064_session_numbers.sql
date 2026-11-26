-- update-0064 (CHRIS Nov 26): each service log entry has a session number, 1 by default, up to 15 for
-- package services (e.g. Gluta session 3).
-- The number reaches the new row through a setting read by the column default, so the existing
-- log_client_visit (which approves management entries right away) needs no change.
ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS session_no smallint NOT NULL
  DEFAULT coalesce(nullif(current_setting('hermosa.session_no', true), '')::smallint, 1);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_logs_session_no_check') THEN
    ALTER TABLE public.service_logs ADD CONSTRAINT service_logs_session_no_check CHECK (session_no BETWEEN 1 AND 15);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.log_client_visit(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_note text, p_kind text, p_confirm boolean,
  p_client text, p_price_note text, p_folder uuid, p_photos jsonb, p_share boolean, p_session integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb;
BEGIN
  IF p_session IS NULL OR p_session < 1 OR p_session > 15 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  PERFORM set_config('hermosa.session_no', p_session::text, true);
  r := public.log_client_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, p_note, p_kind, p_confirm,
                               p_client, p_price_note, p_folder, p_photos, p_share);
  PERFORM set_config('hermosa.session_no', '', true);
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_client_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, boolean, text, text, uuid, jsonb, boolean, integer) TO authenticated;
