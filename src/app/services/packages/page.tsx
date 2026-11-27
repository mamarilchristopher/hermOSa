import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { sortServices } from "@/lib/serviceOrder";
import { allPackageRecords, clientKey, type PackageLine } from "@/lib/packages";

const day = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });

/**
 * CHRIS Nov 27: package clients. Each client's record per package starts at the earliest session logged in Hermosapp
 * (session 2 if they did session 1 before) and follows it onward. Prices per session aren't preset: what each client
 * paid is what was logged (and approved with the entry).
 */
export default async function PackageClients({ searchParams }: { searchParams: Promise<{ q?: string; p?: string }> }) {
  const { supabase, access } = await requireAccess();
  const sp = await searchParams;
  const { data: svcs } = await supabase.from("services").select("*").order("name");
  const bundles = sortServices(((svcs ?? []) as { id: string; name: string; active: boolean; session_prices?: unknown }[])
    .filter((s) => Array.isArray(s.session_prices) && (s.session_prices as unknown[]).length));
  const size = new Map(bundles.map((b) => [b.id, (b.session_prices as unknown[]).length]));
  const { data: rows } = bundles.length
    ? await supabase.from("service_logs").select("client_name, service_id, session_no, service_date, amount_paid_cents, branch_id")
      .in("service_id", bundles.map((b) => b.id)).neq("state", "REJECTED").not("client_name", "is", null).limit(10000)
    : { data: [] };
  const lines: PackageLine[] = ((rows ?? []) as { client_name: string; service_id: string; session_no: number | null; service_date: string; amount_paid_cents: number; branch_id: string | null }[])
    .map((r) => ({ client: r.client_name, service: r.service_id, session: r.session_no ?? 1, date: r.service_date, amount: Number(r.amount_paid_cents), branch: r.branch_id }));
  const q = clientKey(sp.q ?? "");
  const pick = bundles.find((b) => b.id === sp.p)?.id ?? "";
  const records = allPackageRecords(lines).filter((r) => (!q || clientKey(r.client).includes(q)) && (!pick || r.service === pick));
  const shown = bundles.filter((b) => records.some((r) => r.service === b.id));

  return (
    <>
      <TopBar access={access} />
      <main>
        <p><Link href="/services" className="small">← Service log</Link></p>
        <h1>Package clients</h1>
        <p className="muted small">Each client&apos;s sessions of a package, starting from the earliest session logged in Hermosapp. Sessions have no preset price: the amount is what the client paid, as logged and approved.</p>
        <form className="card row-buttons" style={{ alignItems: "center" }}>
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search a client" style={{ flex: "1 1 180px", width: "auto" }} aria-label="Search a client" />
          <select name="p" defaultValue={pick} aria-label="Package" style={{ flex: "1 1 180px", width: "auto" }}>
            <option value="">All packages</option>
            {bundles.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="small">Show</button>
        </form>
        {records.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>No package sessions logged yet{q || pick ? " for this search" : ""}.</p></div>}
        {shown.map((b) => {
          const list = records.filter((r) => r.service === b.id);
          const n = size.get(b.id) ?? 0;
          return (
            <div className="card" key={b.id}>
              <h2>{b.name} <span className="muted small">({list.length} client{list.length === 1 ? "" : "s"})</span></h2>
              <div className="table-wrap">
                <table className="glance-table pkg-table">
                  <thead><tr><th>Client</th><th>Started at</th><th>Sessions logged</th><th>Next</th><th className="num">Paid so far</th><th>Last visit</th></tr></thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={`${r.service}-${r.client}`}>
                        <td><strong>{r.client}</strong></td>
                        <td className="nowrap" data-l="Started at">Session {r.start}<br /><span className="small muted">{day(r.startDate)}</span></td>
                        <td data-l="Sessions logged">{r.done.join(", ")}<br /><span className="small muted">{r.done.length} of {n - r.start + 1} since session {r.start}</span></td>
                        <td className="nowrap" data-l="Next">{r.last < n ? `Session ${r.last + 1}` : <span className="pill PUBLISHED">Complete</span>}</td>
                        <td className="num" data-l="Paid so far">{centsToPhp(r.paid)}</td>
                        <td className="nowrap" data-l="Last visit">{day(r.lastDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </main>
    </>
  );
}
