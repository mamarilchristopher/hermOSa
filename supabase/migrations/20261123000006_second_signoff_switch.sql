-- HERMOSA OS 0006: pre-launch switch for the second-person import sign-off.
-- organizations.require_second_signoff = true (default, the build pack rule): the uploader can never publish.
-- = false (owner's pre-launch choice, 2026-11-23): an MFA-verified OWNER may publish their own upload.
-- Self-approvals are still audited with self_approved = true. TURN BACK ON BEFORE LAUNCH:
--   update public.organizations set require_second_signoff = true;

ALTER TABLE public.organizations ADD COLUMN require_second_signoff boolean NOT NULL DEFAULT true;
-- The table-level rule moves into the publish function so the switch can relax it.
ALTER TABLE public.import_batches DROP CONSTRAINT import_not_self_approved;

CREATE OR REPLACE FUNCTION public.publish_historical_batch(
  p_batch uuid, p_expected_rows integer, p_expected_gross_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  b public.import_batches%ROWTYPE;
  v_rows integer; v_invalid integer; v_cents bigint;
  v_self boolean; v_four_eyes boolean := true;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'BATCH_NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE'], b.branch_id) THEN
    RETURN private.deny(b.branch_id, 'import_batch.publish',
      CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  v_self := b.created_by = v_user;
  IF v_self THEN
    SELECT require_second_signoff INTO v_four_eyes FROM public.organizations WHERE id = b.organization_id;
    -- Pre-launch exception: with the switch off, an MFA-verified OWNER may publish their own upload.
    IF v_four_eyes OR NOT private.has_role(ARRAY['OWNER'], b.branch_id) THEN
      RETURN private.deny(b.branch_id, 'import_batch.publish', 'SELF_APPROVAL_DENIED');
    END IF;
  END IF;
  IF b.state <> 'STAGED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_STAGED'); END IF;

  SELECT count(*), count(*) FILTER (WHERE state = 'INVALID'), coalesce(sum(gross_cents), 0)
  INTO v_rows, v_invalid, v_cents
  FROM public.import_rows WHERE batch_id = p_batch;

  IF v_invalid > 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_ROWS', 'invalid_rows', v_invalid); END IF;
  IF v_rows <> b.expected_row_count OR v_cents <> b.expected_gross_cents
     OR p_expected_rows IS DISTINCT FROM b.expected_row_count
     OR p_expected_gross_cents IS DISTINCT FROM b.expected_gross_cents THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RECONCILIATION_FAILED',
      'actual_rows', v_rows, 'actual_gross_cents', v_cents);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.period_locks l JOIN public.import_rows r ON r.batch_id = p_batch
    WHERE l.branch_id = b.branch_id AND l.domain = 'IMPORT' AND r.posting_date BETWEEN l.start_on AND l.end_on) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PERIOD_LOCKED');
  END IF;

  BEGIN
    INSERT INTO public.historical_sales (organization_id, branch_id, batch_id, raw_row_id, source_system, source_key, posting_date, gross_cents)
    SELECT b.organization_id, b.branch_id, b.id, r.id, b.source_system, r.source_key, r.posting_date, r.gross_cents
    FROM public.import_rows r WHERE r.batch_id = p_batch;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_SOURCE_ACTIVE');
  END;

  UPDATE public.import_rows SET state = 'PUBLISHED' WHERE batch_id = p_batch;
  INSERT INTO public.import_signoffs (batch_id, reviewer_id, expected_row_count, actual_row_count,
    expected_gross_cents, actual_gross_cents, source_sha256)
  VALUES (p_batch, v_user, b.expected_row_count, v_rows, b.expected_gross_cents, v_cents, b.source_sha256);
  UPDATE public.import_batches
  SET state = 'PUBLISHED', approved_by = v_user, approved_at = now(), actual_gross_cents = v_cents
  WHERE id = p_batch;

  PERFORM private.audit(b.branch_id, 'IMPORT_PUBLISHED', 'import_batch', p_batch::text,
    jsonb_build_object('state', 'STAGED'),
    jsonb_build_object('state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents,
                       'self_approved', v_self, 'second_signoff_required', v_four_eyes));
  RETURN jsonb_build_object('ok', true, 'id', p_batch, 'state', 'PUBLISHED', 'rows', v_rows, 'gross_cents', v_cents);
END $$;

