// v0.99.8: delegable fixes. Synthetic DEMO targeting only.
import { describe, expect, it } from "vitest";
import { parseTargeting } from "../../src/lib/adsAdvisor";
import { bestRadius, budgetSteps, CLINIC_SEARCH, geoRadius, locationOk, locationPick, planGeo, planRadius, settingsPlan } from "../../src/lib/adsSteps";
import type { Playbook } from "../../src/lib/adsPlaybook";

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
    expect(p.location).toEqual({ address: CLINIC_SEARCH.STA_MARIA, radius: bestRadius("STA_MARIA"), also: [], exclude: [] });
    expect(all).toContain("Set Age to 21 – 54.");
    expect(p.steps.at(-1)).toContain('"Done"');
  });

  it("leaves a correct clinic pin alone", () => {
    const p = settingsPlan({ name: "DEMO", branch: "QC_MAIN", service: "GLUTA", t: tg({ genders: [2], age_min: 21, age_max: 54, targeting_automation: { advantage_audience: 0 }, geo_locations: { places: [{ name: "DEMO pin", latitude: 14.6393, longitude: 121.0566, radius: 3, distance_unit: "mile" }] } }), plan });
    expect(p.rows.filter((r) => !r.change).map((r) => r.field)).toEqual(["Audience", "Location", "Age", "Gender"]);
    expect(p.location).toBeNull();
  });

  it("radius: the plan's, else the widest whole mile half a mile short of the next clinic", () => {
    expect(bestRadius("QC_MAIN")).toBe(Math.floor(planRadius("QC_MAIN") ?? geoRadius("QC_MAIN")));
    expect(Number.isInteger(bestRadius("MARIKINA"))).toBe(true);
    expect(geoRadius("QC_MAIN")).toBe(3);
    expect(geoRadius("STA_MARIA")).toBe(7);
  });

  it("reach is per service: a wide Hiko circle with the other clinics left out, a tight Gluta circle", () => {
    const line = (service: string, include: string[], exclude: string[] = []) => ({ branch: "QC_MAIN", service, geo: { include, exclude } });
    const pb = { lines: [
      line("GLUTA", ["QC Main clinic address, 3 mi radius"]),
      line("HIKO", ["QC Main clinic address, 10 mi radius"], ["Fairview clinic address, 1 mi radius", "Marikina clinic address, 1.5 mi radius"]),
    ] } as unknown as Playbook;
    expect(planGeo("QC_MAIN", "HIKO", pb)).toEqual({ radius: 10, include: [{ branch: "QC_MAIN", radius: 10 }], exclude: [{ branch: "FAIRVIEW", radius: 1 }, { branch: "MARIKINA", radius: 1 }] });
    expect(planGeo("QC_MAIN", "GLUTA", pb)).toEqual({ radius: 3, include: [{ branch: "QC_MAIN", radius: 3 }], exclude: [] });
    expect(planGeo("QC_MAIN", "NOVOFORM", pb).radius).toBe(3);
    expect(planGeo("MARIKINA", "HIKO", pb).radius).toBeNull();
  });

  it("checks a wide circle: right size, other clinics left out; too small or missing exclusions get flagged", () => {
    const g = planGeo("QC_MAIN", "HIKO");
    if (!g.exclude.length) return; // plan without a wide QC Hiko line: nothing to check
    const r = bestRadius("QC_MAIN", "HIKO");
    const out = g.exclude.map((x) => ({ name: "DEMO out", latitude: { FAIRVIEW: 14.7032, MARIKINA: 14.6587 }[x.branch], longitude: { FAIRVIEW: 121.0686, MARIKINA: 121.112 }[x.branch], radius: x.radius }));
    const set = (radius: number, excl = true) => tg({ geo_locations: { places: [{ name: "DEMO pin", latitude: 14.6393, longitude: 121.0566, radius }] }, ...(excl ? { excluded_geo_locations: { places: out } } : {}) });
    expect(locationOk("QC_MAIN", set(r), "HIKO")).toBe(true);
    expect(locationOk("QC_MAIN", set(3), "HIKO")).toBe(false);
    expect(locationOk("QC_MAIN", set(r, false), "HIKO")).toBe(false);
    const steps = settingsPlan({ name: "DEMO", branch: "QC_MAIN", service: "HIKO", t: set(3), plan }).steps.join(" ");
    expect(steps).toContain(`set the radius to ${r} mi`);
    expect(steps).toContain('change it to "Exclude"');
    expect(locationPick("QC_MAIN", { service: "HIKO" }).exclude.map((x) => x.address)).toContain(CLINIC_SEARCH.FAIRVIEW);
  });

  it("an extra clinic in the plan is a second include, not an overlap", () => {
    const line = { branch: "FAIRVIEW", service: "OTHER", geo: { include: ["Fairview clinic address, 4 mi radius", "QC Main clinic address, 10 mi radius"], exclude: [] } } as unknown as Playbook["lines"][number];
    const p = locationPick("FAIRVIEW", { line });
    expect(p).toMatchObject({ address: CLINIC_SEARCH.FAIRVIEW, radius: 4, also: [{ branch: "QC_MAIN", radius: 10 }], exclude: [] });
  });

  it("reads excluded places from Meta targeting", () => {
    const t = tg({ excluded_geo_locations: { places: [{ name: "DEMO out", latitude: 14.7032, longitude: 121.0686, radius: 1 }] } });
    expect(t?.excluded).toEqual([{ name: "DEMO out", radius: 1, lat: 14.7032, lng: 121.0686 }]);
  });

  it("budget steps say what to type, before VAT", () => {
    expect(budgetSteps({ name: "DEMO", level: "adset", from: 1000, to: 1200 })[1]).toContain("change Daily budget from ₱1,000 to ₱1,200");
  });
});
