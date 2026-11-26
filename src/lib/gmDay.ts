/** My day (CHRIS Nov 27): the GM's daily reminders as a sales-driven manager. Gentle nudges with live counts, no
 *  deadlines. Pure logic, unit tested; the page loads the counts. */

export type DayCounts = {
  bookingsToday: number;
  followups: number;          // unresponsive bookings to call or message again
  promoDue: number;           // promo clients due today or late
  picks: number;              // today's promo picks
  drafts: number;             // saved promo drafts (proposals waiting for the owners)
  liveNoBuyers: string[];     // approved promos 14+ days old with no buyers yet
  missingToday: number;       // branches that haven't typed today's sales
  missingYesterday: number;   // branches that never typed yesterday's sales
  pendingSignoff: number;     // Service log entries waiting for sign-off
  pendingPayments: number;    // payment proofs not yet confirmed
  behind: string | null;      // branch behind last month
  needPerDay: number | null;  // ₱ (centavos) a day to beat last month
};

export type Tone = "ok" | "todo" | "warn";
export type DayItem = { key: string; icon: string; title: string; note: string; href?: string; count?: number; tone: Tone };
export type DaySection = { key: string; icon: string; title: string; when: string; items: DayItem[] };

/** Days left until the cutoff ends (the 15th, or the month's last day). */
export function cutoffInfo(today: string): { end: string; daysLeft: number } {
  const [y, m, d] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endDay = d <= 15 ? 15 : last;
  return { end: `${today.slice(0, 8)}${String(endDay).padStart(2, "0")}`, daysLeft: endDay - d };
}
/** Payday is near: the last 3 days of a cutoff (CHRIS: settle pending commissions before payday). */
export const paydayNear = (today: string) => cutoffInfo(today).daysLeft <= 3;

export type StaffFlag = { id: string; name: string; lates: number; lateMin: number; backjobs: number; why: string };
/** Staff who could use a check-in: 3+ lates or 2+ backjobs in the last 28 days. */
export function staffCheckins(people: { id: string; name: string }[], lates: { employee_id: string; late_minutes: number }[],
  backjobs: { performer_id: string }[]): StaffFlag[] {
  const out: StaffFlag[] = [];
  for (const p of people) {
    const ls = lates.filter((l) => l.employee_id === p.id);
    const bj = backjobs.filter((b) => b.performer_id === p.id).length;
    const lateMin = ls.reduce((s, l) => s + Number(l.late_minutes || 0), 0);
    const why = [ls.length >= 3 ? `late ${ls.length}× (${lateMin} min)` : "", bj >= 2 ? `${bj} backjobs` : ""].filter(Boolean).join(" · ");
    if (why) out.push({ id: p.id, name: p.name, lates: ls.length, lateMin, backjobs: bj, why });
  }
  return out.sort((a, b) => b.lates + b.backjobs * 2 - (a.lates + a.backjobs * 2));
}

const tone = (n: number): Tone => (n > 0 ? "todo" : "ok");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function daySections(c: DayCounts, ctx: { payday: boolean; weak: boolean; weekdayName: string }): DaySection[] {
  const pesos = (cents: number) => `₱${Math.round(cents / 100).toLocaleString("en-PH")}`;
  return [
    {
      key: "morning", icon: "☀️", title: "Morning", when: "Before opening",
      items: [
        { key: "numbers", icon: "📊", title: "Read today's numbers", href: "/business", tone: c.behind ? "warn" : "ok",
          note: [c.needPerDay ? `${pesos(c.needPerDay)} a day beats last month` : "On pace with last month", c.behind ? `${c.behind} is behind: focus there first` : ""].filter(Boolean).join(" · ") },
        { key: "bookings", icon: "📅", title: "Check today's bookings", href: "/bookings", count: c.bookingsToday, tone: ctx.weak ? "warn" : "ok",
          note: ctx.weak ? `${ctx.weekdayName} is usually slow: have CSRs fill empty slots` : `${plural(c.bookingsToday, "booking")} today` },
        { key: "outage", icon: "🛠️", title: "Anything down?", href: "/chat", tone: "ok",
          note: "Machine, product, power, internet or the app: tell the owners in Chat right away" },
        { key: "upsell", icon: "✨", title: "Brief the team on today's upsell", tone: "ok",
          note: ctx.payday ? "Payday: offer year programs and prepaid packages" : "One add-on and one package to offer every client" },
      ],
    },
    {
      key: "midday", icon: "🕐", title: "Midday", when: "Between clients",
      items: [
        { key: "followups", icon: "📞", title: "Follow up booking leads", href: "/bookings/followups", count: c.followups, tone: tone(c.followups),
          note: c.followups ? `${plural(c.followups, "client")} didn't reply or didn't show` : "All caught up" },
        { key: "promoDue", icon: "💬", title: "Message promo clients who are due", href: "/business", count: c.promoDue, tone: tone(c.promoDue),
          note: c.promoDue ? `${plural(c.promoDue, "client")} due today or late` : "No one due today" },
        { key: "upsellCheck", icon: "🧾", title: "Check upsells are being logged", href: "/services", tone: "ok",
          note: "Coach anyone only selling single sessions" },
      ],
    },
    {
      key: "promos", icon: "📈", title: "Promos", when: "Daily",
      items: [
        { key: "picks", icon: "🎯", title: "Check today's promo picks", href: "/business", count: c.picks, tone: c.picks ? "todo" : "ok",
          note: ctx.payday ? "Payday: year programs are on top" : "Ranked for today, each with its reason" },
        { key: "propose", icon: "📨", title: "Propose one to the owners", href: "/promos", count: c.drafts || undefined, tone: c.drafts ? "warn" : "ok",
          note: c.drafts ? `${plural(c.drafts, "draft")} waiting for the owners' OK` : "Save it, then send the photo and \"Why this price\" in Chat" },
        { key: "launch", icon: "🚀", title: "Launch approved promos", href: "/promos", tone: c.liveNoBuyers.length ? "warn" : "ok",
          note: c.liveNoBuyers.length ? `No buyers yet after 2 weeks: ${c.liveNoBuyers.slice(0, 2).join(", ")}. Post again or end it` : "Approve, post, and send to the CSRs" },
      ],
    },
    {
      key: "closing", icon: "🌙", title: "Closing", when: "Before 7 PM",
      items: [
        { key: "sales", icon: "💰", title: "Every branch typed today's sales", href: "/sales/daily", count: c.missingToday + c.missingYesterday, tone: c.missingYesterday ? "warn" : tone(c.missingToday),
          note: c.missingYesterday ? `Yesterday is missing for ${plural(c.missingYesterday, "branch", "branches")}` : c.missingToday ? `${plural(c.missingToday, "branch", "branches")} still to type today` : "All typed" },
        { key: "signoff", icon: "✅", title: "Sign off the Service log", href: "/services", count: c.pendingSignoff, tone: tone(c.pendingSignoff),
          note: c.pendingSignoff ? `${plural(c.pendingSignoff, "entry", "entries")} waiting` : "Nothing waiting" },
        { key: "payments", icon: "🏦", title: "Confirm payment proofs", href: "/clinic/payments", count: c.pendingPayments, tone: tone(c.pendingPayments),
          note: c.pendingPayments ? `${plural(c.pendingPayments, "transfer")} to confirm` : "All confirmed" },
      ],
    },
  ];
}

/** Share of items that need nothing more (green), for the ring on top. */
export function doneShare(sections: DaySection[], ticked: Set<string>): { done: number; total: number } {
  const items = sections.flatMap((s) => s.items);
  return { done: items.filter((i) => ticked.has(i.key)).length, total: items.length };
}

// ---------- Today's add-on idea (CHRIS Nov 27) ----------
/** CHRIS: "Daily add-on promo discount Geraldine asks management to approve, with its justification. Busy days: make the
 *  most of the foot traffic. Slow days: get the most value out of the few clients there." */
export type AddonSvc = { name: string; price: number; cost: number | null; sold28: number };
export type MainSvc = { name: string; count: number; price: number };
export type AddonIdea = {
  day: "busy" | "slow" | "normal"; title: string; offer: string; chips: string[]; why: string[]; ask: string;
};
const roundDown50 = (cents: number) => Math.max(0, Math.floor(cents / 5000) * 5000);
const php = (cents: number) => `₱${Math.round(cents / 100).toLocaleString("en-PH")}`;

export function addonIdea(o: {
  weekdayName: string; busy: boolean; slow: boolean; payday: boolean;
  clientsToday: number;          // usual paid treatments on this weekday (average)
  addons: AddonSvc[];            // services marked as add-ons
  top: MainSvc[];                // best sellers on this weekday, most first
  attach: number;                // share of treatments that already get an add-on (0-1)
}): AddonIdea | null {
  const addon = [...o.addons].filter((a) => a.price > 0).sort((a, b) => b.sold28 - a.sold28 || a.price - b.price)[0];
  if (!addon) return null;
  const main = o.top[0]?.name ?? "any treatment";
  const n = Math.max(1, Math.round(o.clientsToday));
  const marginOf = (price: number) => (addon.cost !== null ? price - addon.cost : null);
  const day: AddonIdea["day"] = o.busy ? "busy" : o.slow ? "slow" : "normal";
  if (day === "slow") {
    // Few clients: lift each ticket. A free add-on only with a package (or a 2nd service) costs little and sells the big ticket.
    const extra = addon.cost ?? Math.round(addon.price * 0.3);
    return {
      day, title: `Free ${addon.name} with any package today`,
      offer: `Any client who buys a package today (e.g. ${main} 10+3) gets a free ${addon.name}. Clients doing a single session can add a second service at 15% off.`,
      chips: [`📉 ${o.weekdayName} is usually slow`, `~${n} clients expected`, `Costs us about ${php(extra)} per package`],
      why: [
        `${o.weekdayName}s average about ${n} paid treatments, so the goal is a bigger ticket per client, not more clients.`,
        `A package is worth many single visits and brings the client back; giving away one ${addon.name} (${php(addon.price)} on the price list${addon.cost !== null ? `, about ${php(addon.cost)} in product` : ""}) is a small cost for that.`,
        `Chairs are free, so a second service at 15% off uses time that is already paid for (staff are on duty anyway).`,
        `No change to package prices, so it doesn't undercut anyone who bought earlier.`,
      ],
      ask: `Hi po! For today (${o.weekdayName}, usually slow): free ${addon.name} for any client who buys a package, and 15% off a second service for single-session clients. Goal: bigger ticket per client while the chairs are free. Cost: about ${php(extra)} per package sold. OK to run today?`,
    };
  }
  // Busy or normal: many clients, so a small, quick add-on discount for everyone. Volume does the work.
  const pct = day === "busy" ? 0.1 : 0.15;
  const promo = roundDown50(Math.round(addon.price * (1 - pct)));
  const save = addon.price - promo;
  const lift = Math.max(0.15, Math.min(0.35, o.attach + 0.1));
  const takers = Math.max(1, Math.round(n * lift));
  const m = marginOf(promo);
  return {
    day, title: `${addon.name} add-on for ${php(promo)} today`,
    offer: `Add ${addon.name} to any ${main} (or any treatment) today for ${php(promo)} instead of ${php(addon.price)}.${o.payday ? " It's payday: offer the package upgrade first, then the add-on." : ""}`,
    chips: [day === "busy" ? `🔥 ${o.weekdayName} is usually busy` : `${o.weekdayName}: a normal day`, `~${n} clients expected`, `${php(save)} off each`],
    why: [
      `${o.weekdayName}s average about ${n} paid treatments. If ${takers} of them say yes (about ${Math.round(lift * 100)}%), that's about ${php(promo * takers)} extra today.`,
      `It's quick (done with the same visit), so it adds sales without needing extra slots on a full day.`,
      `Only ${Math.round(pct * 100)}% off: the foot traffic does the work, so a small discount is enough.${m !== null ? ` We still keep about ${php(m)} per add-on after product.` : ""}`,
      `Commission is the usual 5% of what the client pays for the add-on.`,
    ],
    ask: `Hi po! For today (${o.weekdayName}, ${day === "busy" ? "usually busy" : "a normal day"}): ${addon.name} add-on for ${php(promo)} instead of ${php(addon.price)} with any treatment. About ${n} clients expected; if ${takers} say yes that's about ${php(promo * takers)} extra. OK to run today?`,
  };
}
