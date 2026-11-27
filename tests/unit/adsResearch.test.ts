// v0.99.8: Ad advisor research areas. Synthetic DEMO playbook rows only.
import { describe, expect, it } from "vitest";
import { AREAS, areaFor, openQuestions, sortAreas, TIER, type Area } from "../../src/lib/adsResearch";
import type { Playbook } from "../../src/lib/adsPlaybook";

const area = (o: Partial<Area>): Area => ({ id: "x", title: "DEMO", question: "?", asked: "2026-11-01", asked_by: "DEMO", status: "done", headline: "", findings: [], recommendation: null, next: null, links: {}, report: null, ...o });
const pb = (radar: Partial<Playbook["radar"]>) => ({ radar: { note: "", untapped: [], retargeting: null, trends: [], benchmarks: [], ...radar } }) as unknown as Playbook;

describe("research areas", () => {
  it("puts open studies first, newest first inside each status", () => {
    const s = sortAreas([area({ id: "a", status: "done", asked: "2026-11-28" }), area({ id: "b", status: "researching", asked: "2026-11-01" }), area({ id: "c", status: "done", asked: "2026-11-30" })]);
    expect(s.map((a) => a.id)).toEqual(["b", "c", "a"]);
  });

  it("finds open questions in the playbook by itself", () => {
    const q = openQuestions(pb({
      benchmarks: [{ tier: 2, campaign_type: "DEMO ads", metric: "Offers", value: "Not yet read", source: "pending" }, { tier: 1, campaign_type: "DEMO", metric: "Cost", value: "₱1", source: "Hermosa data" }],
      trends: [{ title: "DEMO speed", detail: "To be measured.", source: "pending: DEMO export" }],
      untapped: [
        { service: "DEMO studied", why: "w", evidence: [], setup: "", budget_day_pre_vat: 0, creative_brief: "", status: "research" },
        { service: "DEMO new", why: "Nobody has looked yet", evidence: [], setup: "", budget_day_pre_vat: 0, creative_brief: "", status: "research" },
        { service: "DEMO ready", why: "w", evidence: [], setup: "", budget_day_pre_vat: 0, creative_brief: "", status: "proposed" },
      ],
    }), [area({ links: { untapped: "DEMO studied" } })]);
    expect(q.map((x) => x.from)).toEqual(["benchmark", "trend", "untapped"]);
    expect(q[1].need).toBe("To be measured. Needs DEMO export.");
    expect(q[2].title).toBe("DEMO new");
  });

  it("links an untapped idea to its study", () => {
    expect(areaFor("DEMO studied", [area({ id: "s", links: { untapped: "DEMO studied" } })])?.id).toBe("s");
    expect(areaFor("DEMO other", [area({})])).toBeNull();
  });

  it("ships studies with known statuses, PH evidence tiers and findings", () => {
    expect(AREAS.length).toBeGreaterThan(0);
    for (const a of AREAS) {
      expect(["queued", "researching", "testing", "done", "parked"]).toContain(a.status);
      expect(a.findings.length).toBeGreaterThan(0);
      for (const f of a.findings) expect(Object.keys(TIER).map(Number)).toContain(f.tier);
    }
    expect(new Set(AREAS.map((a) => a.id)).size).toBe(AREAS.length);
  });
});
