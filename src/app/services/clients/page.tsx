import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { Uid } from "@/components/Uid";

type Row = { id: string; log_no: string | null; old_log_no?: string | null; client_name: string | null; service_date: string; branch_id: string | null; session_no: number | null; visit_kind: string | null;
  amount_paid_cents: number; state: string; performer_id: string | null; assistant_id: string | null; services: { name: string } | null };
const day = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const STATE: Record<string, [string, string]> = { APPROVED: ["Approved", "PUBLISHED"], PENDING: ["Waiting", "STAGED"], REJECTED: ["Rejected", "REVERSED"] };

/** Geraldine's list (Nov 27): find a client's entries on every date, to backtrack their record. */
export default async function ClientSearch({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const like = q.replace(/[%_*\\,()."':]/g, " ").trim().split(" ").filter(Boolean).join("*");
  const { data } = like.length >= 2
    ? await supabase.from("service_logs").select("id, log_no, old_log_no, client_name, service_date, branch_id, session_no, visit_kind, amount_paid_cents, state, performer_id, assistant_id, services(name)")
      .or(`client_name.ilike.*${like}*,log_no.ilike.*${like}*,old_log_no.ilike.*${like}*`).order("service_date", { ascending: false }).order("created_at", { ascending: false }).limit(300)
    : { data: [] };
  const rows = (data ?? []) as unknown as Row[];
  const ids = [...new Set(rows.flatMap((r) => [r.performer_id, r.assistant_id]).filter(Boolean))] as string[];
  const { data: emps } = ids.length ? await supabase.from("employees").select("id, full_name").in("id", ids) : { data: [] };
  const who = new Map(((emps ?? []) as { id: string; full_name: string }[]).map((e) => [e.id, e.full_name]));
  const bName = new Map(branches.map((b) => [b.id, b]));
  const clients = new Map<string, Row[]>();
  for (const r of rows) { const k = (r.client_name ?? "No client name").trim(); clients.set(k, [...(clients.get(k) ?? []), r]); }

  return (
    <>
      <TopBar access={access} />
      <main>
        <p><Link href="/services" className="small">← Service log</Link></p>
        <h1>Search clients</h1>
        <form className="card row-buttons" style={{ alignItems: "center" }}>
          <input name="q" defaultValue={q} minLength={2} required placeholder="Client name or SL number" aria-label="Client name or SL number" style={{ flex: "1 1 220px", width: "auto" }} autoFocus={!q} />
          <button className="small">Search</button>
        </form>
        {q && rows.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>No entries found for &ldquo;{q}&rdquo;. Try part of the name, e.g. the surname.</p></div>}
        {rows.length === 300 && <p className="small muted">Showing the latest 300 entries. Type more of the name to narrow it down.</p>}
        {[...clients.entries()].map(([name, list]) => {
          const paid = list.filter((r) => r.state !== "REJECTED").reduce((t, r) => t + Number(r.amount_paid_cents), 0);
          return (
            <div className="card" key={name}>
              <h2>{name} <span className="muted small">({list.length} entr{list.length === 1 ? "y" : "ies"} · {centsToPhp(paid)} paid)</span></h2>
              <ul className="plain-list client-hits">
                {list.map((r) => {
                  const b = r.branch_id ? bName.get(r.branch_id) : null;
                  return (
                    <li key={r.id}>
                      <span><strong>{(r.session_no ?? 1) > 1 && <span className="session-tag">Session {r.session_no}</span>}{r.services?.name ?? "Service"}</strong> <Uid v={r.log_no} />{r.old_log_no && <span className="small muted" style={{ whiteSpace: "nowrap" }}> (old code {r.old_log_no})</span>}
                        <br /><span className="small muted">{day(r.service_date)}{b ? ` · ${b.name}` : ""}{r.performer_id ? ` · by ${who.get(r.performer_id) ?? "staff"}` : ""}{r.assistant_id ? ` + ${who.get(r.assistant_id) ?? "staff"}` : ""}</span></span>
                      <span className="client-hit-end">
                        <span className="num">{(r.visit_kind ?? "PAID") === "PAID" ? centsToPhp(Number(r.amount_paid_cents)) : (r.visit_kind ?? "").replace("_", " ").toLowerCase()}</span>
                        <span className={`pill ${STATE[r.state]?.[1] ?? ""}`}>{STATE[r.state]?.[0] ?? r.state}</span>
                        <Link className="button secondary small" href={`/services?date=${r.service_date}&branch=${b?.code ?? "ALL"}&entry=${r.id}#entry-${r.id}`}>Open</Link>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </main>
    </>
  );
}
