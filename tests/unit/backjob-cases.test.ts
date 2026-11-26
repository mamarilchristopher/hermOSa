import { describe, expect, it } from "vitest";
import { caseStatus, daysBetween, isClosed, sortCases } from "../../src/lib/backjobs";

describe("backjob cases", () => {
  it("knows which statuses close a case", () => {
    expect(isClosed("OPEN")).toBe(false);
    expect(isClosed("IN_PROGRESS")).toBe(false);
    for (const s of ["RESOLVED", "REFUNDED", "QUITCLAIM", "NO_RESPONSE"]) expect(isClosed(s)).toBe(true);
    expect(caseStatus("QUITCLAIM").label).toBe("Quitclaim signed");
    expect(caseStatus("nope").v).toBe("OPEN");
  });
  it("counts days open", () => {
    expect(daysBetween("2026-11-20", "2026-11-27")).toBe(7);
    expect(daysBetween("2026-11-27", "2026-11-27")).toBe(0);
    expect(daysBetween("2026-11-28", "2026-11-27")).toBe(0);
  });
  it("puts open cases first, oldest first, then the latest closed", () => {
    const c = (id: string, status: string, opened_on: string, closed_on: string | null = null) => ({ id, status, opened_on, closed_on });
    const out = sortCases([c("a", "RESOLVED", "2026-10-01", "2026-10-05"), c("b", "OPEN", "2026-11-20"), c("c", "IN_PROGRESS", "2026-11-01"), c("d", "QUITCLAIM", "2026-09-01", "2026-11-01")]);
    expect(out.map((x) => x.id)).toEqual(["c", "b", "d", "a"]);
  });
});
