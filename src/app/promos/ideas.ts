import type { requireAccess } from "@/lib/access";
import { suggest, type Pkg, type Suggestion, type SvcStat } from "@/lib/promoRules";
import type { Svc } from "./PromoBuilder";

type Row = { id: string; name: string; price_cents: number | null; commission_cents?: number | null; cost_cents?: number | null; active: boolean; is_meds?: boolean; session_prices?: number[] | null };
type Stat = { service_id: string; recent: number; before: number; recent_cents: number };
type Supa = Awaited<ReturnType<typeof requireAccess>>["supabase"];

/** This week's promo ideas, worked out the same way for Sales › Promos and the Business dashboard (CHRIS Nov 27).
 *  missing = update-0086 hasn't been run yet. */
export async function loadIdeas(supabase: Supa, today: string): Promise<{ missing: boolean; services: Svc[]; pkgs: Pkg[]; ideas: Suggestion[] }> {
  const [{ data: svcData }, stats] = await Promise.all([
    supabase.from("services").select("*").eq("active", true).order("name"),
    supabase.rpc("promo_service_stats"),
  ]);
  if (stats.error?.code === "PGRST202") return { missing: true, services: [], pkgs: [], ideas: [] };
  const by = new Map(((stats.data ?? []) as Stat[]).map((s) => [s.service_id, s]));
  const rows = (svcData ?? []) as Row[];
  const services: Svc[] = rows
    .filter((s) => !s.is_meds && (s.price_cents ?? 0) > 0 && !s.session_prices)
    .map((s) => ({ id: s.id, name: s.name, price: s.price_cents ?? 0, commission: s.commission_cents ?? null, cost: s.cost_cents == null ? null : Number(s.cost_cents) }));
  const svcStats: SvcStat[] = services.map((s) => {
    const st = by.get(s.id);
    return { id: s.id, name: s.name, price: s.price, recent: st?.recent ?? 0, before: st?.before ?? 0, recentCents: st?.recent_cents ?? 0 };
  });
  // Existing packages (price 0, payment schedule in session_prices): their total, so a matching bundle is never pricier.
  const pkgs: Pkg[] = rows
    .filter((s) => Array.isArray(s.session_prices) && s.session_prices.length > 0)
    .map((s) => ({ name: s.name, total: (s.session_prices ?? []).reduce((a, b) => a + Number(b || 0), 0) }));
  return { missing: false, services, pkgs, ideas: suggest(svcStats, today, pkgs) };
}
