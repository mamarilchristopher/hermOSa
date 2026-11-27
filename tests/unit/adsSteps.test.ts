// v0.99.8: delegable fixes. Synthetic DEMO targeting only.
import { describe, expect, it } from "vitest";
import { parseTargeting } from "../../src/lib/adsAdvisor";
import { bestRadius, budgetSteps, CLINIC_SEARCH, geoRadius, planRadius, settingsPlan } from "../../src/lib/adsSteps";

const tg = (o: object) => parseTargeting(JSON.stringify({ age_min: 18, age_max: 65, geo_locations: { places: [{ name: "DEMO pin", latitude: 14.6393, longitude: 121.0566, radius: 6, distance_unit: "mile" }] }, targeting_automation: { advantage_audience: 1 }, ...o }));
const plan = { ageMin: 21, ageMax: 54, genders: "women", interests: ["Beauty"] };

describe("settings plan", () => {
  it("gives the exact values and the clicks for a wrong-area Advantage+ ad set", () => {
    const p = settingsPlan({ name: "DEMO set", branch: "STA_MARIA", t: tg({ genders: [2] }), plan, locationFlag: true });
    const row = (f: string) => p.rows.find((r) => r.field === f)!;
    expect(row("Audience")).toMatchObject({ now: "Advantage+ audience", set: "Original audience options", change: true });
    expect(row("Location")).toMatchObject({ now: '6 mi around "DEMO pin"', set: `Hermosa Sta. Maria clinic (${CLINIC_SEARCH.STA_MARIA}) + ${bestRadius("STA_MARIA")} mi`, change: true });
    expect(row("Age")).toMatchObject({ set: "21–54", change: true });
    expect(row("Gender")).toMatchObject({ now: "Women, but only a suggestion (Advantage+ on)", change: true });
    const all = p.steps.join("\n");
    expect(all).toContain('Click "Switch to original audience options"');
    expect(all).toContain(`set the radius to ${bestRadius("STA_MARIA")} mi`);
    expect(p.location).toEqual({ address: CLINIC_SEARCH.STA_MARIA, radius: bestRadius("STA_MARIA") });
    expect(all).toContain("Set Age to 21 – 54.");
    expect(p.steps.at(-1)).toContain('"Done"');
  });

  it("leaves a correct clinic pin alone", () => {
    const p = settingsPlan({ name: "DEMO", branch: "QC_MAIN", t: tg({ genders: [2], age_min: 21, age_max: 54, targeting_automation: { advantage_audience: 0 }, geo_locations: { places: [{ name: "DEMO pin", latitude: 14.6393, longitude: 121.0566, radius: 3, distance_unit: "mile" }] } }), plan });
    expect(p.rows.filter((r) => !r.change).map((r) => r.field)).toEqual(["Audience", "Location", "Age", "Gender"]);
    expect(p.location).toBeNull();
  });

  it("radius: the plan's, else the widest whole mile half a mile short of the next clinic", () => {
    expect(bestRadius("QC_MAIN")).toBe(Math.floor(planRadius("QC_MAIN") ?? geoRadius("QC_MAIN")));
    expect(Number.isInteger(bestRadius("MARIKINA"))).toBe(true);
    expect(geoRadius("QC_MAIN")).toBe(3);
    expect(geoRadius("STA_MARIA")).toBe(7);
  });

  it("budget steps say what to type, before VAT", () => {
    expect(budgetSteps({ name: "DEMO", level: "adset", from: 1000, to: 1200 })[1]).toContain("change Daily budget from ₱1,000 to ₱1,200");
  });
});
