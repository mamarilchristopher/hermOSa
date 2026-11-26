/** Data loaders shared by Sales › Business and My day (server only). */
import type { requireAccess } from "@/lib/access";
import { shortName, type PlanStep } from "@/lib/promoRules";
import { nextDue, type Log, type PromoPart } from "@/lib/promoTrack";

export type Supa = Awaited<ReturnType<typeof requireAccess>>["supabase"];
type PromoRow = { id: string; title: string; state: string; parts: PromoPart[] | null };
type PClient = { id: string; promo_id: string; client_name: string; contact: string | null; branch_id: string; state: string; schedule: PlanStep[] | null };

/** Every row of a query, 1000 at a time (Supabase returns at most 1000 per call). */
export async function every<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; a < 30000; a += 1000) {
    const { data } = await q(a, a + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
export async function chunks<T>(ids: string[], f: (part: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...((await f(ids.slice(i, i + 150))).data ?? []));
  return out;
}


export async function promoDue(supabase: Supa, today: string) {
  const [{ data: pData, error }, { data: cData }] = await Promise.all([
    supabase.from("promos").select("id, title, state, parts").eq("state", "APPROVED"),
    supabase.from("promo_clients").select("id, promo_id, client_name, contact, branch_id, state, schedule").eq("state", "ACTIVE"),
  ]);
  if (error) return null;
  const promos = (pData ?? []) as PromoRow[];
  const clients = (cData ?? []) as PClient[];
  const logs = await chunks<{ promo_client_id: string; service_id: string; service_date: string; session_no: number; amount_paid_cents: number }>(
    clients.map((c) => c.id),
    (ids) => supabase.from("service_logs").select("promo_client_id, service_id, service_date, session_no, amount_paid_cents").in("promo_client_id", ids).neq("state", "REJECTED"),
  );
  const names: Record<string, string> = {};
  for (const p of promos) for (const x of p.parts ?? []) names[x.service_id] = shortName(x.name);
  const title = Object.fromEntries(promos.map((p) => [p.id, p.title]));
  const due = clients.flatMap((c) => {
    const ls: Log[] = logs.filter((l) => l.promo_client_id === c.id).map((l) => ({ service_id: l.service_id, date: l.service_date, n: l.session_no, amount_cents: Number(l.amount_paid_cents) }));
    const next = nextDue(c.schedule ?? [], ls, today);
    return next && next.late >= 0 ? [{ c, next, promo: title[c.promo_id] ?? "Promo" }] : [];
  }).sort((a, b) => b.next.late - a.next.late);
  const active = (id: string) => clients.filter((c) => c.promo_id === id).length;
  return { promos: promos.map((p) => ({ id: p.id, title: p.title, active: active(p.id) })), due, names };
}
