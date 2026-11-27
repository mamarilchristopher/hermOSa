// update-0099: Ad advisor rules. Synthetic DEMO feed rows only.
import { describe, expect, it } from "vitest";
import { addDay, advise, parseTargeting, serviceOfAd, targetingText, type FeedRow } from "../../src/lib/adsAdvisor";
import { newAdSets, planMap, planPerDay, PLAYBOOK } from "../../src/lib/adsPlaybook";

const QC = "103117851723422", SMB = "112393681804031";
const TODAY = "2026-12-15";
/** 14 days of one ad: spend/chats per day for the latest 7 days and the 7 before. */
function ad(o: { page?: string; cid?: string; c?: string; sid?: string; aid: string; a: string; sp: [number, number]; m: [number, number]; cb?: number | null; sb?: number | null; as?: string; im?: [number, number]; cl?: [number, number]; budgetFrom?: { d: string; cb: number } }) {
  const rows: FeedRow[] = [];
  for (let i = 0; i < 14; i++) {
    const d = addDay(TODAY, -14 + i);
    const late = i >= 7 ? 0 : 1;
    let cb = o.cb === undefined ? 300000 : o.cb;
    if (o.budgetFrom && d >= o.budgetFrom.d) cb = o.budgetFrom.cb;
    rows.push({ d, page: o.page ?? QC, cid: o.cid ?? "c1", c: o.c ?? "DEMO Hiko campaign", sid: o.sid ?? "s1", s: "DEMO set", aid: o.aid, a: o.a,
      sp: o.sp[late], m: o.m[late], im: o.im?.[late] ?? 1000, rc: 800, fq: 1.2, cl: o.cl?.[late] ?? 20, cb, sb: o.sb ?? null, ss: "ACTIVE", as: o.as ?? "ACTIVE" });
  }
  return rows;
}
const salesFlat = (perDayCents: number) => {
  const m = new Map<string, number>();
  for (let i = 0; i < 30; i++) m.set(addDay(TODAY, -i), perDayCents);
  return m;
};
const run = (rows: FeedRow[], salesPerDay: number, plan = new Map<string, { budget: number; status: string; reviewDays: number }>()) =>
  advise({ feed: { ok: true, last_date: addDay(TODAY, -1), loaded_at: null, source: "windsor", rows, targeting: {} }, today: TODAY,
    sales: new Map([["QC_MAIN", salesFlat(salesPerDay)], ["STA_MARIA", salesFlat(salesPerDay)]]),
    shares: new Map([["QC_MAIN", { HIKO: 1, GLUTA: 0, OTHER: 0 }], ["STA_MARIA", { HIKO: 1, GLUTA: 0, OTHER: 0 }]]), plan });

describe("budget moves", () => {
  it("raises 20% after two 5x weeks, cuts 20% after two weeks under 3.5x", async () => {
    // ₱3,000/day spend; ROAS = sales ÷ (spend × 1.12).
    const hi = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), 3000 * 1.12 * 6 * 100).lines[0];
    expect(hi.action).toBe("RAISE");
    expect(hi.budget).toBe(3000);
    expect(hi.newBudget).toBe(3600);
    expect(hi.headline).toBe("Raise to ₱3,600/day (from ₱3,000)");
    const lo = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), 3000 * 1.12 * 3 * 100).lines[0];
    expect(lo.action).toBe("CUT");
    expect(lo.newBudget).toBe(2400);
    const mid = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), 3000 * 1.12 * 4.2 * 100).lines[0];
    expect(mid.action).toBe("KEEP");
  });

  it("waits 7 days after a budget change", () => {
    const rows = ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100], budgetFrom: { d: addDay(TODAY, -3), cb: 360000 } });
    const l = run(rows, 3000 * 1.12 * 6 * 100).lines[0];
    expect(l.action).toBe("WAIT");
    expect(l.budget).toBe(3600);
    expect(l.lockedUntil).toBe(addDay(TODAY, 4));
    expect(l.nextReview).toBe(addDay(TODAY, 4));
  });

  it("steps toward the plan when it's over plan without a 5x week; plan 'off' turns a live line off", () => {
    const plan = new Map([["QC_MAIN|HIKO", { budget: 2000, status: "keep", reviewDays: 7 }]]);
    const over = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), 3000 * 1.12 * 4 * 100, plan).lines[0];
    expect(over.action).toBe("CUT");
    expect(over.newBudget).toBe(2400);
    const off = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), 3000 * 1.12 * 6 * 100, new Map([["QC_MAIN|HIKO", { budget: 0, status: "off", reviewDays: 28 }]])).lines[0];
    expect(off.action).toBe("OFF");
  });

  it("a planned line with nothing live says start; a campaign budget splits by last week's spend", () => {
    const plan = new Map([["QC_MAIN|GLUTA", { budget: 660, status: "start", reviewDays: 14 }]]);
    const rows = [...ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), ...ad({ aid: "a2", a: "DEMO Drip", c: "DEMO Hiko campaign", sp: [1000, 1000], m: [40, 40], sid: "s2" })];
    const res = run(rows, 100000, plan);
    const g = res.lines.find((l) => l.key === "QC_MAIN|GLUTA")!;
    expect(g.budget).toBe(750); // ₱3,000 campaign budget × 1/4 of its spend
    const h = res.lines.find((l) => l.key === "QC_MAIN|HIKO")!;
    expect(h.budget).toBe(2250);
    const none = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] }), 100000, plan).lines.find((l) => l.key === "QC_MAIN|GLUTA")!;
    expect(none.action).toBe("START");
    expect(none.newBudget).toBe(660);
  });
});

describe("names and targeting", () => {
  it("sorts ads into Hiko, Gluta or other", () => {
    expect(serviceOfAd("03.11.25 | Drip | Non- Invasives | TOFU - FAIRVIEW", "Beauty and Luxury", "Fairview - Drip")).toBe("GLUTA");
    expect(serviceOfAd("10.15.2026.Main.SMB.Vid+Pic", "SMB+4 - Women only", "Contour Vid")).toBe("HIKO");
    expect(serviceOfAd("C.Main.Gluta.10.23.25", "Women & Advantage +", "Video")).toBe("GLUTA");
    expect(serviceOfAd("DEMO Botox", "x", "Barbie arms")).toBe("OTHER");
  });

  it("reads Meta targeting and catches an ad set aimed at another branch", () => {
    const raw = JSON.stringify({ age_min: 18, age_max: 65, age_range: [18, 50], genders: [2], geo_locations: { places: [{ name: "QC pin", radius: 6, latitude: 14.6392, longitude: 121.0565 }] }, targeting_automation: { advantage_audience: 1 } });
    const t = parseTargeting(raw)!;
    expect(t).toMatchObject({ advantage: true, genders: "women", ageSuggest: [18, 50], nearest: "QC_MAIN" });
    expect(targetingText(t)).toBe("Advantage+ audience · ages 18–50 suggested (min 18) · women · 6 mi around QC pin");
    expect(parseTargeting("not json")).toBeNull();
    const rows = ad({ page: SMB, aid: "s", a: "DEMO Hiko", sp: [1000, 1000], m: [30, 30] });
    const res = advise({ feed: { ok: true, last_date: addDay(TODAY, -1), loaded_at: null, source: "windsor", rows, targeting: { s1: raw } }, today: TODAY,
      sales: new Map(), shares: new Map(), plan: new Map() });
    expect(res.lines[0].adsets[0].mismatch).toBe("QC_MAIN");
    expect(res.lines[0].adsets[0].learnShort).toBe(false);
  });

  it("the shipped playbook has a line per branch × Hiko/Gluta and adds up to the monthly plan", () => {
    const m = planMap();
    for (const b of ["QC_MAIN", "FAIRVIEW", "STA_MARIA", "MARIKINA"]) for (const s of ["HIKO", "GLUTA"]) expect(m.has(`${b}|${s}`)).toBe(true);
    // The agreed plan fits the month; proposals (waiting for CHRIS's OK) don't count and never take over a branch line.
    expect(planPerDay() * 30.4).toBeLessThanOrEqual(PLAYBOOK.month_total_pre_vat + 5000);
    expect(m.get("QC_MAIN|HIKO")!.status).not.toBe("proposed");
    for (const l of newAdSets()) expect(l.branch === "ALL" || l.status === "proposed").toBe(true);
  });
});

describe("one week isn't enough", () => {
  it("one week under 3.5x or over 5x holds, and says what happens next week", () => {
    const rows = ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 1500], m: [100, 100] });
    // Same sales both weeks: this week ₱3,000/day spend, the week before ₱1,500/day.
    const l = run(rows, 3000 * 1.12 * 3 * 100).lines[0];
    expect(l.roas7!).toBeCloseTo(3, 1);
    expect(l.action).toBe("KEEP");
    expect(l.why).toMatch(/first week. Cut 20% if next week stays under/);
  });
});

describe("growth check (Nov 27): more spend on the same ads didn't bring more sales", () => {
  it("a playbook line at 5x+ holds and points to new offers; a proposed test is the move instead", () => {
    const rows = ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 3000], m: [100, 100] });
    const sales = 3000 * 1.12 * 6 * 100;
    const held = run(rows, sales, new Map([["QC_MAIN|HIKO", { budget: 3000, status: "keep", reviewDays: 7 }]])).lines[0];
    expect(held.action).toBe("KEEP");
    expect(held.why).toMatch(/new offer/);
    const test = run(rows, sales, new Map([["QC_MAIN|HIKO", { budget: 3000, status: "keep", reviewDays: 7, proposedChange: { budget: 3600, why: "DEMO controlled test.", status: "proposed" } }]])).lines[0];
    expect(test.action).toBe("TEST");
    expect(test.headline).toBe("Test ₱3,600/day for 3 weeks (from ₱3,000)");
    expect(test.why).toBe("DEMO controlled test. Waiting for your OK.");
  });

  it("the shipped playbook carries Marikina's proposed test", () => {
    expect(planMap().get("MARIKINA|HIKO")!.proposedChange?.budget).toBeGreaterThan(planMap().get("MARIKINA|HIKO")!.budget);
  });
});

describe("ad states (playbook refresh_rule, CHRIS Nov 27): judged by results, not age", () => {
  /** 28 days of one ad: per-day [spend, chats] for days 1-14, 15-21 and the last 7. */
  function long(aid: string, a: [number, number], b: [number, number], c: [number, number], ctr: [number, number] = [20, 20]) {
    const rows: FeedRow[] = [];
    for (let i = 0; i < 28; i++) {
      const d = addDay(TODAY, -28 + i);
      const [sp, m] = i < 14 ? a : i < 21 ? b : c;
      rows.push({ d, page: QC, cid: "c1", c: "DEMO Hiko campaign", sid: "s1", s: "DEMO set", aid, a: `DEMO ${aid}`, sp, m, im: 1000, rc: 800, fq: 1.2,
        cl: i < 21 ? ctr[0] : ctr[1], cb: 300000, sb: null, ss: "ACTIVE", as: "ACTIVE" });
    }
    return rows;
  }
  // Target ₱35* a chat. ₱500/day for 18 chats = ₱31* a chat.
  const plan = new Map([["QC_MAIN|HIKO", { budget: 3000, status: "keep", reviewDays: 7, targetCpc: 35 }]]);
  const states = (rows: FeedRow[]) => Object.fromEntries(run(rows, 100000, plan).lines[0].ads.map((a) => [a.id, a.state]));

  it("winner, tiring, fatigued, loser, learning", () => {
    expect(states([
      ...long("win", [500, 18], [500, 18], [500, 18]),
      ...long("tire", [500, 18], [500, 18], [500, 14], [30, 20]),   // +28% cost and click rate down a third
      ...long("slip", [500, 18], [500, 14], [500, 14]),             // +28% but clicks fine: one sign only
      ...long("fat", [500, 18], [500, 12], [500, 12]),              // +50% two weeks
      ...long("lose", [500, 9], [500, 9], [500, 9]),                // ₱62* a chat from the start
      ...long("new", [0, 0], [0, 0], [500, 12]),                    // 7 days: learning just ended, too soon
    ])).toEqual({ win: "WINNER", tire: "TIRING", slip: "STEADY", fat: "FATIGUED", lose: "LOSER", new: "NEW" });
  });

  it("age alone never makes an ad tiring", () => {
    const [a] = run(long("old", [500, 18], [500, 18], [500, 18]), 100000, plan).lines[0].ads;
    expect(a.age).toBe(28);
    expect(a.state).toBe("WINNER");
    expect(a.why).toMatch(/Keep it and its budget; never edit it/);
  });

  it("₱1,000* in 14 days and no chats is a loser", () => {
    expect(states(long("dud", [0, 0], [100, 0], [100, 0]))).toEqual({ dud: "LOSER" });
  });
});

describe("dashboard series (v0.99.4)", () => {
  it("gives each line 28 days of spend and chats, and 4 weeks of ROAS", () => {
    const l = run(ad({ aid: "a1", a: "DEMO Hiko", sp: [3000, 2000], m: [100, 80] }), 3000 * 1.12 * 6 * 100).lines[0];
    expect(l.days).toHaveLength(28);
    expect(l.days[27]).toEqual({ d: addDay(TODAY, -1), sp: 3000, m: 100 });
    expect(l.days[0].sp).toBe(0);
    expect(l.roasWeeks).toHaveLength(4);
    expect(l.roasWeeks[0]).toBeNull();
    expect(l.roasWeeks[3]).toBeCloseTo(6, 5);
    expect(l.roasWeeks[2]).toBeCloseTo(9, 5);
  });
});

describe("source links", () => {
  it("splits a URL from the note after it", async () => {
    const { links } = await import("../../src/lib/adsPlaybook");
    expect(links("https://www.anahaw.ph/x (PH agency) ; Hermosa ad log")).toEqual([
      { href: "https://www.anahaw.ph/x", label: "anahaw.ph (PH agency)" },
      { href: null, label: "Hermosa ad log" },
    ]);
  });
});
