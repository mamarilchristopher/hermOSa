-- HERMOSA OS 0001: foundation, access and historical sales staging.
-- Adapted from build pack v1.0 db/migrations/0001_foundation_and_history.sql
-- Changes vs the pack: app_users link to Supabase auth.users, approval_requests added,
-- reversal metadata on import_batches, audit_events made append-only.
-- Scope: HERMOSA-OS-SCOPE-2026-11-22-v1.0 (branch, roles, approvals, periodlock, audit, nodel, import, lineage, reconcile).

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'PHP',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CLINIC','HQ')),
  timezone text NOT NULL DEFAULT 'Asia/Manila',
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code)
);

CREATE TABLE public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  auth_subject uuid UNIQUE NOT NULL,           -- auth.users.id
  display_name text NOT NULL,
  email text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.role_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  role_code text NOT NULL CHECK (role_code IN ('OWNER','FINANCE','MANAGER','CASHIER','HR','MARKETING','CLINICIAN','INVENTORY','AUDITOR')),
  branch_id uuid REFERENCES public.branches(id),  -- NULL = every branch of the organization
  granted_by uuid REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.app_users(id)
);
CREATE UNIQUE INDEX role_grants_unique_active
  ON public.role_grants (user_id, role_code, COALESCE(branch_id::text, ''))
  WHERE revoked_at IS NULL;

CREATE TABLE public.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid REFERENCES public.branches(id),
  target_type text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL,
  initiator_id uuid NOT NULL REFERENCES public.app_users(id),
  approver_id uuid REFERENCES public.app_users(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT approval_not_self CHECK (approver_id IS NULL OR approver_id <> initiator_id)
);

CREATE TABLE public.period_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  domain text NOT NULL CHECK (domain IN ('FINANCE','PAYROLL','IMPORT')),
  start_on date NOT NULL,
  end_on date NOT NULL CHECK (end_on >= start_on),
  locked_by uuid NOT NULL REFERENCES public.app_users(id),
  locked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid REFERENCES public.branches(id),
  actor_id uuid REFERENCES public.app_users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  prior_value jsonb,
  next_value jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_branch_time ON public.audit_events (branch_id, occurred_at DESC);

CREATE TABLE public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  import_kind text NOT NULL CHECK (import_kind IN ('HISTORICAL_SALES','HISTORICAL_COLLECTIONS','OPENING_BALANCE')),
  source_system text NOT NULL DEFAULT 'LEGACY',
  source_filename text NOT NULL,
  source_sha256 char(64) NOT NULL,
  mapping jsonb NOT NULL,
  mapping_version integer NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  state text NOT NULL DEFAULT 'STAGED' CHECK (state IN ('STAGED','VALIDATED','RECONCILED','PUBLISHED','REVERSED')),
  source_row_count integer NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  expected_row_count integer NOT NULL CHECK (expected_row_count >= 0),
  expected_gross_cents bigint NOT NULL CHECK (expected_gross_cents >= 0),
  actual_gross_cents bigint,
  expected_collections_cents bigint,
  actual_collections_cents bigint,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES public.app_users(id),
  approved_at timestamptz,
  reversed_by uuid REFERENCES public.app_users(id),
  reversed_at timestamptz,
  reversal_reason text,
  CONSTRAINT import_not_self_approved CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE UNIQUE INDEX import_batch_active_hash
  ON public.import_batches (organization_id, branch_id, import_kind, source_sha256)
  WHERE state <> 'REVERSED';
CREATE INDEX import_batch_branch_state ON public.import_batches (branch_id, state, created_at DESC);

CREATE TABLE public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id),
  row_number integer NOT NULL CHECK (row_number >= 1),
  source_key text,
  posting_date date,
  gross_cents bigint,
  source_payload jsonb NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'STAGED' CHECK (state IN ('STAGED','VALID','INVALID','PUBLISHED')),
  UNIQUE (batch_id, row_number)
);

CREATE TABLE public.historical_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id),
  raw_row_id uuid NOT NULL UNIQUE REFERENCES public.import_rows(id),
  source_system text NOT NULL,
  source_key text NOT NULL,
  posting_date date NOT NULL,
  gross_cents bigint NOT NULL CHECK (gross_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);
CREATE UNIQUE INDEX unique_active_historical_source
  ON public.historical_sales (organization_id, source_system, branch_id, source_key)
  WHERE reversed_at IS NULL;
CREATE INDEX historical_sales_branch_date ON public.historical_sales (branch_id, posting_date);

CREATE TABLE public.import_signoffs (
  batch_id uuid PRIMARY KEY REFERENCES public.import_batches(id),
  reviewer_id uuid NOT NULL REFERENCES public.app_users(id),
  expected_row_count integer NOT NULL CHECK (expected_row_count >= 0),
  actual_row_count integer NOT NULL CHECK (actual_row_count >= 0),
  expected_gross_cents bigint NOT NULL,
  actual_gross_cents bigint NOT NULL,
  source_sha256 char(64) NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expected_row_count = actual_row_count),
  CHECK (expected_gross_cents = actual_gross_cents)
);

-- Audit log is append-only for everyone, including table owners acting through functions.
CREATE FUNCTION public.forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_audit_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_audit_mutation();

-- Posted historical rows are never deleted; only reversed_at may be set once.
CREATE FUNCTION public.guard_historical_sales() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POSTED_ROWS_ARE_NOT_DELETED' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.reversed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'reversed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_at') THEN
    RAISE EXCEPTION 'POSTED_ROWS_ARE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_sales_guard
  BEFORE UPDATE OR DELETE ON public.historical_sales
  FOR EACH ROW EXECUTE FUNCTION public.guard_historical_sales();
