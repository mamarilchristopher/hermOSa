// v0.99.8: delegable fixes. Synthetic DEMO targeting only.
import { describe, expect, it } from "vitest";
import { parseTargeting } from "../../src/lib/adsAdvisor";
import { budgetSteps, bulkBlocks, bulkTown, settingsPlan } from "../../src/lib/adsSteps";

const tg = (o: object) => parseTargeting(JSON.stringify({ age_min: 18, age_max: 65, geo_locations: { places: [{ name: "DEMO pin", latitude: 14.6393, longitude: 121.0566, radius: 6, distance_unit: "mile" }] }, targeting_automation: { advantage_audience: 1 }, ...o }));
const plan = { ageMin: 21, ageMax: 54, genders: "women", interests: ["Beauty"], include: ["Sta. Maria", "Bocaue", "Marilao (Bulacan)"], exclude: [] };

describe("settings plan", () => {
  it("gives the exact values and the clicks for a wrong-area Advantage+ ad set", () => {
    const p = settingsPlan({ name: "DEMO set", branch: "STA_MARIA", t: tg({ genders: [2] }), plan, locationFlag: true });
    const row = (f: string) => p.rows.find((r) => r.field === f)!;
    expect(row("Audience")).toMatchObject({ now: "Advantage+ audience", set: "Original audience options", change: true });
    expect(row("Location")).toMatchObject({ now: '6 mi around "DEMO pin"', set: "Sta. Maria, Bocaue, Marilao", change: true });
    expect(row("Age")).toMatchObject({ set: "21–54", change: true });
    expect(row("Gender")).toMatchObject({ now: "Women, but only a suggestion (Advantage+ on)", change: true });
    const all = p.steps.join("\n");
    expect(all).toContain('Click "Switch to original audience options"');
    expect(all).toContain('Set Location type to "Addresses" and Default radius to "3 mi". Paste box 1 (Towns');
    expect(p.bulk[0].lines).toEqual(["Santa Maria Bulacan Philippines", "Bocaue Bulacan Philippines", "Marilao Bulacan Philippines"]);
    expect(all).toContain("Set Age to 21 – 54.");
    expect(p.steps.at(-1)).toContain('"Done"');
  });

  it("drops the pin on our clinic with the smaller circle when it overlaps another branch", () => {
    const p = settingsPlan({ name: "DEMO", branch: "QC_MAIN", t: tg({ advantage: 0, genders: [2], age_min: 21, age_max: 54, targeting_automation: { advantage_audience: 0 } }), plan: { ...plan, include: ["4 mi around QC Main pin"], exclude: ["2 mi around Fairview branch"] }, overlapFix: 3 });
    expect(p.rows.find((r) => r.field === "Location")!.set).toMatch(/^Pin on Hermosa QC Main \(.+Matino St\..+\), 3 mi$/);
    expect(p.rows.find((r) => r.field === "Exclude")!.set).toBe("2 mi around Hermosa Fairview");
    expect(p.rows.filter((r) => !r.change).map((r) => r.field)).toEqual(["Audience", "Age", "Gender"]);
    expect(p.bulk.map((b) => [b.label, b.radius])).toEqual([["Hermosa QC Main pin", 3], ["Exclude", 3]]);
    expect(p.steps.join(" ")).toContain('switch each of these to "Exclude"');
  });

  it("builds paste-ready blocks for Meta's Add locations in bulk (no commas, dropdown radii)", () => {
    expect(bulkTown("Sta. Maria")).toBe("Santa Maria Bulacan Philippines");
    expect(bulkTown("Rodriguez (Montalban)")).toBe("Rodriguez Rizal Philippines");
    expect(bulkTown("San Jose del Monte, Bulacan")).toBe("San Jose del Monte Bulacan Philippines");
    const b = bulkBlocks("FAIRVIEW", ["5 mi around Fairview branch (Fairview, Lagro)", "San Jose del Monte, Bulacan"], ["2 mi around QC Main"]);
    expect(b.map((x) => [x.label, x.radius, x.exclude ?? false])).toEqual([["Hermosa Fairview pin", 5, false], ["Towns", 3, false], ["Exclude", 3, true]]);
    for (const x of b) for (const l of x.lines) expect(l).not.toMatch(/[,;]/);
    expect(bulkBlocks("QC_MAIN", ["4 mi around QC Main pin"], [])[0].radius).toBe(3);
  });

  it("budget steps say what to type, before VAT", () => {
    expect(budgetSteps({ name: "DEMO", level: "adset", from: 1000, to: 1200 })[1]).toContain("change Daily budget from ₱1,000 to ₱1,200");
  });
});
