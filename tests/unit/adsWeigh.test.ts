// v0.100.5: weighing audience fixes with an ad set's own numbers. Synthetic DEMO splits only.
import { describe, expect, it } from "vitest";
import { weighSeg, type Seg } from "../../src/lib/adsWeigh";
import { settingsPlan } from "../../src/lib/adsSteps";
import { parseTargeting } from "../../src/lib/adsAdvisor";

const o = { women: true, ageMin: 21, ageMax: 54, chatsPerDay: 80 };
describe("weighing a women-only / 21–54 fix", () => {
  it("fixes when men and older women cost the same per chat but book less", () => {
    const seg: Seg = { "f|25-34": [10000, 400], "f|35-44": [6000, 220], "f|55-64": [3000, 70], "m|25-34": [4000, 150] };
    const w = weighSeg(seg, o)!;
    expect(w.verdict).toBe("fix");
    expect(w.men.share).toBeCloseTo(4000 / 23000, 3);
    expect(w.older.cpc).toBeCloseTo(3000 / 70, 3);
    expect(w.after).toBeCloseTo((16000 / 620) * 1.1, 3);
    expect(w.learnDays).toBeCloseTo(50 / 80, 3);
  });

  it("holds when the people the fix drops are the cheap, good-value ones", () => {
    const seg: Seg = { "f|25-34": [10000, 200], "f|55-64": [6000, 250], "f|65+": [5000, 200], "m|25-34": [500, 15] };
    expect(weighSeg(seg, o)!.verdict).toBe("hold");
  });

  it("calls a close one a test (copy first)", () => {
    const seg: Seg = { "f|25-34": [10000, 400], "m|25-34": [1200, 50] };
    expect(weighSeg(seg, o)!.verdict).toBe("test");
  });

  it("18–24 counts 4 of 7 years toward a 21 minimum", () => {
    const w = weighSeg({ "f|18-24": [700, 70], "f|25-34": [1000, 50] }, { ...o, women: true })!;
    expect(w.kept.cpc).toBeCloseTo((400 + 1000) / (40 + 50), 3);
  });

  it("an ad set without numbers falls back to the rule", () => {
    const t = parseTargeting(JSON.stringify({ age_min: 18, age_max: 65, genders: [1, 2], geo_locations: { places: [{ name: "DEMO", latitude: 14.6393, longitude: 121.0566, radius: 3 }] }, targeting_automation: { advantage_audience: 1 } }));
    const p = settingsPlan({ id: "DEMO-none", name: "DEMO", branch: "QC_MAIN", service: "GLUTA", t, plan: { ageMin: 21, ageMax: 54, genders: "women", interests: [] } });
    expect(p.method).toBe("edit");
    expect(p.weighing).toBeNull();
    expect(p.how).toContain("your rule");
  });
});
