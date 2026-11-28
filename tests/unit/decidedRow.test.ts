import { describe, expect, it } from "vitest";
import { decidedRow, type ServiceRecord } from "../../src/lib/serviceRecord";

const r = (decided?: string) => ({ decided } as unknown as ServiceRecord);
describe("v0.102.2 approval row in an entry's details", () => {
  it("approved, rejected, pending, older entries", () => {
    expect(decidedRow(r("Approved by Demo Manager · Nov 26, 2026 · 4:15 PM"))).toEqual([["Approved by", "Demo Manager · Nov 26, 2026 · 4:15 PM"]]);
    expect(decidedRow(r("Rejected by you · Nov 27, 2026 · 9:02 AM"))).toEqual([["Rejected by", "you · Nov 27, 2026 · 9:02 AM"]]);
    expect(decidedRow(r("Pending approval"))).toEqual([["Approval", "Pending approval"]]);
    expect(decidedRow(r("Approved"))).toEqual([["Approved", "Approved"]]);
    expect(decidedRow(r())).toEqual([]);
  });
});
