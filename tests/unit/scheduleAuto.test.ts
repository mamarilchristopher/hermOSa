import { describe, expect, it } from "vitest";
import { checkWeek, defaultRules, normalizeRules, suggestWeek } from "../../src/lib/scheduleAuto";

const B = ["main", "fv", "smb", "mk"];
// Seven people like the clinic: home branches spread out.
const people = [
  { id: "a", home: "main" }, { id: "b", home: "main" }, { id: "c", home: "fv" }, { id: "d", home: "smb" },
  { id: "e", home: "mk" }, { id: "f", home: "main" }, { id: "g", home: "fv" },
];

describe("suggestWeek", () => {
  const rules = defaultRules(B);
  it("covers every branch's minimum every day and gives each person exactly one day off", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { days, short } = suggestWeek({ people, branches: B, rules, fixed: [], seed });
      expect(short).toEqual([]);
      for (const p of people) expect(days.flat().filter((r) => r.employee === p.id && r.status === "OFF").length).toBe(1);
      days.forEach((rows, d) => {
        expect(rows.length).toBe(7);
        for (const b of B) expect(rows.filter((r) => r.status === b).length).toBeGreaterThanOrEqual(rules.min[b][d]);
      });
    }
  });
  it("keeps fixed days (published or leave) and doesn't plan over them", () => {
    const fixed = [{ employee: "a", day: 2, status: "VL" }, { employee: "d", day: 0, status: "mk" }];
    const { days } = suggestWeek({ people, branches: B, rules, fixed, seed: 3 });
    expect(days[2].some((r) => r.employee === "a")).toBe(false);
    expect(days[0].some((r) => r.employee === "d")).toBe(false);
    // VL doesn't use up a's weekly day off.
    expect(days.flat().filter((r) => r.employee === "a" && r.status === "OFF").length).toBe(1);
  });
  it("prefers a person's usual day off and keeps people at their home branch when possible", () => {
    const ps = people.map((p) => (p.id === "c" ? { ...p, daysOff: [3] } : p)); // Wednesday
    const { days } = suggestWeek({ people: ps, branches: B, rules, fixed: [], seed: 5 });
    expect(days[2].find((r) => r.employee === "c")?.status).toBe("OFF");
    const atHome = days.flat().filter((r) => r.status !== "OFF" && ps.find((p) => p.id === r.employee)?.home === r.status).length;
    expect(atHome / days.flat().filter((r) => r.status !== "OFF").length).toBeGreaterThan(0.7);
  });
  it("reports a branch it can't cover", () => {
    const { short } = suggestWeek({ people: people.slice(0, 3), branches: B, rules, fixed: [], seed: 1 });
    expect(short.length).toBeGreaterThan(0);
  });
});

describe("checkWeek and rules", () => {
  it("flags empty branches, unplanned people and no day off", () => {
    const dates = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"];
    const shifts = dates.map((d) => ({ employee_id: "a", date: d, off: false, branch_id: "main" }));
    const w = checkWeek({ dates, people: [{ id: "a", name: "Ana" }, { id: "b", name: "Bea" }], branches: [{ id: "main", name: "Main" }, { id: "fv", name: "Fairview" }],
      shifts, rules: defaultRules(["main", "fv"]), dayLabel: (d) => d });
    expect(w.some((x) => x.includes("Fairview has nobody"))).toBe(true);
    expect(w.some((x) => x.includes("no plan for Bea"))).toBe(true);
    expect(w.some((x) => x.includes("Ana works all 7 days"))).toBe(true);
  });
  it("asks to confirm a short week (absences count as scheduled days)", () => {
    const dates = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
    const plan: [boolean, string | null][] = [[true, null], [false, null], [true, "ABSENT"], [false, null], [false, null], [true, null], [false, null]];
    const shifts = dates.map((d, i) => ({ employee_id: "a", date: d, off: plan[i][0], branch_id: plan[i][0] ? null : "main", leave: plan[i][1] }));
    const w = checkWeek({ dates, people: [{ id: "a", name: "Jas" }], branches: [{ id: "main", name: "Main" }], shifts, rules: defaultRules(["main"]), dayLabel: (d) => d });
    expect(w).toContain("Jas only has 5 working days this week. Confirm?");
    const six = shifts.map((s, i) => (i === 5 ? { ...s, off: false, branch_id: "main" } : s));
    expect(checkWeek({ dates, people: [{ id: "a", name: "Jas" }], branches: [{ id: "main", name: "Main" }], shifts: six, rules: defaultRules(["main"]), dayLabel: (d) => d }).some((x) => x.includes("Confirm"))).toBe(false);
  });
  it("falls back to defaults for bad saved rules", () => {
    expect(normalizeRules({ days_off: 9, min: { main: [1] } }, ["main"])).toEqual(defaultRules(["main"]));
  });
});
