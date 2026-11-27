import { sortServices } from "@/lib/serviceOrder";
import Link from "next/link";
import { EntryDetails } from "./EntryDetails";
import { redirect } from "next/navigation";
import { requireAccess, branchesFor, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { addDays, sortBranches, WEEKDAYS, weekday } from "@/lib/insights";
import { ROLE_TEXT, TYPE_TEXT } from "@/lib/commission";
import { AfterDpForm, BatchApprove, BranchEntryForm, ChangeBranchForm, ChangeDateForm, DecideButtons, FixPackageForm, RenameClientForm, RenumberForm, VoidEntryForm } from "./Forms";
import type { PackageLine } from "@/lib/packages";
import { Uid } from "@/components/Uid";
import { StaffFilter } from "./StaffFilter";
import { DeclaredCheck, diffText } from "./DeclaredCheck";
import { CHECK_FROM, CHECK_TO, checkBranches, inCheckWindow, type StatusDay } from "@/lib/declaredCheck";
import { AddPhotosLater } from "./PhotoSlots";
import { EditPhotos } from "./EditPhotos";
import { AttachProof } from "./PaymentProof";
import type { PromoOptions } from "@/lib/promoTrack";

type Log = {
  id: string; service_date: string; amount_paid_cents: number; commission_type: string; performer_id: string; assistant_id: string | null;
  receipt_no: string | null; note: string | null; service_id?: string; branch_id?: string; client_name?: string | null; price_note?: string | null; after_dp?: boolean; list_price_cents?: number | null; photo_folder?: string | null; share_ok?: boolean; photos_due?: boolean; session_no?: number; log_no?: string | null; state: string; visit_kind?: string; created_by: string; created_at: string; decision_note: string | null;
  services: { name: string } | null;
};
const VISIT_TEXT: Record<string, string> = { BACKJOB: "Backjob (unpaid)", CHECKUP: "Check-up (unpaid)", NO_CHARGE: "No charge" };
type Line = { service_log_id: string; employee_id: string; role: string; amount_cents: number };

const topMgmtFor = (access: Parameters<typeof can>[0]) => can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);

export default async function ServiceLog({ searchParams }: { searchParams: Promise<{ date?: string; branch?: string; entry?: string; days?: string; staff?: string; booking?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  const viewable = branchesFor(access, branches, ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"]);
  if (viewable.length === 0) redirect("/");
  // update-0092 (CHRIS Nov 27): staff work at any branch. Where they are today = the branch they timed in at,
  // else today's schedule, else their home branch (records only). Staff open on that branch; management on All branches.
  const staffOnly = !can(access, ["OWNER", "FINANCE", "MANAGER", "AUDITOR", "HR"], null) && !access.grants.some((g) => g.role === "MANAGER");
  const { data: meRow } = await supabase.from("employees").select("id, branch_id").eq("app_user_id", access.user_id).eq("active", true).order("created_at").limit(1).maybeSingle();
  // update-0097: everyone's time-in branches today (before update-0097 the function is missing: no limits).
  const { data: atToday } = await supabase.rpc("staff_branches_today");
  const timedIn = (atToday && typeof atToday === "object" ? atToday : {}) as Record<string, string[]>;
  const [{ data: inAt }, { data: shiftAt }] = meRow ? await Promise.all([
    supabase.from("time_punches").select("branch_id").eq("employee_id", meRow.id).eq("work_date", manilaToday()).eq("kind", "IN").order("punched_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("shifts").select("branch_id").eq("employee_id", meRow.id).eq("work_date", manilaToday()).eq("state", "PUBLISHED").maybeSingle(),
  ]) : [{ data: null }, { data: null }];
  const workingAt = [inAt?.branch_id, shiftAt?.branch_id, meRow?.branch_id].find((id) => id && viewable.some((b) => b.id === id)) as string | undefined;
  // CHRIS Nov 26 (v0.80.1): "All branches" is the default for anyone who sees more than one branch.
  const picked = viewable.find((b) => b.code === sp.branch) ?? (sp.branch === undefined && staffOnly ? viewable.find((b) => b.id === workingAt) : undefined);
  const branch = picked ?? (viewable.length > 1 ? null : viewable[0]);
  const scope = branch ? [branch] : viewable;
  const scopeIds = scope.map((b) => b.id);
  const bName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const LOG_ROLES = ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN"] as const;
  // update-0097 (CHRIS Nov 27): staff log today's services only at the branch(es) they timed in at. Owners and the GM anywhere.
  const myAt = meRow ? timedIn[meRow.id] ?? [] : [];
  const logBranches = scope.filter((b) => can(access, [...LOG_ROLES], b.id) && (topMgmtFor(access) || myAt.length === 0 || myAt.includes(b.id)));
  const approverFor = (id: string | undefined) => !!id && can(access, ["OWNER", "MANAGER"], id);
  const today = manilaToday();
  const date = isIsoDate(sp.date) && sp.date <= today ? sp.date : today;
  // CHRIS Nov 26: entries grouped by day, the last 7 days up to the chosen day, with "Show 7 more days".
  const days = Math.min(91, Math.max(7, Math.round(Number(sp.days) / 7) * 7 || 7));
  const from = addDays(date, -(days - 1));
  const canLog = logBranches.length > 0;
  const approver = scope.some((b) => approverFor(b.id));
  // Owners and the GM (update-0054) may log without photos; the lead and assist add them later.
  const topMgmt = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const isManager = can(access, ["OWNER", "MANAGER"], null) || branchesFor(access, branches, ["MANAGER"]).length > 0;

  // update-0091 (CHRIS Nov 27): "Log the sale" from a booking (Arriving or Arrived): the form starts filled in from it.
  const { data: bk } = sp.booking && /^[0-9a-f-]{36}$/.test(sp.booking)
    ? await supabase.from("bookings").select("id, client_name, waiver_name, services, branch_id, status, appointment_date").eq("id", sp.booking).maybeSingle()
    : { data: null };
  const [{ data: services }, { data: emps }, { data: logs }, { data: ppl }] = await Promise.all([
    supabase.from("services").select("*").eq("active", true).order("name"), // "*": session_prices exists only after update-0068
    supabase.from("employees").select("id, full_name, branch_id, commission_eligible, app_user_id, position").eq("active", true).order("full_name"),
    supabase.from("service_logs").select("*, services(name)")
      .in("branch_id", scopeIds).gte("service_date", from).lte("service_date", date).order("service_date", { ascending: false }).order("created_at"),
    supabase.rpc("chat_people"), // names of everyone in the company, for "Entered by"
  ]);
  const allRaw = (logs ?? []) as unknown as Log[];
  // CHRIS Nov 26: filter by one staff member (Done by or Assisted by). Default: everyone.
  const staffPick = (emps ?? []).find((e) => e.id === sp.staff)?.id ?? null;
  const all = staffPick ? allRaw.filter((l) => l.performer_id === staffPick || l.assistant_id === staffPick) : allRaw;
  const staffChoices = (emps ?? []).filter((e) => scopeIds.includes(e.branch_id) || allRaw.some((l) => l.performer_id === e.id || l.assistant_id === e.id))
    .filter((e) => !/general\s*manager/i.test(e.position ?? "") && !/\bcsr\b/i.test(e.position ?? ""))
    .map((e) => ({ id: e.id, name: e.full_name }));
  // Proof of payment (update-0075): how many each entry has (only the ones this person may see; none before 0075).
  const { data: proofRows } = all.length ? await supabase.from("payment_proofs").select("service_log_id").in("service_log_id", all.map((l) => l.id)) : { data: [] };
  const proofCount = new Map<string, number>();
  for (const r of (proofRows ?? []) as { service_log_id: string }[]) proofCount.set(r.service_log_id, (proofCount.get(r.service_log_id) ?? 0) + 1);
  // update-0076: has management confirmed the transfer?
  const { data: checkRows } = proofCount.size ? await supabase.from("payment_checks").select("service_log_id, state").in("service_log_id", [...proofCount.keys()]) : { data: [] };
  const payCheck = new Map(((checkRows ?? []) as { service_log_id: string; state: string }[]).map((r) => [r.service_log_id, r.state]));
  // CHRIS Nov 26: owners and the GM see a running Nov 1–24 check against the declared sales.
  const { data: declaredData } = topMgmt ? await supabase.rpc("daily_sales_status", { p_start: CHECK_FROM, p_end: CHECK_TO }) : { data: null };
  const declared = declaredData as { ok: boolean; branches: { id: string; code: string; name: string }[]; days: StatusDay[] } | null;
  const checkList = declared?.ok ? sortBranches(declared.branches) : [];
  const checks = checkBranches(declared?.days ?? [], checkList.map((b) => b.id)).map((c) => ({ ...c, code: checkList.find((b) => b.id === c.branch)!.code }));
  const checkNames = Object.fromEntries(checkList.map((b) => [b.id, b.name]));
  const dayCheck = new Map((branch ? checks.find((c) => c.branch === branch.id)?.days ?? [] : []).map((d) => [d.date, d]));
  const list = all.filter((l) => l.service_date === date); // the chosen day, for the cards on top
  // update-0054 (CHRIS Nov 26): only staff timed in today add entries; owners and the GM always can.
  const { data: onDuty } = canLog && !topMgmt ? await supabase.rpc("can_log_services_now") : { data: true };
  // update-0093: photo changes waiting for the owners / the GM (errors before the update = none).
  const { data: photoWaiting } = topMgmt ? await supabase.rpc("photo_changes_pending") : { data: 0 };
  // update-0087: promo items and the clients with sessions left (errors before the update mean no promo tracking yet).
  const { data: promoData } = canLog ? await supabase.rpc("promo_log_options") : { data: null };
  const promoOpts = (promoData as (PromoOptions & { ok: boolean }) | null)?.ok ? (promoData as PromoOptions) : null;
  // CHRIS Nov 27: clients' package records (bundle sessions already logged), so the form suggests the next session.
  const bundleIds = (services ?? []).filter((s) => Array.isArray(s.session_prices) && s.session_prices.length).map((s) => s.id as string);
  const { data: pkgRows } = canLog && bundleIds.length
    ? await supabase.from("service_logs").select("client_name, service_id, session_no, service_date, amount_paid_cents, branch_id")
      .in("service_id", bundleIds).neq("state", "REJECTED").not("client_name", "is", null).order("service_date", { ascending: false }).limit(5000)
    : { data: [] };
  const packages: PackageLine[] = ((pkgRows ?? []) as { client_name: string; service_id: string; session_no: number | null; service_date: string; amount_paid_cents: number; branch_id: string | null }[])
    .map((r) => ({ client: r.client_name, service: r.service_id, session: r.session_no ?? 1, date: r.service_date, amount: Number(r.amount_paid_cents), branch: r.branch_id }));
  const { data: lineRows } = all.length
    ? await supabase.from("commission_lines").select("service_log_id, employee_id, role, amount_cents").in("service_log_id", all.map((l) => l.id))
    : { data: [] as Line[] };
  const lines = (lineRows ?? []) as Line[];
  const name = Object.fromEntries((emps ?? []).map((e) => [e.id, e.full_name]));
  // CHRIS Nov 26: who entered each entry, and when.
  const userName = new Map<string, string>([
    ...(emps ?? []).filter((e) => e.app_user_id).map((e) => [e.app_user_id as string, e.full_name] as [string, string]),
    ...((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name] as [string, string]),
    [access.user_id, access.display_name],
  ]);
  // Time it was entered; the date too when it was entered on a later day than the service.
  const enteredAt = (ts: string, day: string) => {
    const d = new Date(ts), t = d.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
    return manilaToday(d) === day ? t : `${d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}, ${t}`;
  };
  const mine = new Set((emps ?? []).filter((e) => e.app_user_id === access.user_id).map((e) => e.id));
  // CHRIS Nov 26: the General Manager doesn't perform services, so she isn't in the Lead / Assisted by lists.
  const clinicIds = new Set(branches.filter((b) => b.kind === "CLINIC").map((b) => b.id));
  // CHRIS Nov 26: only clinic staff in these lists (no CSRs / WFH staff).
  const employees = (emps ?? []).filter((e) => !/general\s*manager/i.test(e.position ?? "") && !/\bcsr\b/i.test(e.position ?? "") && clinicIds.has(e.branch_id)).map((e) => ({ id: e.id, name: e.full_name, eligible: e.commission_eligible, branch: e.branch_id as string, at: timedIn[e.id] ?? [] }));
  // Staff who aren't on commission never see commission choices (management still does, to log for others).
  const myEmp = (emps ?? []).find((e) => e.app_user_id === access.user_id);
  const noCommission = !!myEmp && !myEmp.commission_eligible && !access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));

  const paid = list.filter((l) => l.state !== "REJECTED").reduce((s, l) => s + Number(l.amount_paid_cents), 0);
  // v0.92.1 fix: only the chosen day's entries. Lines are loaded for every day shown (7+ days), and a line whose
  // entry wasn't on the chosen day used to count too, so the card showed the whole week's commission.
  const dayIds = new Set(list.filter((l) => l.state !== "REJECTED").map((l) => l.id));
  const commission = lines.filter((x) => dayIds.has(x.service_log_id)).reduce((s, x) => s + Number(x.amount_cents), 0);
  const pendingCount = list.filter((l) => l.state === "PENDING").length;
  const pendingMine = all.filter((l) => l.state === "PENDING" && approverFor(l.branch_id));
  const pendingAll = pendingMine.length;
  const groups = [...new Set(all.map((l) => l.service_date))].map((d) => [d, all.filter((l) => l.service_date === d)] as const);
  const here = branch?.code ?? "ALL";
  // The booking's sale can be logged only at its own branch, by someone who logs services there.
  const fromBooking = bk && logBranches.some((b) => b.id === bk.branch_id) && ["ARRIVING", "ARRIVED", "DONE"].includes(bk.status) ? {
    id: bk.id as string, fbName: bk.client_name as string, waiverName: (bk.waiver_name as string | null) ?? null,
    // The booked service, when it matches a price list name (the CSR may have typed something else).
    serviceId: ((services ?? []) as { id: string; name: string; is_meds?: boolean }[]).find((x) => !x.is_meds && x.name.trim().toLowerCase() === String(bk.services ?? "").trim().toLowerCase())?.id ?? null,
  } : null;
  const link = (d: string, b = here) => `/services?date=${d}&branch=${b}${staffPick && b === here ? `&staff=${staffPick}` : ""}`;
  // All branches: each branch's total for the chosen day, in branch order.
  const perBranch = branch ? [] : scope.map((b) => ({ name: b.name, cents: list.filter((l) => l.branch_id === b.id && l.state !== "REJECTED").reduce((x, l) => x + Number(l.amount_paid_cents), 0) }));
  const order = new Map(scope.map((b, i) => [b.id, i]));
  const dayLabel = `${WEEKDAYS[weekday(date)]}, ${new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Service Log</h1>
        <p className="muted small">{noCommission ? "Every service done today and who did it. A manager signs off each entry." : "Every service done today, who did it and the commission. A manager signs off each entry."}</p>
        <form action="/services/clients" className="row-buttons log-search" style={{ marginTop: -4 }}>
          <input name="q" minLength={2} required placeholder="🔍 Search a client (all dates)" aria-label="Search a client" />
          <button className="secondary small">Search</button>
          {bundleIds.length > 0 && <Link className="small" href="/services/packages">📦 Package clients</Link>}
        </form>

        <div className="periods card">
          <div className="segmented" role="tablist" aria-label="Branch">
            {viewable.length > 1 && <Link href={link(date, "ALL")} className={branch ? "" : "on"}>All branches</Link>}
            {viewable.map((b) => <Link key={b.id} href={link(date, b.code)} className={b.id === branch?.id ? "on" : ""}>{b.name}</Link>)}
          </div>
          <form className="day-nav">
            <input type="hidden" name="branch" value={here} />
            <Link className="button secondary small" href={link(addDays(date, -1))} aria-label="Previous day">←</Link>
            <input type="date" name="date" defaultValue={date} max={today} aria-label="Date" />
            <button type="submit" className="secondary small">Go</button>
            {date < today && <Link className="button secondary small" href={link(addDays(date, 1))} aria-label="Next day">→</Link>}
            {date !== today && <Link className="button secondary small" href={link(today)}>Today</Link>}
          </form>
        </div>

        <div className="grid">
          <div className="card stat hero"><div className="label">{branch?.name ?? "All branches"} · {dayLabel}</div><div className="value">{centsToPhp(paid)}</div><div className="note">{(() => { const ok = list.filter((l) => l.state !== "REJECTED"); const unpaid = ok.filter((l) => l.visit_kind && l.visit_kind !== "PAID").length; return `${ok.length - unpaid} paid services${unpaid ? `, ${unpaid} unpaid visit${unpaid === 1 ? "" : "s"}` : ""}`; })()}</div>
            {perBranch.length > 0 && <div className="branch-split">{perBranch.map((b) => <span key={b.name}><span className="muted">{b.name.replace(/ \(.*\)$/, "")}</span> {centsToPhp(b.cents)}</span>)}</div>}</div>
          {approver && <div className="card stat"><div className="label">Commission</div><div className="value">{centsToPhp(commission)}</div><div className="note">5% of amount paid, lead 60 / assist 40</div></div>}
          <div className="card stat"><div className="label">Sign-off</div><div className="value">{pendingCount === 0 ? (list.length ? "All signed" : "–") : `${pendingCount} waiting`}</div><div className="note">{approver ? "Approve entries below, one by one or together" : "Your manager signs these off"}</div></div>
        </div>

        {Number(photoWaiting) > 0 && (
          <div className="notice"><strong>{Number(photoWaiting)} photo change{Number(photoWaiting) === 1 ? "" : "s"}</strong> waiting for your approval. <Link href="/services/photo-changes">Review photo changes</Link></div>
        )}
        {checks.length > 0 && <DeclaredCheck checks={checks} names={checkNames} current={branch?.id ?? ""} open={inCheckWindow(date)} day={inCheckWindow(date) ? date : CHECK_TO} link={link} />}

        {canLog && (
          <div className="card">
            <h2>Add a service</h2>
            {onDuty === false ? (
              <div className="notice info">Time in first to add services. Only staff who are timed in today can add to the Service log. <Link href="/time">Go to Time clock</Link></div>
            ) : (services ?? []).length === 0 || employees.length === 0 ? (
              <div className="notice info">
                {employees.length === 0 ? <>Add the branch&apos;s staff first on <Link href="/people">Employees</Link>. </> : null}
                {(services ?? []).length === 0 ? "Add your services below first." : null}
              </div>
            ) : (
              <>
            {fromBooking && bk && (
              <div className="notice info booking-from">
                Logging the sale for <strong>{bk.waiver_name ?? bk.client_name}</strong>{bk.waiver_name ? <span className="muted"> (FB: {bk.client_name})</span> : null}, booked for {bk.services} at {bName[bk.branch_id] ?? "the branch"}. Saving links it to the booking, so it&apos;s not recorded twice. <Link href={`/bookings?d=${bk.appointment_date}&focus=${bk.id}`}>Back to Bookings</Link>
              </div>
            )}
            <BranchEntryForm key={`${here}-${fromBooking?.id ?? ""}`} booking={fromBooking} branches={(fromBooking ? logBranches.filter((b) => b.id === bk!.branch_id) : logBranches).map((b) => ({ id: b.id, name: b.name }))} start={fromBooking ? bk!.branch_id : logBranches.find((b) => b.id === workingAt)?.id ?? (logBranches.length === 1 ? logBranches[0].id : "")} date={date} today={today} meds={(services ?? []).filter((s) => s.is_meds).map((s) => ({ id: s.id, name: s.name, price: Number(s.price_cents ?? 0) }))} services={sortServices((services ?? []).filter((s) => !s.is_meds)).map((s) => ({ id: s.id, name: s.name, price: s.price_cents ?? null, commission: s.commission_cents ?? null, sessions: Array.isArray(s.session_prices) ? (s.session_prices as (number | string)[]).map(Number) : null }))} promos={promoOpts} packages={packages} addons={sortServices((services ?? []).filter((s) => s.is_addon && !s.is_meds)).map((s) => ({ id: s.id, name: s.name, price: s.price_cents ?? null }))} employees={employees} noCommission={noCommission} photosOptional={topMgmt} />
            </>
            )}
            {isManager && <p className="small" style={{ marginTop: 12 }}><Link href="/services/prices">Price list and commissions</Link> (add a service, set its price and commission)</p>}
          </div>
        )}

        <div className="entries-head">
          <h2>Entries</h2>
          {staffChoices.length > 0 && <StaffFilter choices={staffChoices} value={staffPick} />}
        </div>
        {approver && pendingAll > 1 && <BatchApprove ids={pendingMine.map((l) => l.id)} />}
        {groups.length === 0 && <p className="muted">Nothing logged in these {days} days.</p>}
        {groups.map(([d, dayList]) => {
          const ok = dayList.filter((l) => l.state !== "REJECTED");
          const waiting = dayList.filter((l) => l.state === "PENDING").length;
          return (
            <section key={d} className="log-day">
              <h3 className="log-day-head">
                <span>{d === today ? "Today" : d === addDays(today, -1) ? "Yesterday" : WEEKDAYS[weekday(d)]}, {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "UTC" })}</span>
                <span className="small muted">{ok.length} entr{ok.length === 1 ? "y" : "ies"} · {centsToPhp(ok.reduce((x, l) => x + Number(l.amount_paid_cents), 0))}{waiting ? ` · ${waiting} waiting` : ""}
                  {dayCheck.has(d) && <span className={`check-note ${dayCheck.get(d)!.status}`}> · {diffText(dayCheck.get(d)!)}</span>}</span>
              </h3>
        <div className="table-wrap">
          <table className="log-table">
            <thead>
              <tr><th>Service</th><th className="num">Paid</th><th>Type</th><th>Staff</th><th className="num">{noCommission ? "Role" : "Commission"}</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(branch ? dayList : dayList.slice().sort((a, b) => (order.get(a.branch_id ?? "") ?? 9) - (order.get(b.branch_id ?? "") ?? 9))).map((l) => {
                const ls = lines.filter((x) => x.service_log_id === l.id);
                const staff = [l.performer_id, l.assistant_id].filter(Boolean) as string[];
                return (
                  <tr key={l.id} id={`entry-${l.id}`} className={[l.state === "REJECTED" ? "rejected" : "", sp.entry === l.id ? "entry-focus" : ""].join(" ").trim() || undefined}>
                    <td>{!branch && l.branch_id && <span className="tag branch-tag">{(bName[l.branch_id] ?? "").replace(/ \(.*\)$/, "")}</span>}
                      {l.state === "PENDING" && approverFor(l.branch_id) && pendingAll > 1 && (
                        <input type="checkbox" className="batch-tick" name="pick" value={l.id} form="batch-approve" aria-label={`Tick ${l.client_name ?? "entry"} to approve`} />
                      )}
                      {(l.client_name || l.log_no) && <div className="log-client">{l.client_name}<Uid v={l.log_no} /></div>}<strong>{(l.session_no ?? 1) > 1 && <span className="session-tag">Session {l.session_no}</span>}{l.services?.name}</strong>
                      {l.receipt_no && <div className="small muted">Waiver / OR {l.receipt_no}</div>}
                      {l.after_dp && <div className="small"><span className="tag">Balance after DP</span> <span className="muted">commission on the full price</span></div>}
                      {l.price_note && <div className="small muted">Price: {l.price_note}</div>}
                      {l.note && <div className="small muted">{l.note}</div>}
                      {l.photos_due && l.state !== "REJECTED" && (
                        <div className="photos-due">
                          <span className="pill REVERSED">Photos missing</span>
                          {!noCommission && <span className="small muted"> Commission held until they&apos;re added.</span>}
                          {(topMgmt || l.created_by === access.user_id || staff.some((x) => mine.has(x))) && (
                            <AddPhotosLater log={l.id} branch={l.branch_id ?? branch?.id ?? ""} folder={l.photo_folder ?? null} needs="before and after photos and both waiver pages" />
                          )}
                        </div>
                      )}
                      <div className="log-by small"><span className="muted">Entered by</span> {l.created_by === access.user_id ? "you" : userName.get(l.created_by) ?? "a former user"} <span className="muted">· {enteredAt(l.created_at, l.service_date)}</span></div>
                      <EntryDetails r={{
                        id: l.id, branch: bName[l.branch_id ?? ""] ?? branch?.name ?? "", date: l.service_date, client: l.client_name ?? "No client name",
                        service: l.services?.name ?? "Service", session: l.session_no ?? 1, amount: Number(l.amount_paid_cents), kind: l.visit_kind ?? "PAID",
                        priceNote: l.price_note ?? null, doneBy: name[l.performer_id] ?? null, assistedBy: l.assistant_id ? name[l.assistant_id] ?? null : null,
                        status: l.state === "APPROVED" ? "Approved" : l.state === "REJECTED" ? "Rejected" : "Waiting for sign-off",
                        enteredBy: userName.get(l.created_by) ?? "Staff", enteredAt: enteredAt(l.created_at, l.service_date),
                        visit: (l.client_name ? dayList.filter((x) => x.state !== "REJECTED" && (x.client_name ?? "").trim().toLowerCase() === l.client_name!.trim().toLowerCase()) : [l])
                          .slice().reverse().map((x) => ({ service: x.services?.name ?? "Service", session: x.session_no ?? 1, amount: Number(x.amount_paid_cents), kind: x.visit_kind ?? "PAID" })),
                      }} />
                      {proofCount.get(l.id) ? <div className="small"><Link href={`/clinic/payments?month=${l.service_date.slice(0, 7)}#${l.id}`}>💳 Proof of payment ({proofCount.get(l.id)})</Link>
                        {payCheck.get(l.id) && <span className={`pill ${payCheck.get(l.id) === "RECEIVED" ? "PUBLISHED" : payCheck.get(l.id) === "NOT_RECEIVED" ? "REVERSED" : "STAGED"}`} style={{ marginLeft: 6 }}>
                          {payCheck.get(l.id) === "RECEIVED" ? "Payment received" : payCheck.get(l.id) === "NOT_RECEIVED" ? "Not received" : "To confirm"}</span>}</div> : null}
                      {l.state !== "REJECTED" && <AttachProof log={l.id} branch={l.branch_id ?? branch?.id ?? ""} have={proofCount.get(l.id) ?? 0} />}
                      {l.photo_folder && l.client_name && <div className="small"><Link href={`/clinic/archive?month=${l.service_date.slice(0, 7)}#${l.id}`}>Photos</Link>{l.share_ok ? <span className="muted"> · sharing OK</span> : null}</div>}
                      {/* update-0093 (CHRIS Nov 27): add, remove or replace photos on a past entry; saved after an owner's or the GM's approval. */}
                      {l.state !== "REJECTED" && !l.photos_due && (topMgmt || l.created_by === access.user_id || staff.some((x) => mine.has(x))) && (
                        <EditPhotos log={l.id} branch={l.branch_id ?? branch?.id ?? ""} approver={can(access, ["OWNER"], null) || can(access, ["MANAGER"], null)} />
                      )}</td>
                    <td className="num">{centsToPhp(l.amount_paid_cents)}</td>
                    <td>{l.visit_kind && l.visit_kind !== "PAID"
                      ? <span className="tag">{VISIT_TEXT[l.visit_kind] ?? l.visit_kind}</span>
                      : <span className={`tag ${l.commission_type}`}>{TYPE_TEXT[l.commission_type]}</span>}</td>
                    {/* v0.49 (CHRIS Nov 26): staff and commission in their own columns, one line per person, aligned. */}
                    <td>
                      {staff.map((id) => (
                        <div key={id} className="staff-line">{name[id] ?? "Former staff"}{mine.has(id) && <span className="muted"> (you)</span>}</div>
                      ))}
                    </td>
                    <td className="num">
                      {staff.map((id, i) => {
                        const line = ls.find((x) => x.employee_id === id);
                        const role = l.commission_type === "LEAD" ? (i === 0 ? "lead" : "assist") : l.commission_type === "SOLO" ? "solo" : "";
                        return (
                          <div key={id} className="staff-line comm">
                            {noCommission ? <span className="muted small">{role || "-"}</span> : line ? <><strong>{centsToPhp(line.amount_cents)}</strong> <span className="muted small">{ROLE_TEXT[line.role]}</span></>
                              : <span className="muted small">{l.commission_type === "NONCOMMI" ? "-" : approver || mine.has(id) ? `no commission · ${role}` : role}</span>}
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      {l.state === "PENDING" && approverFor(l.branch_id) ? <DecideButtons id={l.id} /> : (
                        <span className={`pill ${l.state === "APPROVED" ? "PUBLISHED" : l.state === "REJECTED" ? "REVERSED" : "STAGED"}`}>
                          {l.state === "APPROVED" ? "Approved" : l.state === "REJECTED" ? "Rejected" : "Waiting"}
                        </span>
                      )}
                      {l.state === "REJECTED" && l.decision_note && <div className="small muted">{l.decision_note}</div>}
                      {topMgmt && <ChangeDateForm id={l.id} date={l.service_date} max={today} />}
                      {topMgmt && l.state !== "REJECTED" && l.visit_kind === "NO_CHARGE" && l.service_id && bundleIds.includes(l.service_id) && <FixPackageForm id={l.id} />}
                      {topMgmt && l.state === "APPROVED" && <VoidEntryForm id={l.id} />}
                      {topMgmt && <ChangeBranchForm id={l.id} branch={l.branch_id ?? ""} branches={viewable.map((b) => ({ id: b.id, name: b.name }))} />}
                      {l.client_name && l.state !== "REJECTED" && (topMgmt || l.created_by === access.user_id || staff.some((x) => mine.has(x))) && <RenameClientForm id={l.id} name={l.client_name} all={topMgmt} />}
                      {topMgmt && l.state !== "REJECTED" && (l.after_dp || ((l.visit_kind ?? "PAID") === "PAID" && Number(l.amount_paid_cents) > 0 && Number(l.list_price_cents ?? 0) > Number(l.amount_paid_cents))) && (
                        <AfterDpForm id={l.id} on={!!l.after_dp} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
            </section>
          );
        })}
        <p className="log-more">{days < 91 && <Link className="button secondary" href={`${link(date)}&days=${days + 7}`} scroll={false}>Show 7 more days</Link>}
          <span className="small muted"> Showing the {days} days up to {date === today ? "today" : dayLabel}.</span></p>
        {can(access, ["OWNER"], null) && (
          <RenumberForm month={date.slice(0, 7)} label={new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" })} />
        )}
      </main>
    </>
  );
}
