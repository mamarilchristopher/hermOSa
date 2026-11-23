# HERMOSA OS — Approved Scope v1.0

**Approved:** 22 November 2026  \
**Selection:** 93/117 candidate features; 24 explicitly excluded. All 77 baseline P1 selections retained.

## Scope rules

- Explicitly selected P2/P3 are **in scope**, not automatic Phase 1 delivery.
- Excluded items are not separate modules to be built unless their minimal security, accounting or storage primitives are necessary to support included items.
- No feature changes without a documented owner-approved scope revision.
- All dates use Asia/Manila in user-facing reports; instants stored UTC; money integer centavos or decimal numeric with appropriate precision.
- System is **not live** and must not be claimed compliant with legal, payroll, BIR or medical requirements until reviewed and tested.

## Feature register

### Company & access (6 / 7)

- [x] **branch** [P1] Set up four branches plus consolidated HQ
- [x] **roles** [P1] Users, roles and branch restrictions
- [x] **master** [P1] Central service, item and employee master records
- [ ] **transferemp** [P2] Multiple branch assignments and transfers
- [x] **approvals** [P1] Approval workflows for high-risk changes
- [x] **periodlock** [P1] Closed accounting/payroll periods and corrections
- [x] **responsive** [P1] Responsive desktop/tablet/mobile screens

### Patient CRM & privacy (4 / 7)

- [x] **patient** [P1] Unified patient directory and deduplication
- [x] **leadsource** [P1] Capture lead source and inquiry history
- [x] **consent** [P1] Privacy notices, consent and opt-outs
- [ ] **patientsegment** [P2] New/returning/inactive cohorts
- [x] **followup** [P1] Follow-up tasks and reminders
- [ ] **loyalty** [P2] Loyalty/membership/referral credits
- [ ] **patientfiles** [P2] Restricted patient attachments and history

### Appointments & front desk (3 / 7)

- [x] **calendar** [P1] Unified appointment calendar per branch
- [x] **walkin** [P1] Walk-in, booking, reschedule, cancellation, no-show
- [ ] **deposit** [P2] Reservation deposits and cancellation rules
- [ ] **capacity** [P2] Staff/room/equipment scheduling conflict checks
- [ ] **remind** [P2] SMS/email/approved Messenger reminder queue
- [ ] **waitlist** [P2] Waitlist and backfill slots
- [x] **bookingfunnel** [P1] Track inquiry-to-booking-to-visit funnel

### Sales, collections & packages (7 / 8)

- [x] **sale** [P1] Service/product POS by branch
- [x] **payments** [P1] Cash, bank, e-wallet, split and partial payments
- [x] **discounts** [P1] Promotions, discount approvals and price history
- [x] **packages** [P1] 5+1, 10+3 and other prepaid package ledger
- [x] **refunds** [P1] Void, refund, exchange and credit notes
- [x] **cashclose** [P1] Cashier shifts and daily collections reconciliation
- [ ] **invoice** [P2] Receipt/invoice numbering and tax-ready exports
- [x] **salescomm** [P1] Staff/service commission attribution

### Treatment session control (6 / 6)

- [x] **sessions** [P1] Treatment/session completion log
- [x] **materials** [P1] Link treatment consumption to stock deductions
- [x] **protocol** [P2] Versioned treatment and consent templates
- [x] **photos** [P3] Before/after photos with purpose-specific consent
- [x] **followclinical** [P2] Post-treatment follow-up scheduling
- [x] **adverse** [P2] Incident, complication and escalation log

### Inventory & supplies (8 / 8)

- [x] **sku** [P1] SKU, units, supplier and product catalog
- [x] **stock** [P1] Stock balance per branch and storage location
- [x] **batch** [P1] Lot, batch and expiry tracking
- [x] **bom** [P1] Per-service material usage templates
- [x] **count** [P1] Stock count, variance and approvals
- [x] **movement** [P1] Branch-to-branch stock transfers
- [x] **reorder** [P2] Low stock, expiry and reorder alerts
- [x] **waste** [P2] Damage, expiry, wastage and returns ledger

### Procurement & suppliers (4 / 6)

- [x] **vendor** [P1] Supplier registry and price history
- [x] **po** [P1] Purchase requests, approvals and POs
- [x] **receiving** [P1] Receiving against PO and supplier bill
- [x] **vendorbill** [P1] Supplier payables, due dates and payments
- [ ] **purchasecompare** [P2] Vendor comparison and price variance tracking
- [ ] **returnvendor** [P2] Purchase returns and supplier credits

### Expenses, cash & accounting (8 / 8)

- [x] **expense** [P1] Expense intake with receipt attachment
- [x] **categories** [P1] Chart of accounts and expense classification
- [x] **petty** [P1] Petty cash, reimbursement and cash advances
- [x] **recurring** [P2] Recurring bills and contract reminders
- [x] **bank** [P2] Bank and e-wallet reconciliation
- [x] **allocation** [P1] Head-office costs and interbranch eliminations
- [x] **accrual** [P2] Accruals, prepaids and fixed assets
- [x] **ledger** [P2] Double-entry accounting journal and trial balance

### Advertising, attribution & CRM funnel (8 / 8)

- [x] **adspend** [P1] Daily ad spend by branch/campaign/channel
- [x] **metacsv** [P1] Meta Ads export upload with column mapping
- [x] **lead** [P1] Lead register and follow-up status
- [x] **attribution** [P1] Lead → appointment → visit → sale links
- [x] **kpis** [P1] CPL, cost per booked visit, CAC, ROAS
- [x] **campaign** [P2] Creative/ad library and campaign comparisons
- [x] **metaapi** [P3] Meta Marketing API and lead integrations
- [x] **alertsads** [P2] Marketing budget pacing and anomaly alerts

### Employees, attendance & schedules (5 / 7)

- [x] **employee** [P1] Employee master profile and employment history
- [x] **shift** [P1] Shift and branch scheduling
- [x] **time** [P1] Clock in/out and attendance import
- [x] **exceptions** [P1] Late, undertime, absence, OT and approvals
- [x] **leave** [P2] Leave applications and balance ledger
- [ ] **mobility** [P2] Temporary branch deployment and cost allocation
- [ ] **staffperf** [P2] Staff productivity and incentive dashboards

### Philippine payroll & incentives (8 / 8)

- [x] **paybasis** [P1] Monthly, daily and hourly pay configurations
- [x] **paycompute** [P1] Payroll runs from approved attendance
- [x] **holidays** [P1] Holiday, rest-day and OT configurable rules
- [x] **deductions** [P1] SSS, PhilHealth, Pag-IBIG and withholding tables
- [x] **incentives** [P1] Commission, performance bonuses and deductions
- [x] **thirteenth** [P1] 13th-month pay and final pay worksheets
- [x] **payslips** [P1] Secure payslips, approval and bank export
- [x] **payadvance** [P2] Loans/cash advance balances and installment plans

### Dashboards, unit economics & alerts (7 / 9)

- [x] **owner** [P1] Company-wide daily/weekly/monthly scorecard
- [x] **branchdash** [P1] Branch comparison with date filters
- [x] **historicaltrend** [P1] Historical month/year comparison and seasonality
- [x] **serviceprofit** [P1] Revenue, gross margin and contribution by service
- [x] **profit** [P1] Branch P&L and consolidated P&L
- [ ] **cashflow** [P2] Cash flow, receivable/payable aging
- [x] **funnelreport** [P1] Marketing funnel, cohort and retention reporting
- [x] **reportexport** [P1] Filtered CSV/XLSX/PDF report exports
- [ ] **exceptionalerts** [P2] Exception center and scheduled owner digest

### Historical data import & reconciliation (6 / 7)

- [x] **import** [P1] Excel/CSV uploads for historical data
- [x] **mapper** [P1] Column mapping and template download
- [x] **quality** [P1] Validation, duplicates and missing-field report
- [x] **opening** [P1] Opening stock, prepaid package and balance migration
- [x] **reconcile** [P1] Reconcile imports against old branch totals
- [x] **lineage** [P1] Import batch IDs, source files and rollback
- [ ] **backfill** [P2] Optional appointment/lead backfill

### Security, privacy & audit (7 / 8)

- [x] **auth** [P1] Secure authentication and MFA for privileged roles
- [x] **rowpolicy** [P1] Server-enforced branch/role data boundaries
- [x] **audit** [P1] Audit log for every sensitive mutation
- [x] **nodel** [P1] Soft delete, reversal and append-only financial logs
- [x] **backup** [P1] Automated backup and tested restore
- [x] **privacy** [P1] Privacy impact assessment and retention settings
- [ ] **exportprivacy** [P2] Data subject request/export/correction workflow
- [x] **monitor** [P1] Monitoring, error alerts and incident response

### Integrations & automation (1 / 7)

- [ ] **notifications** [P2] Email/SMS notification service
- [ ] **financeexport** [P2] Accounting/bookkeeper export formats
- [ ] **paymentsapi** [P3] Payment gateway/e-wallet integration
- [ ] **bir** [P3] Accountant-approved BIR invoicing integration
- [ ] **api** [P2] Documented API and event/webhook framework
- [x] **pwa** [P2] Mobile-friendly installable PWA
- [ ] **offline** [P3] Offline branch transactions with sync conflicts

### Build quality & go-live (5 / 6)

- [x] **schema** [P1] Documented normalized database + migrations
- [x] **test** [P1] Automated unit, integration and E2E tests
- [x] **uat** [P1] Staging, sample data and branch UAT
- [x] **migration** [P1] Phased migration and branch-by-branch rollout
- [x] **documentation** [P1] User guides, system manual and data dictionary
- [ ] **observability** [P2] Performance monitoring and uptime notifications

## Dependency clarifications (not additional feature selection)

1. Clinical photo selection (`photos`) requires restricted attachment storage, access logging, and purpose-specific patient consent; general-purpose patient-files UI (`patientfiles`) remains excluded.
2. Selected `metaapi` is a later-release integration requiring approved Meta permissions; CSV import (`metacsv`) stays the initial source of truth.
3. Selected `ledger` implies genuine balanced journal entries underpinning the selected finance functions; reporting cannot infer accrual-profit from payment totals.
4. `pwa` means installable, responsive app with protected caching. Full offline transaction reconciliation (`offline`) remains excluded.
5. Selected ads attribution must expose unknown/missing links rather than inventing ROAS precision.
6. Since invoicing integration (`invoice`, `bir`) is excluded, the clinic must maintain a separately validated tax invoice/receipt issuance process outside Hermosa OS.
7. Excluding appointment `capacity` means no collision-prevention promise; show potential conflicts if essential for safety, but do not claim booking optimization.
8. Excluded employee temporary-mobility UI does not remove the requirement to assign each time entry and commission to the actual work branch.
9. Privacy obligations remain even without a self-service data-subject request feature; retain a manual procedure.
10. No real patient or employee data should be uploaded to Claude chats. Use anonymized fixtures and secured deployment imports.
