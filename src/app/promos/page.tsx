import { Playfair_Display } from "next/font/google";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { upcomingSeasons } from "@/lib/promoRules";
import { PromoBuilder, type SavedPromo } from "./PromoBuilder";
import { loadIdeas } from "./ideas";

const serif = Playfair_Display({ subsets: ["latin"], weight: ["600", "700"], display: "swap" });

/** Sales › Promos (update-0086, CHRIS Nov 27): this week's promo ideas and the builder. Owners and the GM. */
export default async function PromosPage({ searchParams }: { searchParams: Promise<{ idea?: string }> }) {
  const { idea } = await searchParams;
  const { supabase, access } = await requireAccess();
  const allowed = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const today = manilaToday();
  if (!allowed) {
    return (<><TopBar access={access} /><main><h1>Promos</h1><div className="notice info">Only owners and the GM can make promos.</div></main></>);
  }
  const [{ missing, services, pkgs, ideas }, promos] = await Promise.all([
    loadIdeas(supabase, today),
    supabase.from("promos").select("*").order("created_at", { ascending: false }).limit(60),
  ]);
  if (missing || promos.error) {
    return (<><TopBar access={access} /><main><h1>Promos</h1><div className="notice info">The owner needs to run update-0086 in Supabase first.</div></main></>);
  }
  await supabase.rpc("promo_week_notice"); // Mondays: one "promo ideas are ready" notice for management
  // update-0087: clients per promo (none before the update).
  const { data: pcData } = await supabase.from("promo_clients").select("promo_id, state");
  const clientCount: Record<string, { active: number; all: number }> = {};
  for (const c of (pcData ?? []) as { promo_id: string; state: string }[]) {
    const x = (clientCount[c.promo_id] ??= { active: 0, all: 0 });
    if (c.state !== "CANCELLED") x.all++;
    if (c.state === "ACTIVE") x.active++;
  }
  const seasons = upcomingSeasons(today).map((s) => s.name);
  return (
    <>
      <TopBar access={access} />
      <main className="promos">
        <h1>Promos</h1>
        <p className="muted small">Ideas are worked out from the last 8 weeks of the Service log, slow services and the coming season. Open one, change the sessions with + and −, and the price, captions and post images update as you go. Approving adds the promo to the Service log with its per-session commission; each client who buys it gets a recommended schedule, and the promo&apos;s page tracks their sessions and the running profit.</p>
        <PromoBuilder services={services} ideas={ideas} seasons={seasons} today={today} saved={(promos.data ?? []) as SavedPromo[]} serif={serif.style.fontFamily} serifClass={serif.className} pkgs={pkgs} clients={clientCount} initialIdea={idea} />
      </main>
    </>
  );
}
