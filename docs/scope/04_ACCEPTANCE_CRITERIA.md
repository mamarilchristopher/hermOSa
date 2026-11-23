# HERMOSA OS — Acceptance Criteria & Test Matrix v1.0

Each acceptance case needs an automated test where feasible plus a branch UAT screenshot/log. Do not mark PASS without reproducible evidence. Fixtures must be fabricated/deidentified and visibly labeled DEMO. Financial totals are in Philippine pesos with two decimal places; transactions use centavos/NUMERIC.

| ID | Given / when / then acceptance criterion | Priority |
|---|---|---|
| AUTH-01 | Branch-A cashier with a valid session requests Branch-B sales API/export → HTTP 403 (or 404 as policy), no rows and audit event | Go-live blocker |
| AUTH-02 | Admin without verified MFA attempts to change staff roles or approve sensitive transaction → denied | Go-live blocker |
| AUTH-03 | Branch manager requests all-branch P&L → denied; owner receives sum of accessible verified external branch data | Go-live blocker |
| DATA-01 | Import file includes valid and invalid rows → invalid rows staged with reasons; nothing from invalid rows posted | Go-live blocker |
| DATA-02 | Same source hash/file uploaded twice → no duplicate historical rows; same idempotency key yields same result | Go-live blocker |
| DATA-03 | Historical sample totals disagree with approved source branch totals → batch cannot publish | Go-live blocker |
| DATA-04 | Approved historical dataset published and later reversed through authorization → audit and original source retained; report no longer double counts | Go-live blocker |
| DATA-05 | All 4 branches have zero history → dashboards display 'No validated data' rather than placeholder currency figures | Go-live blocker |
| POS-01 | ₱10,000 sale settled ₱3,000 cash + ₱7,000 e-wallet → sales 10k, collected 10k, payment method totals 3k/7k | Go-live blocker |
| POS-02 | Sale posted but unpaid → sales/receivable appropriately recorded; collections zero | Go-live blocker |
| POS-03 | Refund approved after payment → linked reversal changes cash and receivables/commission where applicable; sale never deleted | Go-live blocker |
| PACK-01 | 5+1 package purchase → exactly 6 entitlements; collection does not count again when redeemed | Go-live blocker |
| PACK-02 | Attempt seventh package redemption, double click or duplicate API retry → refused/idempotent, balance never negative | Go-live blocker |
| PACK-03 | Service treatment against package → 1 entitlement consumed once and deferred balance released by documented valuation rule | Go-live blocker |
| INV-01 | Opening 10 units + purchased 5 + received transfer 2 − sent transfer 3 − consumed 4 − waste 1 → balance 9 units by same SKU, lot and branch | Go-live blocker |
| INV-02 | Expired batch used for clinical service → blocked; override is separate controlled workflow, not auto-use | Go-live blocker |
| INV-03 | Transfer between branches → send and receipt have linked events; consolidated units do not change | Go-live blocker |
| FIN-01 | Journal entry debits do not equal credits → posting transaction rolls back completely | Go-live blocker |
| FIN-02 | One HQ expense allocated to four branches → consolidated expense counted once, branch allocation traceable; no fictitious cash flow | Go-live blocker |
| FIN-03 | Closed month edited by cashier → denied; authorized correction in next period retains original | Go-live blocker |
| FIN-04 | Compare branch P&Ls vs consolidated statement → correctly eliminate internal transactions and report unallocated HQ expenses separately | Go-live blocker |
| HR-01 | Employee with two effective-dated salary versions has attendance spanning version change → correct rates applied per eligible date and approved cutoff rules | Go-live blocker |
| HR-02 | Payroll without approved attendance exceptions or published statutory rule version → cannot finalize | Go-live blocker |
| HR-03 | Employee requests another employee's payslip → denied and audited | Go-live blocker |
| HR-04 | Gross wages, employer costs, employee deductions and net pay reconcile to payslips and journals | Go-live blocker |
| AD-01 | CSV spend links to campaign and lead, appointment, visit and sale → drill-down preserves raw sources and dates | Go-live blocker |
| AD-02 | Lead source absent or ambiguous → displayed as Unknown, never silently allocated to a paid campaign | Go-live blocker |
| AD-03 | Meta API sync sends same event again → existing event updated/idempotent, spend does not double count | Integration gate |
| CLIN-01 | Clinician without purpose-specific photo consent attempts photo view → denied even if appointment exists | Go-live blocker |
| CLIN-02 | Treatment performed consumes actual material batch and logs staff/time without exposing note content to cashier | Go-live blocker |
| SYS-01 | Automated backup restored in staging → checksums, row counts and sample reports match | Go-live blocker |
| SYS-02 | Test endpoint shows session data but frontend hides menu → direct API attack is still denied by server policy | Go-live blocker |
| SYS-03 | Installed PWA caches static assets but never stores patient records/payroll/sensitive documents unencrypted offline | PWA gate |
| SYS-04 | Versioned deployment migration is reversible or backed by tested recovery procedure | Go-live blocker |

## Cross-module smoke flows

1. **Lead to patient profitability:** lead → consultation → appointment → performed session → POS sale → split payment → material consumption → employee commission → branch P&L → owner consolidated view.
2. **Packages:** package sale → cash receipt/deferred revenue → redeemed session → clinical material consumption → recognized revenue → remaining entitlement count → partial refund/reversal.
3. **Procurement:** request → PO → goods received by batch → supplier payable → partial supplier payment → stock transfer → session use → COGS.
4. **Payroll:** shift → clock-in/out → exception approval → pay calculation → review → statutory references → authorized payroll posting → employee payslip → branch expense.
5. **Historical:** raw file → mapping → row validation → expected source totals → reconciliation signoff → publish → YoY dashboard → rollback with audit.
6. **Marketing:** Meta spend → lead → booking → visit → service → gross/contribution/attributed revenue → CAC and ROAS metrics with unknown-source coverage.

## Required evidence for each release

- Automated commands and exact test results; lint/typecheck success; migration and RLS security tests.
- Screenshots or scripts showing all relevant role/branch combinations, financial totals and edge cases.
- Rollback or reversal evidence, sample audit trail, import source hash and reconciliation signoff.
- Signoff by owner + branch representatives + finance; for payroll/clinical/privacy/tax, the relevant qualified reviewer.
