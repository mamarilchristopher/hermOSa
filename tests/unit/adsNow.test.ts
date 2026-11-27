// v0.100.3: Running now on Business › Ads. Synthetic DEMO ad sets only.
import { describe, expect, it } from "vitest";
import { parseTargeting, type LineView } from "../../src/lib/adsAdvisor";
import { audienceOf, pesoShort, runningNow } from "../../src/lib/adsNow";

const tg = (o: object) => parseTargeting(JSON.stringify({ age_min: 21, age_max: 54, genders: [2], targeting_automation: { advantage_audience: 0 }, ...o }));
const set = (id: string, budget: number, t: ReturnType<typeof tg>, spend = 1000, src: "adset" | "campaign" = "adset") =>
  ({ id, name: `DEMO ${id}`, campaign: "DEMO c", cid: "c1", status: "ACTIVE", t7: { spend, msgs: 10, impressions: 0, clicks: 0, reach: 0 }, p7: { spend: 0, msgs: 0, impressions: 0, clicks: 0, reach: 0 }, targeting: t, text: null, mismatch: null, learnShort: false, budget, budgetSource: src });
const line = (branch: string, service: string, adsets: ReturnType<typeof set>[]) => ({ branch, service, adsets } as unknown as LineView);

describe("running now", () => {
  it("groups live ad sets per branch, then service + audience, biggest budget first", () => {
    const r = runningNow([
      line("QC_MAIN", "HIKO", [set("a", 3000, tg({})), set("b", 2000, tg({})), set("m", 500, tg({ genders: [1] }))]),
      line("QC_MAIN", "GLUTA", [set("g", 2000, tg({}))]),
    ]);
    const qc = r.branches.find((b) => b.branch === "QC_MAIN")!;
    expect(qc.items.map((i) => `${i.service} ${i.audience.label} ${pesoShort(i.budget)}`)).toEqual([
      "Hiko Women only · 21–54 ₱5k", "Gluta Women only · 21–54 ₱2k", "Hiko Men only · 21–54 ₱500",
    ]);
    expect(qc.budget).toBe(7500);
    expect(r.branches.map((b) => b.branch)).toEqual(["QC_MAIN", "FAIRVIEW", "STA_MARIA", "MARIKINA"]);
    expect(r.branches[1].items).toEqual([]);
    expect(r.sets).toBe(4);
  });

  it("calls out Advantage+ and all-genders audiences (men still see them)", () => {
    expect(audienceOf(tg({ targeting_automation: { advantage_audience: 1 }, age_range: [21, 45] }))).toMatchObject({ label: "Women, Advantage+ (men still see it) · 21–45", warn: true });
    expect(audienceOf(tg({ genders: [1, 2] })).warn).toBe(true);
    expect(audienceOf(null).label).toBe("Audience unread");
  });

  it("short budgets like CHRIS writes them", () => {
    expect([pesoShort(5000), pesoShort(2500), pesoShort(500), pesoShort(12340)]).toEqual(["₱5k", "₱2.5k", "₱500", "₱12.3k"]);
  });
});
