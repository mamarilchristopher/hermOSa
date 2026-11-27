// v0.99.8: delegable fixes. Synthetic DEMO targeting only.
import { describe, expect, it } from "vitest";
import { parseTargeting } from "../../src/lib/adsAdvisor";
import { budgetSteps, settingsPlan } from "../../src/lib/adsSteps";

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
    expect(all).toContain("Sta. Maria, Bocaue, Marilao");
    expect(all).toContain("Set Age to 21 – 54.");
    expect(p.steps.at(-1)).toContain('"Done"');
  });

  it("drops the pin on our clinic with the smaller circle when it overlaps another branch", () => {
    const p = settingsPlan({ name: "DEMO", branch: "QC_MAIN", t: tg({ advantage: 0, genders: [2], age_min: 21, age_max: 54, targeting_automation: { advantage_audience: 0 } }), plan: { ...plan, include: ["4 mi around QC Main pin"], exclude: ["2 mi around Fairview branch"] }, overlapFix: 3 });
    expect(p.rows.find((r) => r.field === "Location")!.set).toMatch(/^Pin on Hermosa QC Main \(.+Matino St\..+\), 3 mi$/);
    expect(p.rows.find((r) => r.field === "Exclude")!.set).toBe("2 mi around Hermosa Fairview");
    expect(p.rows.filter((r) => !r.change).map((r) => r.field)).toEqual(["Audience", "Age", "Gender"]);
    expect(p.steps.join(" ")).toContain("Set the circle to 3 mi.");
  });

  it("budget steps say what to type, before VAT", () => {
    expect(budgetSteps({ name: "DEMO", level: "adset", from: 1000, to: 1200 })[1]).toContain("change Daily budget from ₱1,000 to ₱1,200");
  });
});
