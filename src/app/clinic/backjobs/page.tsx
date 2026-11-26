import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { addDays } from "@/lib/insights";
import { adName } from "@/lib/promoRules";
import { caseStatus, clientKey, daysBetween, isClosed, rate, reasonText, sortCases, tally, topReason, type BackjobRow } from "@/lib/backjobs";
import { every } from "../../business/load";
import { Retag } from "./Retag";
import { CaseUpdate } from "./CaseUpdate";

type Log = { id: string; service_date: string; client_name: string | null; service_id: string; performer_id: string; branch_id: string };
type Case = { id: string; client_name: string; branch_id: string | null; service_id: string | null; staff_id: string | null; status: string;
  resolution: string | null; refund_cents: number | null; opened_on: string; closed_on: string | null };
type Tag = { service_log_id: string; staff_id: string | null; reason: string | null; original_log_id: string | null };

const DAYS = 90;
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "UTC" });
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

/** Backjobs (update-0088, CHRIS Nov 27): which staff, clients and services get backjobs most, and why. Owners and the GM. */
export default async function Backjobs() {
  const { supabase, access, branches } = await requireAccess();
  if (!(can(access, ["OWNER"], null) || can(access, ["MANAGER"], null))) redirect("/me");
  const today = manilaToday();
  const from = addDays(today, -(DAYS - 1));

  const [bjs, paid, tagRes, { data: svcData }, { data: empData }] = await Promise.all([
    every<Log>((a, b) => supabase.from("service_logs").select("id, service_date, client_name, service_id, performer_id, branch_id")
      .eq("visit_kind", "BACKJOB").gte("service_date", from).lte("service_date", today).neq("state", "REJECTED").order("service_date", { ascending: false }).order("id").range(a, b)),
    every<{ performer_id: string }>((a, b) => supabase.from("service_logs").select("performer_id")
      .eq("visit_kind", "PAID").gte("service_date", from).lte("service_date", today).neq("state", "REJECTED").order("id").range(a, b)),
    supabase.from("backjob_tags").select("service_log_id, staff_id, reason, original_log_id"),
    supabase.from("services").select("id, name"),
    supabase.from("employees").select("id, full_name, active, position").order("full_name"),
  ]);
  // update-0090: cases per client. Open ones whatever their age, closed ones from the same 90 days.
  const caseRes = await supabase.from("backjob_cases").select("id, client_name, branch_id, service_id, staff_id, status, resolution, refund_cents, opened_on, closed_on")
    .or(`status.in.(OPEN,IN_PROGRESS),closed_on.gte.${from}`).order("opened_on", { ascending: false }).limit(300);
  const casesMissing = !!caseRes.error;
  const cases = sortCases((caseRes.data ?? []) as Case[]);
  const { data: caseTags } = !casesMissing && cases.length ? await supabase.from("backjob_tags").select("service_log_id, case_id").in("case_id", cases.map((c) => c.id)) : { data: [] };
  const visits = new Map<string, number>();
  for (const t of (caseTags ?? []) as { case_id: string }[]) visits.set(t.case_id, (visits.get(t.case_id) ?? 0) + 1);
  const caseOfLog = new Map(((caseTags ?? []) as { service_log_id: string; case_id: string }[]).map((t) => [t.service_log_id, t.case_id]));
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const openCases = cases.filter((c) => !isClosed(c.status));
  const closedCases = cases.filter((c) => isClosed(c.status));
  const refunded = closedCases.reduce((n, c) => n + (c.status === "REFUNDED" ? c.refund_cents ?? 0 : 0), 0);
  const tagsMissing = !!tagRes.error;
  const tags = new Map(((tagRes.data ?? []) as Tag[]).map((t) => [t.service_log_id, t]));
  const svc = Object.fromEntries(((svcData ?? []) as { id: string; name: string }[]).map((s) => [s.id, adName(s.name)]));
  const emps = (empData ?? []) as { id: string; full_name: string; active: boolean; position: string | null }[];
  const ename = Object.fromEntries(emps.map((e) => [e.id, e.full_name]));
  const people = emps.filter((e) => e.active && !/general\s*manager|\bcsr\b/i.test(e.position ?? "")).map((e) => ({ id: e.id, name: e.full_name }));
  const bName = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  // Who is responsible: the tag's staff (who did the first treatment), else whoever did the backjob.
  const rows: (BackjobRow & { log: Log; tagged: boolean })[] = bjs.map((l) => {
    const t = tags.get(l.id);
    return { id: l.id, date: l.service_date, client: (l.client_name ?? "").trim(), serviceId: l.service_id, staffId: t?.staff_id ?? (tagsMissing ? l.performer_id : null), reason: t?.reason ?? null, log: l, tagged: !!t };
  });
  const treatments = new Map<string, number>();
  for (const p of paid) treatments.set(p.performer_id, (treatments.get(p.performer_id) ?? 0) + 1);
  const byStaff = tally(rows, (r) => r.staffId);
  const byClient = tally(rows, (r) => clientKey(r.client) || null).filter((t) => t.count >= 2);
  const byService = tally(rows, (r) => r.serviceId);
  const clientName = new Map(rows.map((r) => [clientKey(r.client), r.client]));
  const overall = tally(rows, () => "all")[0];
  const allRate = rate(rows.length, paid.length);
  const maxStaff = Math.max(1, ...byStaff.map((t) => t.count));
  const unknown = rows.filter((r) => !r.staffId).length;

  return (
    <>
      <TopBar access={access} />
      <main className="backjobs">
        <div className="biz-head"><h1>Backjobs</h1><span className="muted">Last {DAYS} days · all branches</span></div>
        {tagsMissing && <div className="notice warn">Linking each backjob to the first treatment and its staff starts once the owner runs database update-0088. Until then this page counts backjobs under whoever did the backjob.</div>}

        <div className="biz-kpis">
          <div className="card biz-kpi"><div className="label">Backjobs</div><div className="value">{rows.length}</div><div className="sub muted">{paid.length} paid treatments</div></div>
          <div className="card biz-kpi"><div className="label">Backjob rate</div><div className="value">{pct(allRate)}</div><div className="sub muted">of paid treatments</div></div>
          <div className="card biz-kpi"><div className="label">Top reason</div><div className="value bj-reason-val">{overall ? topReason(overall) || "Not given" : "–"}</div></div>
          <div className="card biz-kpi"><div className="label">Open cases</div><div className="value">{casesMissing ? "–" : openCases.length}</div><div className="sub muted">{casesMissing ? "after update-0090" : `${closedCases.length} closed · ${byClient.length} repeat client${byClient.length === 1 ? "" : "s"}`}</div></div>
        </div>

        {casesMissing ? (
          <div className="notice warn">Cases per client (status, what was done, closing by fix, refund or quitclaim) start once the owner runs database update-0090.</div>
        ) : (
          <div className="card">
            <h2>Cases per client <small>{openCases.length} open</small></h2>
            {cases.length === 0 && <p className="small muted">No cases yet. A case opens with a client&apos;s first backjob for a treatment.</p>}
            <div className="bj-cases">
              {cases.map((c) => {
                const st = caseStatus(c.status);
                const waited = daysBetween(c.opened_on, c.closed_on ?? today);
                return (
                  <div key={c.id} className={`bj-case${st.closed ? " closed" : ""}`}>
                    <div className="bj-case-top">
                      <b className="bj-case-client">{c.client_name}</b>
                      <span className={`chg ${st.tone}`}>{st.label}</span>
                    </div>
                    <div className="small">{(c.service_id && svc[c.service_id]) || "Service"} · First treatment: <b>{c.staff_id ? ename[c.staff_id] ?? "Staff" : "not found"}</b>{c.branch_id && bName[c.branch_id] ? ` · ${bName[c.branch_id]}` : ""}</div>
                    <div className="small muted">
                      {visits.get(c.id) ?? 0} backjob visit{(visits.get(c.id) ?? 0) === 1 ? "" : "s"} · opened {short(c.opened_on)}
                      {st.closed ? ` · closed ${c.closed_on ? short(c.closed_on) : ""} after ${waited} day${waited === 1 ? "" : "s"}` : ` · open ${waited} day${waited === 1 ? "" : "s"}`}
                      {c.status === "REFUNDED" && c.refund_cents ? ` · ₱${(c.refund_cents / 100).toLocaleString("en-PH")} refunded` : ""}
                    </div>
                    {c.resolution && <div className="bj-case-note small">{c.resolution}</div>}
                    <CaseUpdate id={c.id} status={c.status} resolution={c.resolution} refund={c.refund_cents} />
                  </div>
                );
              })}
            </div>
            {refunded > 0 && <p className="small muted">Refunds in the last {DAYS} days: ₱{(refunded / 100).toLocaleString("en-PH")}.</p>}
          </div>
        )}

        <div className="biz-row">
          <div className="card">
            <h2>By staff <small>who did the first treatment</small></h2>
            {byStaff.length === 0 && <p className="small muted">No backjobs in the last {DAYS} days.</p>}
            <div className="barrows">
              {byStaff.map((t) => {
                const r = rate(t.count, treatments.get(t.key) ?? 0);
                return (
                  <div className="br-row" key={t.key} title={`${ename[t.key] ?? "Staff"}: ${t.count} backjobs`}>
                    <span className="br-name"><a href={`/people/${t.key}`}>{ename[t.key] ?? "Staff"}</a></span>
                    <span className="br-track"><i className="growx" style={{ width: `${(t.count / maxStaff) * 100}%` }} /></span>
                    <b className="br-val">{t.count}</b>
                    <span className="br-pill"><span className={`chg ${r !== null && allRate !== null && r > allRate * 1.5 ? "down" : "neu"}`}>{pct(r)}</span></span>
                  </div>
                );
              })}
            </div>
            {unknown > 0 && <p className="small muted">{unknown} backjob{unknown === 1 ? "" : "s"} with no first treatment found: tap Change below to set the staff.</p>}
            <p className="small muted">The % is backjobs ÷ paid treatments they led (shown from 5 treatments). Red = well above the clinic&apos;s rate: a good time for a check-in or a refresher.</p>
          </div>
          <div className="card">
            <h2>Clients with repeat issues <small>2+ backjobs</small></h2>
            {byClient.length === 0 && <p className="small muted">No client has had more than one backjob.</p>}
            <ul className="bj-list">
              {byClient.slice(0, 12).map((t) => (
                <li key={t.key}><b>{clientName.get(t.key)}</b><span className="chg down">{t.count}×</span><span className="small muted">{topReason(t) || "Reason not given"} · last {short(t.last)}</span></li>
              ))}
            </ul>
          </div>
        </div>

        <div className="biz-row">
          <div className="card">
            <h2>By service</h2>
            <ul className="bj-list">
              {byService.slice(0, 10).map((t) => (
                <li key={t.key}><b>{svc[t.key] ?? "Service"}</b><span className="chg neu">{t.count}</span><span className="small muted">{topReason(t) || "Reason not given"}</span></li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h2>Why <small>what needed fixing</small></h2>
            <ul className="bj-list">
              {overall && Object.entries(overall.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                <li key={k}><b>{k === "NONE" ? "Not given" : reasonText(k)}</b><span className="chg neu">{n}</span></li>
              ))}
            </ul>
          </div>
        </div>

        <div className="card">
          <h2>Recent backjobs</h2>
          {rows.length === 0 && <p className="small muted">None in the last {DAYS} days.</p>}
          <div className="bj-recent">
            {rows.slice(0, 60).map((r) => (
              <div key={r.id} className="bj-row">
                <span className="bj-date">{short(r.date)}</span>
                <span className="bj-main"><b>{r.client || "Client"}</b> · {svc[r.serviceId] ?? "Service"}<span className="small muted"> · {bName[r.log.branch_id] ?? ""}</span></span>
                <span className="bj-who small">First treatment: <b>{r.staffId ? ename[r.staffId] ?? "Staff" : "not found"}</b> · {reasonText(r.reason)}
                  {(() => { const c = caseById.get(caseOfLog.get(r.id) ?? ""); return c ? <> · <span className={`chg ${caseStatus(c.status).tone}`}>{caseStatus(c.status).label}</span></> : null; })()}</span>
                {!tagsMissing && <Retag log={r.id} staff={r.staffId} reason={r.reason} people={people} />}
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
