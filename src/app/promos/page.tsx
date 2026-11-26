import { Playfair_Display } from "next/font/google";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { suggest, upcomingSeasons, type Pkg, type SvcStat } from "@/lib/promoRules";
import { PromoBuilder, type SavedPromo, type Svc } from "./PromoBuilder";

const serif = Playfair_Display({ subsets: ["latin"], weight: ["600", "700"], display: "swap" });

type Row = { id: string; name: string; price_cents: number | null; active: boolean; is_meds?: boolean; session_prices?: number[] | null };
type Stat = { service_id: string; recent: number; before: number; recent_cents: number };

/** Sales › Promos (update-0086, CHRIS Nov 27): this week's promo ideas and the builder. Owners and the GM. */
export default async function PromosPage() {
  const { supabase, access } = await requireAccess();
  const allowed = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const today = manilaToday();
  if (!allowed) {
    return (<><TopBar access={access} /><main><h1>Promos</h1><div className="notice info">Only owners and the GM can make promos.</div></main></>);
  }
  const [{ data: svcData }, stats, promos] = await Promise.all([
    supabase.from("services").select("*").eq("active", true).order("name"),
    supabase.rpc("promo_service_stats"),
    supabase.from("promos").select("*").order("created_at", { ascending: false }).limit(60),
  ]);
  if (stats.error?.code === "PGRST202" || promos.error) {
    return (<><TopBar access={access} /><main><h1>Promos</h1><div className="notice info">The owner needs to run update-0086 in Supabase first.</div></main></>);
  }
  await supabase.rpc("promo_week_notice"); // Mondays: one "promo ideas are ready" notice for management
  const by = new Map(((stats.data ?? []) as Stat[]).map((s) => [s.service_id, s]));
  const services: Svc[] = ((svcData ?? []) as Row[])
    .filter((s) => !s.is_meds && (s.price_cents ?? 0) > 0 && !s.session_prices)
    .map((s) => ({ id: s.id, name: s.name, price: s.price_cents ?? 0 }));
  const svcStats: SvcStat[] = services.map((s) => {
    const st = by.get(s.id);
    return { id: s.id, name: s.name, price: s.price, recent: st?.recent ?? 0, before: st?.before ?? 0, recentCents: st?.recent_cents ?? 0 };
  });
  // Existing packages (price 0, payment schedule in session_prices): their total, so a matching bundle is never pricier.
  const pkgs: Pkg[] = ((svcData ?? []) as Row[])
    .filter((s) => Array.isArray(s.session_prices) && s.session_prices.length > 0)
    .map((s) => ({ name: s.name, total: (s.session_prices ?? []).reduce((a, b) => a + Number(b || 0), 0) }));
  const ideas = suggest(svcStats, today, pkgs);
  const seasons = upcomingSeasons(today).map((s) => s.name);
  return (
    <>
      <TopBar access={access} />
      <main className="promos">
        <h1>Promos</h1>
        <p className="muted small">Ideas are worked out from the last 8 weeks of the Service log, slow services and the coming season. Open one, change the sessions with + and −, and the price, captions and post images update as you go. Approving adds the promo to the Service log so staff can log it.</p>
        <PromoBuilder services={services} ideas={ideas} seasons={seasons} today={today} saved={(promos.data ?? []) as SavedPromo[]} serif={serif.style.fontFamily} serifClass={serif.className} pkgs={pkgs} />
      </main>
    </>
  );
}
