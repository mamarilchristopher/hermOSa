-- HERMOSA OS 0005: discard a staged (never published) import, e.g. when the expected totals
-- were typed wrong. The batch and its rows are kept for the audit trail; its file hash is freed
-- so the corrected upload can be staged again.
CREATE FUNCTION public.cancel_staged_batch(p_batch uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  b public.import_batches%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'BATCH_NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER'], b.branch_id) THEN
    RETURN private.deny(b.branch_id, 'import_batch.cancel');
  END IF;
  IF b.state <> 'STAGED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_STAGED'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 8 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.import_batches
  SET state = 'REVERSED', reversed_by = v_user, reversed_at = now(), reversal_reason = 'Discarded before sign-off: ' || btrim(p_reason)
  WHERE id = p_batch;
  PERFORM private.audit(b.branch_id, 'IMPORT_DISCARDED', 'import_batch', p_batch::text,
    jsonb_build_object('state', 'STAGED'), jsonb_build_object('state', 'REVERSED', 'reason', btrim(p_reason)));
  RETURN jsonb_build_object('ok', true, 'id', p_batch, 'state', 'REVERSED');
END $$;
REVOKE ALL ON FUNCTION public.cancel_staged_batch(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_staged_batch(uuid, text) TO authenticated;
