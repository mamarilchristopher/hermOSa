# Architecture decision records

Accepted 2026-11-23 for scope `HERMOSA-OS-SCOPE-2026-11-22-v1.0`.

| # | Decision | Why |
|---|---|---|
| ADR-1 | Next.js App Router + TypeScript strict; inputs validated with Zod on the server | Required by the build pack; one codebase for desktop, tablet and phone |
| ADR-2 | PostgreSQL (Supabase) with row-level security on every table; signed-in users get SELECT only; every write goes through a `SECURITY DEFINER` function that re-checks role, branch, MFA and segregation of duties | A bug in page code cannot leak another branch's rows or skip an approval |
| ADR-3 | Supabase Auth; OWNER, FINANCE and HR grants only count in an MFA (aal2) session | Pack forbids home-made login; privileged actions need step-up auth |
| ADR-4 | Supabase Storage private buckets with short-lived signed URLs for receipts and clinical photos (from Release 4) | Consent-linked, logged access to sensitive files |
| ADR-5 | Money as integer centavos (`bigint`); quantities `numeric(18,4)` | No float rounding in ledgers |
| ADR-6 | Instants stored UTC; business dates and cut-offs in Asia/Manila | All branches report on Manila days |
| ADR-7 | Posted money and stock records are never edited or deleted; corrections are reversals | Audit trail and period locks |
| ADR-8 | Audit events are written in the same transaction as the change, and the table is append-only (trigger) | Audit cannot be skipped or rewritten |
| ADR-9 | Historical data: stage, validate, reconcile against branch totals, second-person sign-off, publish | Ported from the pack's tested reference importer |
| ADR-10 | Hosting: Vercel for the web app, Supabase in the Singapore region | Lowest latency to Manila |
| ADR-11 | API functions return `{ok:false,error}` instead of raising on denial | So the denial's audit event is committed, not rolled back |

## Security notes

- The web app never holds the `service_role` key. Staff accounts are created in the Supabase dashboard; a trigger gives each login an account with no roles.
- Public sign-up must be disabled in Supabase.
- New tables get no grants by default (`ALTER DEFAULT PRIVILEGES`); each migration must opt in, and `tests/db/access.test.ts` fails if any public table lacks RLS or grants writes to signed-in users.
- Pages send `Cache-Control: no-store`; nothing sensitive is cached in the browser.
