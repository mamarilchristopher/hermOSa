import { requireAccess, can, branchesFor, errorText } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { isIsoDate, manilaToday } from "@/lib/dates";

type Row = {
  branch_id: string; branch_code: string; branch_name: string; sales_count: number;
  gross_cents: number; pending_batches: number; has_validated_data: boolean;
};
type Totals = { ok: true; rows: Row[]; total_gross_cents: number; any_validated_data: boolean; basis: string } | { ok: false; error: string };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ start?: string; end?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  const end = isIsoDate(sp.end) ? sp.end : manilaToday();
  const start = isIsoDate(sp.start) ? sp.start : `${Number(end.slice(0, 4)) - 3}-01-01`;

  const consolidated = can(access, ["OWNER", "FINANCE", "AUDITOR"], null);
  const results: Totals[] = [];
  if (consolidated) {
    const { data } = await supabase.rpc("historical_sales_totals", { p_branch: null, p_start: start, p_end: end });
    results.push(data as Totals);
  } else {
    for (const b of branchesFor(access, branches, ["MANAGER", "CASHIER"])) {
      const { data } = await supabase.rpc("historical_sales_totals", { p_branch: b.id, p_start: start, p_end: end });
      results.push(data as Totals);
    }
  }
  const failed = results.find((r) => !r.ok) as { error: string } | undefined;
  const rows = results.flatMap((r) => (r.ok ? r.rows : []));
  const anyData = rows.some((r) => r.has_validated_data);
  const pending = rows.reduce((s, r) => s + Number(r.pending_batches), 0);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>{consolidated ? "Company dashboard" : "Branch dashboard"}</h1>
        <p className="muted small">
          Historical sales · basis: posting date · {start} to {end} (Manila) · validated imports only, reversed batches excluded
        </p>
        <form className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label>From<input type="date" name="start" defaultValue={start} /></label>
          <label>To<input type="date" name="end" defaultValue={end} /></label>
          <button type="submit" className="secondary">Apply</button>
        </form>
        {failed && <div className="notice error">{errorText(failed.error)}</div>}
        {rows.length === 0 && !failed && <div className="notice info">You don't have sales access to any branch yet.</div>}
        {pending > 0 && (
          <div className="notice info">{pending} imported batch{pending > 1 ? "es are" : " is"} waiting for sign-off and not counted below.</div>
        )}
        {rows.length > 0 && (
          <>
            {consolidated && (
              <div className="grid">
                <div className="card stat">
                  <div className="label">All branches</div>
                  <div className="value">{anyData ? centsToPhp(rows.reduce((s, r) => s + Number(r.gross_cents), 0)) : "No validated data"}</div>
                  <div className="note">Sum of the branches below</div>
                </div>
              </div>
            )}
            <div className="grid">
              {rows.map((r) => (
                <div className="card stat" key={r.branch_id}>
                  <div className="label">{r.branch_name}</div>
                  <div className="value">{r.has_validated_data ? centsToPhp(Number(r.gross_cents)) : "No validated data"}</div>
                  <div className="note">
                    {r.has_validated_data ? `${r.sales_count} sales in range` : "Nothing imported and signed off yet"}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}
