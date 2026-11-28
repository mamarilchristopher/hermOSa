// v0.99.3 (CHRIS Nov 28): from Nov 25 each day's sales come from the APPROVED Service log entries of that service date.
// Entries signed off later (e.g. a branch that couldn't log during an internet outage and declares the next day) fill the
// right day automatically. v0.101.2: those totals win over a typed figure (cellOf). Pending entries are counted separately.
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVICE_LOG_FROM, type StatusDay } from "./homeGlance";

/** daily_sales_status rows with the service log field (index 5) = approved total, plus index 6 = still waiting sign-off. */
export async function withApprovedSales(supabase: SupabaseClient, days: StatusDay[], end: string): Promise<StatusDay[]> {
  const from = SERVICE_LOG_FROM;
  if (end < from) return days;
  const approved = new Map<string, number>(), pending = new Map<string, number>();
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabase.from("service_logs").select("id, branch_id, service_date, amount_paid_cents, state")
      .gte("service_date", from).lte("service_date", end).neq("state", "REJECTED")
      .order("id").range(page * 1000, page * 1000 + 999);
    if (error || !data) return days; // fall back to the RPC's figures rather than blank the page
    for (const l of data as { branch_id: string | null; service_date: string; amount_paid_cents: number | string; state: string }[]) {
      if (!l.branch_id) continue;
      const k = `${l.branch_id}|${l.service_date}`;
      const m = l.state === "APPROVED" ? approved : pending;
      m.set(k, (m.get(k) ?? 0) + Number(l.amount_paid_cents ?? 0));
    }
    if (data.length < 1000) break;
  }
  const seen = new Set<string>();
  const out = days.map((r): StatusDay => {
    if (r[1] < from) return r;
    const k = `${r[0]}|${r[1]}`; seen.add(k);
    return [r[0], r[1], r[2], r[3], r[4], approved.has(k) ? approved.get(k)! : null, pending.get(k) ?? null];
  });
  return out;
}
