/**
 * Weighing an audience fix with the ad set's own numbers (v0.100.5, CHRIS Nov 28: "combining the two and weighing which
 * rule should prevail depending on situation ... you got all the data, be analytical").
 *
 * Each ad set's last 4 weeks by gender and age (src/data/adsetAudience.json, from the Meta accounts) gives:
 *  - what a peso buys now, in "women-equivalent chats": a man's chat counts 0.34 (a man who chats is about a third as
 *    likely to become a client, our 2-year data, research area men-test);
 *  - what it would buy after the fix: the cost per chat of the women the fix keeps (e.g. women 21–54), plus 10% because
 *    a narrower audience costs a bit more to reach (an allowance, not a measured number);
 *  - how fast Meta re-learns: about 50 chats exit learning (Meta platform rule), so days = 50 ÷ chats per day.
 * Verdict: fix when the kept audience is clearly better value (≥ 8% more per peso), test with a copy when it's close,
 * hold when the data says the current audience is better value (the rule gives way, and the card says why).
 */
import raw from "../data/adsetAudience.json";
import { LEARN_PER_WEEK } from "./adsAdvisor";

export type Seg = Record<string, [number, number]>;
const DATA = raw as unknown as { pulled: string; from: string; to: string; sets: Record<string, { name: string; seg: Seg }> };
export const AUDIENCE_DATA = { from: DATA.from, to: DATA.to };

export const MAN_WEIGHT = 0.34;
export const NARROW_ALLOWANCE = 1.1;
const FIX_AT = 0.08, HOLD_AT = -0.05;

const band = (a: string): [number, number] => {
  if (a.endsWith("+")) return [Number(a.slice(0, -1)), 70];
  const [lo, hi] = a.split("-").map(Number);
  return [lo, hi];
};
/** Share of an age band inside [min, max] (18–24 with a 21 minimum keeps 4 of 7 years). */
const inside = (a: string, min: number, max: number) => {
  const [lo, hi] = band(a);
  const from = Math.max(lo, min), to = Math.min(hi, max);
  return to < from ? 0 : (to - from + 1) / (hi - lo + 1);
};

export type Weighing = {
  verdict: "fix" | "test" | "hold";
  /** Pre-VAT pesos and chats over the 4 weeks. */
  spend: number; chats: number;
  /** Pesos per women-equivalent chat, now and after the fix (pre-VAT). */
  now: number; after: number; gain: number;
  men: { share: number; spend: number; cpc: number | null };
  older: { share: number; cpc: number | null; from: number };
  kept: { cpc: number | null; label: string };
  learnDays: number | null;
};

const sum = (seg: Seg, f: (g: string, a: string) => number) => {
  let sp = 0, ch = 0;
  for (const [k, [s, c]] of Object.entries(seg)) { const [g, a] = k.split("|"); const w = f(g, a); sp += s * w; ch += c * w; }
  return { sp, ch };
};

/** Weigh a gender and/or age fix for one ad set. Null when there's no audience data for it (new ad set). */
export function weigh(adsetId: string, o: WeighOpts): Weighing | null {
  const seg = DATA.sets[adsetId]?.seg;
  return seg ? weighSeg(seg, o) : null;
}
type WeighOpts = { women: boolean; ageMin: number; ageMax: number; chatsPerDay?: number | null };
/** The same, for a given split: "f|25-34" → [spend pre-VAT, chats]. */
export function weighSeg(seg: Seg, o: WeighOpts): Weighing | null {
  const all = sum(seg, () => 1);
  if (all.sp < 500 || all.ch < 10) return null;
  const men = sum(seg, (g) => (g === "m" ? 1 : 0));
  const weq = all.ch - men.ch + MAN_WEIGHT * men.ch;
  const keep = (g: string, a: string) => (o.women && g !== "f" ? 0 : inside(a, o.ageMin, o.ageMax));
  const kept = sum(seg, keep);
  const older = sum(seg, (g, a) => (g === "f" ? 1 - inside(a, 0, o.ageMax) : 0));
  const now = all.sp / weq;
  const keptCpc = kept.ch > 0 ? kept.sp / kept.ch : null;
  const after = keptCpc === null ? now : keptCpc * NARROW_ALLOWANCE;
  const gain = 1 - after / now;
  const perDay = o.chatsPerDay ?? all.ch / 28;
  return {
    verdict: gain >= FIX_AT ? "fix" : gain <= HOLD_AT ? "hold" : "test",
    spend: all.sp, chats: all.ch, now, after, gain,
    men: { share: men.sp / all.sp, spend: men.sp, cpc: men.ch ? men.sp / men.ch : null },
    older: { share: older.sp / all.sp, cpc: older.ch ? older.sp / older.ch : null, from: o.ageMax + 1 },
    kept: { cpc: keptCpc, label: `${o.women ? "women" : "people"} ${o.ageMin}–${o.ageMax}` },
    learnDays: perDay > 0 ? LEARN_PER_WEEK / perDay : null,
  };
}
