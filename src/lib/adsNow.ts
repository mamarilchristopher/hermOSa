/**
 * "Running now" on Business › Ads (v0.100.3, CHRIS Nov 28: "the current state of ads ... Main QC - Hiko - Women only 5k /
 * gluta 2k / men Hiko 500 ... depends on the actual current latest data of the ads we have running").
 * Built from the advisor's live ad sets: per branch, each service + audience with its daily budget (before VAT, what's
 * typed in Ads Manager) and last week's spend (with VAT).
 */
import { BRANCH_ORDER, type LineView, type Targeting } from "./adsAdvisor";
import { SERVICE_LABEL } from "./ads";

export type Audience = { key: string; label: string; warn: boolean };
/** Who an ad set reaches, in CHRIS's words. Advantage+ with women is only a suggestion, so men still see it. */
export function audienceOf(t: Targeting | null): Audience {
  if (!t) return { key: "unknown", label: "Audience unread", warn: false };
  const age = t.advantage && t.ageSuggest ? `${t.ageSuggest[0]}–${t.ageSuggest[1]}` : `${t.ageMin ?? 18}–${t.ageMax ?? 65}`;
  if (t.genders === "men") return { key: `men|${age}`, label: `Men only · ${age}`, warn: false };
  if (t.genders === "women" && !t.advantage) return { key: `women|${age}`, label: `Women only · ${age}`, warn: false };
  if (t.genders === "women") return { key: `womenadv|${age}`, label: `Women, Advantage+ (men still see it) · ${age}`, warn: true };
  return { key: `all|${age}`, label: `All genders · ${age}`, warn: true };
}

export type NowItem = {
  service: string; audience: Audience; budget: number; budgetSource: "adset" | "campaign" | "none" | "mixed";
  spend7: number; chats7: number; sets: { id: string; name: string; campaign: string; cid: string; budget: number | null }[];
};
export type NowBranch = { branch: string; items: NowItem[]; budget: number };

/** Live ad sets grouped per branch, then per service + audience, biggest budget first. Budgets rounded to ₱10. */
export function runningNow(lines: LineView[]): { branches: NowBranch[]; budget: number; sets: number } {
  const by = new Map<string, Map<string, NowItem>>();
  for (const l of lines) {
    for (const s of l.adsets) {
      const audience = audienceOf(s.targeting);
      const svc = SERVICE_LABEL[l.service];
      const key = `${svc}|${audience.key}`;
      const m = by.get(l.branch) ?? new Map<string, NowItem>();
      by.set(l.branch, m);
      const it = m.get(key) ?? { service: svc, audience, budget: 0, budgetSource: s.budgetSource ?? "none", spend7: 0, chats7: 0, sets: [] };
      it.budget += s.budget ?? 0;
      if (it.sets.length && it.budgetSource !== (s.budgetSource ?? "none")) it.budgetSource = "mixed";
      it.spend7 += s.t7.spend;
      it.chats7 += s.t7.msgs;
      it.sets.push({ id: s.id, name: s.name, campaign: s.campaign, cid: s.cid, budget: s.budget ?? null });
      m.set(key, it);
    }
  }
  const r10 = (v: number) => Math.round(v / 10) * 10;
  const branches = BRANCH_ORDER.map((branch) => {
    const items = [...(by.get(branch)?.values() ?? [])].map((it) => ({ ...it, budget: r10(it.budget) }))
      .sort((a, b) => b.budget - a.budget || b.spend7 - a.spend7);
    return { branch, items, budget: items.reduce((a, it) => a + it.budget, 0) };
  });
  return { branches, budget: branches.reduce((a, b) => a + b.budget, 0), sets: branches.reduce((a, b) => a + b.items.reduce((x, it) => x + it.sets.length, 0), 0) };
}

/** "₱5k", "₱2.5k", "₱500": short budget the way CHRIS writes it. */
export const pesoShort = (p: number) => (p >= 1000 ? `₱${(Math.round(p / 100) / 10).toLocaleString("en-US")}k` : `₱${Math.round(p).toLocaleString("en-US")}`);
