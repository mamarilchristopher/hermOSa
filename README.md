# Hermosa OS

Internal operations system for Hermosa Aesthetics (Quezon City Main, Fairview, Marikina, Sta. Maria Bulacan).

**Scope:** `HERMOSA-OS-SCOPE-2026-11-22-v1.0`, 93 of 117 features approved by the owner on 22 November 2026.
The approved scope, plan, role matrix, acceptance criteria and schema are in [`docs/scope/`](docs/scope/).
New features need an owner-approved change request before `docs/scope/approved_features.json` changes.

**Status:** not live. Release 1 (secure foundation) and the historical sales importer are in development.
Nothing here is reviewed for Philippine payroll, BIR or medical-records compliance yet.

## What works now

| Area | Feature IDs | Where |
|---|---|---|
| Branches, users, roles per branch | `branch`, `roles` | `supabase/migrations/…0001`, `/admin/users` |
| Login with MFA for owner, finance, HR | `auth` | `/login`, `/mfa` |
| Branch data boundaries enforced in the database | `rowpolicy` | RLS policies + API functions in `…0002` |
| Append-only audit log, no deletes of posted rows | `audit`, `nodel` | triggers in `…0001` |
| Two-person sign-off, period locks | `approvals`, `periodlock` | `publish_historical_batch` |
| Historical sales CSV import: stage, validate, reconcile, publish, reverse | `import`, `quality`, `reconcile`, `lineage` | `/imports` |
| Branch and company historical sales dashboard | `owner`, `branchdash` (partial) | `/` |

## Stack

Next.js 15 (App Router, TypeScript strict) on Vercel, Supabase (PostgreSQL 15+, Auth, Storage) in Singapore.
See [`docs/adr/`](docs/adr/README.md) for the decisions.

## Run the tests

Needs Node 22.13+ and a local PostgreSQL 16 you can connect to as a superuser (tests create and drop throwaway databases).

```sh
npm ci
export TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres
npm test            # unit + database security tests
npm run typecheck
```

`tests/db/supabase-shim.sql` imitates the few Supabase pieces the migrations use (`auth.uid()`, `auth.jwt()`, the `authenticated` role) so RLS can be tested on plain PostgreSQL. It is never applied to Supabase.

## Set up Supabase and Vercel (first time)

1. Create a Supabase project in the **Singapore** region. Turn on Point-in-Time Recovery when on a paid plan.
2. Authentication > Sign In / Providers: keep Email on, **turn off "Allow new users to sign up"**. Authentication > Multi-Factor: enable TOTP.
3. Apply the migrations in `supabase/migrations/` in order, then `supabase/seed.sql` (SQL editor, or `supabase db push`).
4. Authentication > Users > Invite user for the first owner. Then in the SQL editor give them the owner role once:
   ```sql
   insert into public.role_grants (user_id, role_code)
   select id, 'OWNER' from public.app_users where email = 'owner@example.com';
   ```
   After that, roles are managed in the app at `/admin/users`.
5. Create a Vercel project from this repo with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from Supabase > Project Settings > API). Never add the service role key to Vercel.

## Data rules

- Test with DEMO or sanitized files only. Do not put real patient or employee records in chats, issues or test fixtures.
- Dashboards show "No validated data" until a branch's import is signed off; nothing is estimated or made up.
- Official receipts and BIR invoicing stay in the clinic's current registered process (excluded from scope).
