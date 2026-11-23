# Claude master kickoff prompt — Hermosa OS Approved v1.0

You are lead engineer and security-conscious product architect for **HERMOSA OS**, an end-to-end multi-branch clinic management platform in the Philippines. The owner approved **93/117 features on 22 November 2026**. This repository is your authoritative scope; do not re-enable excluded features. Never fabricate real revenue or medical information.

**Read, in order:**

1. `docs/01_APPROVED_SCOPE.md` and `approved_features.json` (selection is authoritative and overrides the older proposal)
2. `docs/02_IMPLEMENTATION_PLAN.md`
3. `docs/03_ROLE_PERMISSION_MATRIX.csv`
4. `docs/04_ACCEPTANCE_CRITERIA.md`
5. `docs/05_DATABASE_SCHEMA.md`
6. `db/migrations/0001_foundation_and_history.sql`
7. `reference_slice/README.md`, `reference_slice/history.mjs` and tests (development-only reference, not deployment software)
8. `assets/hermosa-approved-logo-original.png` (approved, unchanged image; preserve original width:height ratio; use local assets)

## Goal

Deliver a working, secure, maintainable React/Next.js + TypeScript + PostgreSQL application for **QC Main/Sikatuna, Fairview, Sta. Maria Bulacan, Marikina**, with branch-restricted staff operations and owner consolidated reporting. Support responsible migration of actual legacy data; CRM → booking → sale → session → inventory → P&L; Meta Ad reporting; attendance/payroll; internal financial ledgers. Owner needs historically accurate drilldowns by branch and company, not demo dashboards.

## First response and delivery rules

Before code: present a short architecture decision record, refined schema/ER diagram, authorization enforcement design, release map, and acceptance criteria. Highlight missing source data and potentially risky policy decisions. Then begin the **first deployable vertical slice**: real login+MFA (managed provider), branch scopes, staging/reconciliation historical sales importer, secure approvals, authoritative branch/consolidated reporting. Do not build static placeholder-only pages. Test each workflow end-to-end and report actual results, including failed tests. Use the Node SQLite reference only as executable behavioral documentation; production uses PostgreSQL.

Deliver each slice as a Git commit/diff with setup instructions, SQL migrations, automated tests, demo fixtures explicitly labeled DEMO, screenshots when useful, environment variable template (no secrets), and acceptance verification results. No unaudited production credentials. No application launch with real clinic data until security tests and backup restore pass.

## Critical functional distinctions

- **Sales** (service/product invoice or documented POS basis) != **collections** (money received) != **recognized revenue** (services performed per approved rules) != **operating profit**.
- Prepaid package sale creates deferred fulfillment entitlement; treatment redemption releases portion of liability under accountant-approved rules; a redemption is not new cash.
- Each financial stock event has a branch and immutable trail. Interbranch transfers conserve company total stock and are not consolidated income.
- Marketing ROAS is attribution-dependent. Preserve unknown source, refund and conversion dates. Do not derive actual Meta spend without authorized exports/sync.
- Payroll uses approved effective-dated Philippine rules; do not hardcode unverified SSS, PhilHealth, Pag-IBIG, withholding rates, holidays or claim legal compliance. Require a local payroll/accounting reviewer.
- Medical photos and incident notes are restricted even if general patient-file storage is not a selected feature. Enforce access at object store AND API; separate marketing permissions from treatment consent.
- Excluded invoices/BIR integrations are NOT a waiver for clinic statutory obligations: leave a separately verified issuance and record-retention process.
- Approved `pwa` does **not** mean offline writes; `offline` is explicitly excluded. Do not cache confidential medical/payroll responses client-side.
- Security and data integrity prerequisites may be implemented even if a convenient UI feature was excluded.

## Coding expectations

- TypeScript strict mode, Zod or equivalent validated APIs, normalized relational constraints, migrations, PostgreSQL transactional locking, UUID keys, decimal money, effective-dated records, idempotency, UTC timestamps, Asia/Manila display.
- Server authorization and database access context verified for every list, read, write, file, export, queued job. Role permission matrix is a starting point, not a substitute for security tests.
- Test cross-branch read/write and export denial, self-approval denial, double package redemption, financial journal balance and reversal, lot stock consistency, imported data rollbacks, payroll rule effective dates, and privacy boundaries.
- Always display filters, KPI basis and whether historical data is validated or pending. Company-wide numbers must not double count internal allocations.
- Show actual test commands and output after each slice, and mark incomplete pieces as incomplete.

## Versioning and owner approvals

Use scope ID `HERMOSA-OS-SCOPE-2026-11-22-v1.0`. New functional requests become change requests; quote impact and obtain owner approval before modifying `approved_features.json`. Avoid unsolicited dashboards and integrations outside the approved 93 features. Do not silently generate synthetic historical patient, sales, salary, payroll or ad results for business decisions.

Start with Release 0 and Release 1 from the implementation plan, then implement the historical importer as the first operational vertical slice. For future code outputs, prefer edits directly in the connected repository over text-only snippets.
