import { describe, expect, it } from "vitest";
import { byRankThenName, staffRank } from "../../src/lib/staffOrder";

describe("staff order", () => {
  it("Owners > Managers > Senior CMA > CMA", () => {
    const people = [
      { n: "Zed CMA", r: staffRank([{ role_code: "CLINICIAN", branch_id: "b" }], "CMA") },
      { n: "Amy Senior", r: staffRank([{ role_code: "CLINICIAN", branch_id: "b" }], "Senior CMA") },
      { n: "Bea Branch Mgr", r: staffRank([{ role_code: "MANAGER", branch_id: "b" }], null) },
      { n: "Gia GM", r: staffRank([{ role_code: "MANAGER", branch_id: null }], "General Manager") },
      { n: "Owen Owner", r: staffRank([{ role_code: "OWNER", branch_id: null }], null) },
      { n: "Abe CMA", r: staffRank([{ role_code: "CLINICIAN", branch_id: "b" }], "CMA") },
    ];
    expect(byRankThenName(people, (p) => p.r, (p) => p.n).map((p) => p.n)).toEqual(["Owen Owner", "Gia GM", "Bea Branch Mgr", "Amy Senior", "Abe CMA", "Zed CMA"]);
  });
  it("falls back to the position title when roles aren't visible", () => {
    expect(staffRank([], "General Manager")).toBeLessThan(staffRank([], "Senior CMA"));
    expect(staffRank([], "Senior CMA")).toBeLessThan(staffRank([], "CMA"));
  });
});
