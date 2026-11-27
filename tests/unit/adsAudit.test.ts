// v0.99.6: Ad advisor checks and Ads Manager links. Synthetic DEMO feed rows only.
import { describe, expect, it } from "vitest";
import { addDay, advise, type FeedRow } from "../../src/lib/adsAdvisor";
import { adsManagerUrl, audit, miles } from "../../src/lib/adsAudit";
import { bestRadius } from "../../src/lib/adsSteps";

const QC = "103117851723422", SMB = "112393681804031";
const TODAY = "2026-12-15", END = addDay(TODAY, -1);
const QC_PIN = { lat: 14.6393, lng: 121.0566 }, SMB_PIN = { lat: 14.8659, lng: 120.9966 };
const tg = (o: { pin?: { lat: number; lng: number }; radius?: number; ageMin?: number; genders?: number[]; advantage?: boolean }) => JSON.stringify({
  age_min: o.ageMin ?? 21, age_max: 65, genders: o.genders ?? [2],
  geo_locations: { places: [{ name: "DEMO pin", latitude: (o.pin ?? QC_PIN).lat, longitude: (o.pin ?? QC_PIN).lng, radius: o.radius ?? 3, distance_unit: "mile" }] },
  targeting_automation: { advantage_audience: o.advantage ? 1 : 0 },
});
/** 21 days of one ad in one ad set; spend and chats per day: [last 7, the 7 before, the 7 before that]. */
function ad(o: { page?: string; sid: string; aid: string; a: string; sp: number[]; m: number[]; im?: number[]; cl?: number[]; fq?: number[]; cid?: string }) {
  const rows: FeedRow[] = [];
  for (let i = 0; i < 21; i++) {
    const d = addDay(TODAY, -21 + i), w = i >= 14 ? 0 : i >= 7 ? 1 : 2;
    rows.push({ d, page: o.page ?? QC, cid: o.cid ?? "c1-0769", c: "DEMO Hiko campaign", sid: o.sid, s: `DEMO set ${o.sid}`, aid: o.aid, a: o.a,
      sp: o.sp[w], m: o.m[w], im: o.im?.[w] ?? 1000, rc: 800, fq: o.fq?.[w] ?? 1.2, cl: o.cl?.[w] ?? 20, cb: null, sb: 300000, ss: "ACTIVE", as: "ACTIVE" });
  }
  return rows;
}
const flat = (cents: number, zeroDays: string[] = []) => {
  const m = new Map<string, number>();
  for (let i = 0; i < 35; i++) { const d = addDay(TODAY, -i); m.set(d, zeroDays.includes(d) ? 0 : cents); }
  return m;
};
function run(rows: FeedRow[], targeting: Record<string, string>, o: { sales?: Map<string, number>; plan?: { genders: string; ageMin: number; ageMax?: number }; noSales?: string[] } = {}) {
  const feed = { ok: true, last_date: END, loaded_at: null, source: "windsor", rows, targeting };
  const sales = new Map([["QC_MAIN", o.sales ?? flat(3000 * 1.12 * 5 * 100)], ["STA_MARIA", flat(1_000_000)]]);
  const res = advise({ feed, today: TODAY, sales, shares: new Map([["QC_MAIN", { HIKO: 1, GLUTA: 0, OTHER: 0 }], ["STA_MARIA", { HIKO: 1, GLUTA: 0, OTHER: 0 }]]), plan: new Map() });
  const marks = new Map([["QC_MAIN", new Map((o.noSales ?? []).map((d) => [d, "NO_SALES" as const]))]]);
  return audit({ feed, lines: res.lines, end: res.end, sales, marks, plan: () => o.plan ?? null });
}
const base = (sid = "s1", aid = "a1") => ad({ sid, aid, a: `DEMO Hiko ${aid}`, sp: [3000, 3000, 3000], m: [100, 100, 100] });

describe("ad checks", () => {
  it("a clean ad set passes every check", () => {
    expect(run(base(), { s1: tg({}) })).toEqual([]);
  });

  it("flags a pin in another branch's area, with the ad set to open", () => {
    const f = run(ad({ page: SMB, sid: "s1", aid: "a1", a: "DEMO Hiko", sp: [1000, 1000, 1000], m: [40, 40, 40] }), { s1: tg({ pin: QC_PIN }) });
    const pin = f.find((x) => x.check === "pin")!;
    expect(pin.sev).toBe("bad");
    expect(pin.title).toBe("Move the map pin to Sta. Maria");
    expect(pin.target).toEqual({ kind: "adset", id: "s1", cid: "c1-0769", view: "edit" });
  });

  it("flags a circle that reaches another clinic and suggests half the distance", () => {
    const f = run(base(), { s1: tg({ radius: 7 }) }).find((x) => x.check === "overlap")!;
    const d = miles([QC_PIN.lat, QC_PIN.lng], [14.7032, 121.0686]);
    expect(d).toBeGreaterThan(4);
    expect(d).toBeLessThan(5);
    expect(f.short).toContain("Fairview clinic");
    expect(f.title).toBe(`Shrink the circle to ${bestRadius("QC_MAIN")} mi`);
  });

  it("flags a town list instead of one clinic pin", () => {
    const t = JSON.stringify({ age_min: 21, age_max: 54, genders: [2], geo_locations: { cities: [{ name: "DEMO town" }], places: [{ name: "DEMO pin", latitude: QC_PIN.lat, longitude: QC_PIN.lng, radius: 3, distance_unit: "mile" }] }, targeting_automation: { advantage_audience: 0 } });
    const f = run(base(), { s1: t }).find((x) => x.check === "area")!;
    expect(f.title).toBe(`Use the clinic pin + ${bestRadius("QC_MAIN")} mi`);
    expect(run(base(), { s1: tg({ radius: 3 }) }).some((x) => x.check === "area")).toBe(false);
  });

  it("flags ages under 21", () => {
    const f = run(base(), { s1: tg({ ageMin: 18 }) });
    expect(f.map((x) => x.check)).toEqual(["age"]);
    expect(f[0].title).toBe("Raise the minimum age to 21");
  });

  it("flags anything that isn't women only as a hard limit (CHRIS Nov 28)", () => {
    expect(run(base(), { s1: tg({ genders: [1, 2] }) }).find((x) => x.check === "gender")!.short).toBe('"DEMO set s1" shows to all genders');
    expect(run(base(), { s1: tg({ advantage: true }) }).find((x) => x.check === "gender")!.short).toBe('"DEMO set s1" uses Advantage+ audience, so men still see it');
    expect(run(base(), { s1: tg({}) }).some((x) => x.check === "gender")).toBe(false);
  });

  it("flags ad sets split too thin to leave learning", () => {
    const rows = [
      ...ad({ sid: "s1", aid: "a1", a: "DEMO A", sp: [200, 200, 200], m: [5, 5, 5] }),
      ...ad({ sid: "s2", aid: "a2", a: "DEMO B", sp: [200, 200, 200], m: [4, 4, 4] }),
    ];
    const f = run(rows, { s1: tg({}), s2: tg({}) });
    expect(f.find((x) => x.check === "split")!.short).toBe("35 + 28 chats a week: none leaves learning");
  });

  it("flags a dearer sibling ad set when both have enough chats", () => {
    const rows = [
      ...ad({ sid: "s1", aid: "a1", a: "DEMO A", sp: [3000, 3000, 3000], m: [100, 100, 100] }),
      ...ad({ sid: "s2", aid: "a2", a: "DEMO B", sp: [3000, 3000, 3000], m: [60, 60, 60] }),
    ];
    const f = run(rows, { s1: tg({}), s2: tg({}) }).find((x) => x.check === "setCost")!;
    expect(f.target).toMatchObject({ kind: "adset", id: "s2" });
  });

  it("notes the same ad running in two ad sets of one line", () => {
    const rows = [
      ...ad({ sid: "s1", aid: "a1", a: "DEMO Same", sp: [3000, 3000, 3000], m: [100, 100, 100] }),
      ...ad({ sid: "s2", aid: "a2", a: "DEMO Same", sp: [3000, 3000, 3000], m: [70, 70, 70] }),
    ];
    const f = run(rows, { s1: tg({}), s2: tg({}) }).find((x) => x.check === "dupe")!;
    expect(f.target).toMatchObject({ kind: "ad", id: "a2" });
  });

  it("asks to tag a ₱0 day nobody tagged (data clarity)", () => {
    const zero = [addDay(END, -1), addDay(END, -8)];
    const f = run(base(), { s1: tg({}) }, { sales: flat(3000 * 1.12 * 5 * 100, zero) });
    const t = f.find((x) => x.check === "zeroTag")!;
    expect(t.title).toBe("Tag 2 days in Daily sales");
    expect(t.target).toEqual({ kind: "page", href: "/sales/daily" });
    expect(f.some((x) => x.check === "zeroDay")).toBe(false);
  });

  it("turns frequent declared ₱0 days into a plan to fill them, not an ad cut", () => {
    const zero = [addDay(END, -1), addDay(END, -8), addDay(END, -15)];
    const f = run(base(), { s1: tg({}) }, { sales: flat(3000 * 1.12 * 5 * 100, zero), noSales: zero });
    expect(f.some((x) => x.check === "zeroTag")).toBe(false);
    const q = f.find((x) => x.check === "zeroDay")!;
    expect(q.sev).toBe("warn");
    expect(q.title).toMatch(/^Fill QC Main's \w{3}s$/);
    expect(q.short).toContain("3 declared ₱0 days in 4 weeks (other branches 0.0)");
    expect(q.target).toEqual({ kind: "page", href: "/bookings" });
    expect(q.steps!.join(" ")).toContain("keep budgets as they are");
  });

  it("caps the top age at the plan's", () => {
    const f = run(base(), { s1: tg({}) }, { plan: { genders: "women", ageMin: 21, ageMax: 54 } }).find((x) => x.check === "age")!;
    expect(f.title).toBe("Set ages to 21–54");
  });

  it("flags a 30% jump in cost per chat and a fall in sales per chat", () => {
    const f = run(ad({ sid: "s1", aid: "a1", a: "DEMO", sp: [3000, 3000, 3000], m: [70, 100, 100] }), { s1: tg({}) });
    expect(f.find((x) => x.check === "cpcJump")!.title).toBe("Cost per chat up 43%");
    const q = run(ad({ sid: "s1", aid: "a1", a: "DEMO", sp: [3000, 3000, 3000], m: [150, 100, 100] }), { s1: tg({}) }, { sales: flat(1_000_000) });
    expect(q.find((x) => x.check === "quality")!.title).toBe("Each chat is selling 33% less");
    // A day not typed in yet: no sales-per-chat judgement.
    const gap = flat(1_000_000); gap.delete(END);
    expect(run(ad({ sid: "s1", aid: "a1", a: "DEMO", sp: [3000, 3000, 3000], m: [150, 100, 100] }), { s1: tg({}) }, { sales: gap }).some((x) => x.check === "quality")).toBe(false);
  });

  it("flags an audience wearing out (frequency up, clicks down)", () => {
    const rows = ad({ sid: "s1", aid: "a1", a: "DEMO", sp: [3000, 3000, 3000], m: [100, 100, 100], im: [2000, 2000, 2000], fq: [1.6, 1.3, 1.2], cl: [30, 40, 45] });
    expect(run(rows, { s1: tg({}) }).find((x) => x.check === "saturation")!.short).toBe("Frequency 1.20 → 1.60 a day, clicks 33% lower");
  });
});

describe("Ads Manager links", () => {
  it("opens the edit panel, the list, or an ad set's ads", () => {
    expect(adsManagerUrl({ kind: "adset", id: "9", cid: "c", view: "edit" }, "123")).toBe("https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act=123&selected_adset_ids=9");
    expect(adsManagerUrl({ kind: "ad", id: "7", cid: "c", view: "list" }, "123")).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=7");
    expect(adsManagerUrl({ kind: "adset", id: "9", cid: "c", view: "ads" }, null)).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?selected_adset_ids=9");
  });
});
