import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAccess, branchesFor, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { addMonths, monthEnd, monthLabel } from "@/lib/insights";
import { ROLE_TEXT } from "@/lib/commission";
import { EmployeeForm } from "../EmployeeForm";
import { StartDateForm } from "../StartDateForm";
import { Reveal } from "@/components/Reveal";
import { DetailsView } from "@/components/DetailsView";
import type { Details } from "@/lib/employeeDetails";
import { Uid } from "@/components/Uid";

type Line = { id: string; role: string; amount_cents: number; service_logs: { id: string; service_date: string; state: string; amount_paid_cents: number; branch_id: string; services: { name: string } | null } };

export default async function Employee({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ month?: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, access, branches } = await requireAccess();
  const { data: e } = await supabase.from("employees").select("id, uid, full_name, branch_id, position, commission_eligible, app_user_id, active, hire_date").eq("id", id).maybeSingle();
  if (!e) notFound();
  const sp = await searchParams;
  const thisMonth = manilaToday().slice(0, 7);
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  const start = `${ym}-01`, end = monthEnd(start);
  const { data } = await supabase.from("commission_lines")
    .select("id, role, amount_cents, service_logs!inner(id, service_date, state, amount_paid_cents, branch_id, services(name))")
    .eq("employee_id", id).gte("service_logs.service_date", start).lte("service_logs.service_date", end);
  const lines = ((data ?? []) as unknown as Line[]).sort((a, b) => a.service_logs.service_date.localeCompare(b.service_logs.service_date));
  const approved = lines.filter((l) => l.service_logs.state === "APPROVED").reduce((s, l) => s + Number(l.amount_cents), 0);
  const pending = lines.filter((l) => l.service_logs.state === "PENDING").reduce((s, l) => s + Number(l.amount_cents), 0);
  const byRole = (r: string) => lines.filter((l) => l.role === r && l.service_logs.state === "APPROVED").reduce((s, l) => s + Number(l.amount_cents), 0);
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const canEdit = can(access, ["OWNER", "HR", "MANAGER"], e.branch_id);
  const isOwner = can(access, ["OWNER"], null);
  // Owners and the General Manager (company-wide manager) may override the start date.
  const ownerLevel = isOwner || access.grants.some((g) => g.role === "MANAGER" && !g.branch_id);
  const { data: users } = isOwner ? await supabase.from("app_users").select("id, display_name").eq("active", true).order("display_name") : { data: null };
  const isMe = e.app_user_id === access.user_id;
  // Approved personal details (IDs, bank): owners only. RLS enforces the same.
  const { data: det } = isOwner ? await supabase.from("employee_details").select("data, approved_at").eq("employee_id", e.id).maybeSingle() : { data: null };
  // Commission is confidential: only the person and management may open this page.
  if (!isMe && !can(access, ["OWNER", "FINANCE", "HR", "AUDITOR", "MANAGER"], e.branch_id)) notFound();
  const prev = addMonths(start, -1).slice(0, 7), next = addMonths(start, 1).slice(0, 7);

  return (
    <>
      <TopBar access={access} />
      <main>
        {!isMe && <nav className="crumbs"><Link className="back" href="/people">← Employees</Link></nav>}
        <h1>{isMe ? "My commissions" : e.full_name} <Uid v={e.uid} /></h1>
        <p className="muted small">{e.position ?? "Staff"} · {branchName[e.branch_id]} · {e.commission_eligible ? "commission-based" : "not commission-based"}{e.hire_date && ` · started ${new Date(`${e.hire_date}T00:00:00+08:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" })}`}{!e.active && " · inactive"}</p>

        <div className="periods card">
          <div className="segmented">
            <Link href={`/people/${id}?month=${prev}`}>← {monthLabel(prev)}</Link>
            <Link href={`/people/${id}?month=${ym}`} className="on">{monthLabel(ym)}</Link>
            {ym < thisMonth && <Link href={`/people/${id}?month=${next}`}>{monthLabel(next)} →</Link>}
          </div>
        </div>

        <div className="grid">
          {isMe ? (
            <>
              <div className="card stat hero"><Reveal label={`Approved commission, ${monthLabel(ym)}`} note="This is what goes to payroll">{centsToPhp(approved)}</Reveal></div>
              <div className="card stat"><Reveal label="Waiting sign-off" note="Counts once a manager approves">{centsToPhp(pending)}</Reveal></div>
            </>
          ) : (
            <>
              <div className="card stat hero"><div className="label">Approved commission, {monthLabel(ym)}</div><div className="value">{centsToPhp(approved)}</div><div className="note">This is what goes to payroll</div></div>
              <div className="card stat"><div className="label">Waiting sign-off</div><div className="value">{centsToPhp(pending)}</div><div className="note">Counts once a manager approves</div></div>
            </>
          )}
          <div className="card stat"><div className="label">By type (approved)</div>
            <dl className="kv" style={{ borderTop: 0, paddingTop: 0, marginTop: 6 }}>
              <dt>Lead</dt><dd>{centsToPhp(byRole("LEAD"))}</dd>
              <dt>Assist</dt><dd>{centsToPhp(byRole("ASSIST"))}</dd>
              <dt>Solo</dt><dd>{centsToPhp(byRole("SOLO"))}</dd>
            </dl>
          </div>
        </div>

        <h2>Commission lines</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Service</th><th className="num">Commission</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={l.service_logs.state === "REJECTED" ? "rejected" : undefined}>
                  <td>{l.service_logs.service_date}</td>
                  <td>{l.service_logs.services?.name}<div className="small muted">{branchName[l.service_logs.branch_id]} · paid {centsToPhp(l.service_logs.amount_paid_cents)}</div></td>
                  <td className="num"><strong>{centsToPhp(l.amount_cents)}</strong></td>
                  <td><span className={`tag ${l.role}`}>{ROLE_TEXT[l.role]}</span></td>
                  <td><span className={`pill ${l.service_logs.state === "APPROVED" ? "PUBLISHED" : l.service_logs.state === "REJECTED" ? "REVERSED" : "STAGED"}`}>{l.service_logs.state === "APPROVED" ? "Approved" : l.service_logs.state === "REJECTED" ? "Rejected" : "Waiting"}</span></td>
                </tr>
              ))}
              {lines.length === 0 && <tr><td colSpan={5} className="muted">No commission in {monthLabel(ym)}.</td></tr>}
            </tbody>
          </table>
        </div>

        {isOwner && (
          <details className="card">
            <summary><strong>Personal, government and payroll details</strong> <span className="small muted">
              {det ? `approved ${String(det.approved_at).slice(0, 10)} · owners only` : "not sent or not approved yet"}</span></summary>
            {det ? <DetailsView data={det.data as Details} /> : <p className="small muted">They fill these in from their Home page. Review them under Staff details.</p>}
          </details>
        )}
        {ownerLevel && (
          <div className="card">
            <h2>Start date</h2>
            <StartDateForm id={e.id} date={e.hire_date} />
          </div>
        )}
        {canEdit && !isMe && (
          <div className="card">
            <h2>Edit details</h2>
            <EmployeeForm branches={branchesFor(access, branches, ["OWNER", "HR", "MANAGER"]).map((b) => ({ id: b.id, name: b.name }))}
              logins={users ? users.map((u) => ({ id: u.id, name: u.display_name })) : null} employee={e} />
          </div>
        )}
      </main>
    </>
  );
}
