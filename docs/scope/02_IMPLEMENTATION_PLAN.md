# HERMOSA OS — Implementation Sequence & Release Gates v1.0

**Owner-approved selection:** 93 features. Build in controlled vertical slices, not one large code generation. Priorities below specify implementation order, not new scope selections.

## Architecture decisions (must be recorded as ADRs before development)

- **Application:** React / Next.js (App Router) with TypeScript, accessible responsive UI and server-side validation. Favor boring, supported libraries rather than proprietary Claude-specific infrastructure.
- **Production database:** PostgreSQL with transactions, foreign keys, unique keys and row-level security (RLS) where applicable; all access through verified server-side authorization, not browser-side branch filters. Recommended ORM: Prisma or Drizzle, with reviewed SQL migrations for complex invariants.
- **Auth:** managed OIDC/session provider that supports admin MFA; all users require a verified account. Never ship demo header authentication or shared admin credentials to production.
- **Files:** encrypted private object storage; signed short-lived access, malware and type checks, consent-linked photos. Local logo stays in the application asset bundle.
- **Numbers:** monetary accounting in PHP centavos (`BIGINT`) or `NUMERIC(18,2)`; no float accounting. Inventory quantities `NUMERIC(18,4)`. Store timestamps UTC and branch-local timezone for business dates and cutoffs.
- **Security:** user/role and branch scopes; deny-by-default; privileged actions need approval/step-up auth, full audit, idempotency and transaction locking. Backups with observed restore tests. Restrict log data and all audit exports.
- **Data quality:** historical rows stage before posting. Define a reporting *basis* (service date, invoice date, payment date, posting date); expose completeness and reconciliation state.
- **Posting model:** balanced general-ledger journal entries plus subsidiary operational ledgers, explicitly journaled reversals. Only accountant-approved recognition rules go live.

## Delivery plan & traceability

| Release / vertical slice | Actual user outcome | Data and quality gate | Selected IDs implemented |
|---|---|---|---|
| 0 — Audit & governance | Data source inventory, role matrix, privacy assessment, signed accounting definitions and 4-branch entity registry | Historical test month per branch supplied, expected source totals defined; PH compliance reviewers identified | `branch`, `roles`, `privacy` (design) |
| 1 — Secure foundation | Secure roles, branch scope, company master data, audit, approvals, backups, migration pipeline | Branch 1 cannot see Branch 2 through API/DB; admin MFA; restore test; signed schema migration | `branch`, `roles`, `master`, `approvals`, `periodlock`, `auth`, `rowpolicy`, `audit`, `nodel`, `backup`, `monitor`, `schema`, `test` |
| 2 — Historical imports & diagnostic dashboards | Upload CSV/XLSX, stage, validate, deduplicate, reconcile, approve and publish actual history; owner drilldowns | 4 signed-off months (at least one per branch), source-vs-import deltas zero or explicitly explained; duplicate replay unchanged | `import`, `mapper`, `quality`, `opening`, `reconcile`, `lineage`, `owner`, `branchdash`, `historicaltrend`, `reportexport` |
| 3 — CRM → appointments → sale → collections | Trace inquiry, patient and appointment through sale and partial payments; cashier closure | No cross-branch leaks; sales != receipts; no unapproved edits; register balances | `patient`, `leadsource`, `consent`, `followup`, `calendar`, `walkin`, `bookingfunnel`, `sale`, `payments`, `discounts`, `refunds`, `cashclose` |
| 4 — Packages, treatments & clinical controls | Sell 5+1/10+3 packages, redeem one session once, track consent, followups, incidents | No double redemption or double revenue; photo permission respected; negative balances disallowed | `packages`, `sessions`, `protocol`, `photos`, `followclinical`, `adverse` |
| 5 — Purchasing, stock & supplier bills | PO → receipt/lot → stock → consumption/transfer → payable, recorded in cost | Batch-by-branch stock equation; no expired lot redemption; interbranch transfers match | `sku`, `stock`, `batch`, `bom`, `count`, `movement`, `reorder`, `waste`, `vendor`, `po`, `receiving`, `vendorbill`, `materials` |
| 6 — Finance & profitability | Branch spending, expense allocation, bank reconciliation, payroll accrual hooks and balanced books; P&L | Journals balance; HQ allocations/transfer eliminations; branch-to-company consistency | `expense`, `categories`, `petty`, `recurring`, `bank`, `allocation`, `accrual`, `ledger`, `serviceprofit`, `profit` |
| 7 — Workforce, attendance & payroll | Attendance approval → computed wages → authorized payroll → salary + statutory deductions → restricted payslip | Official rates effective-dated and reviewed by PH payroll professional; totals reconcile to journal; no employee can read another payslip | `employee`, `shift`, `time`, `exceptions`, `leave`, `paybasis`, `paycompute`, `holidays`, `deductions`, `incentives`, `thirteenth`, `payslips`, `payadvance`, `salescomm` |
| 8 — Marketing analytics | Import Meta CSV, trace lead-to-service, attributable revenue and campaign performance | Unattributed leads explicitly counted; no source of revenue double counted; CAC/ROAS definitions reviewed | `adspend`, `metacsv`, `lead`, `attribution`, `kpis`, `campaign`, `alertsads`, `funnelreport` |
| 9 — Integrations and release polish | Limited-permission Meta API sync, installable PWA, roll out by branch | API permissions and rate limits tested; no caching PII; staged/UAT branch signoff | `metaapi`, `pwa`, `responsive`, `uat`, `migration`, `documentation` |

Release implementation order is flexible where dependencies require earlier shared primitives, but **no release may claim production readiness without all its gates**. Every commit should include schema migration, automated test evidence and a human-readable change summary.

## Initial reference slice shipped in this pack

`reference_slice` contains a runnable *development-only*, database-backed historical sales import and reconciliation reference. It uses built-in Node SQLite to avoid npm installs for testing. It is intentionally a narrow **business-logic reference**, not the deployed Next.js/PostgreSQL application and not a substitute for production authentication, MFA, approval UI, RLS or backups. Claude should port its tested behavior to PostgreSQL and wrap it in secure application flows.

## Mandatory preimplementation inputs

- One representative real historical sales + collections month **for each branch**, sanitized for developer review, with known branch totals and source report definitions.
- Patient identifier and duplicate matching rules, consent wording/version owner, and clinical privacy controls.
- Services, 5+1/10+3 package terms, session and refund/expiration policy, per-session materials and actual commission rules.
- Opening stock by branch, units, batch and expiry, supplier price lists and AP beginning balances.
- Cost center/HQ allocation method, chart-of-accounts mapping, tax invoice issuance workflow, accountant-approved revenue recognition.
- Employee compensation agreements, branch attribution, payroll cutoffs, SSS/PhilHealth/Pag-IBIG/BIR tables and labor-law review.
- Meta Ads account structure, exported spend by branch/campaign/day, lead-source tagging rules, attribution window and mapping.

Missing data is a blocker for **valid results**, not an excuse to synthesize real revenue.

## Core operational invariants

1. **External versus internal:** consolidated revenue counts external patient sales only; internal stock movement has no sales revenue.
2. **Accrual versus collections:** cash receipts post to cash/bank; package prepayments initially credit deferred income until service delivery, per approved policy.
3. **Posting correction:** finalized finance records reverse with new events; originally posted events remain auditable.
4. **All branch transactions:** record site branch and, separately if needed, cost-center branch. Global patients carry no one-branch confinement but access remains least privilege.
5. **Historical data:** source rows, mapping version, hash, staged status, reconciliation sheet and explicit signoff remain traceable.
6. **Statutory changes:** effective-dated reference tables; payroll can only finalize on a validated published rule version.
7. **Real API guards:** ownership and scope verified for every query, export, print, photo download and background job.
