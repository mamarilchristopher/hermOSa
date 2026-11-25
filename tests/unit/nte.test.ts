import { describe, expect, it } from "vitest";
import { irReason, tracker, type Nte } from "../../src/lib/nte";

const nte = (o: Partial<Nte>): Nte => ({
  id: Math.random().toString(), nte_no: 1, employee_id: "e1", name: "Vanessa Cruz", position: null, branch: null,
  work_date: "2026-11-03", shift_start: "10:00", time_in: "10:20", late_minutes: 20,
  state: "EXPLAINED", explanation: null, explained_at: null, void_reason: null, ir_id: null, mine: false, can_manage: true, ...o,
});

describe("irReason", () => {
  it("suggests an IR at 3 Late NTEs", () => expect(irReason(3, 45)).toBe("3 Late NTEs"));
  it("suggests an IR before 3 NTEs once minutes pass the limit", () => expect(irReason(2, 75)).toMatch(/75 minutes late, more than the 60-minute limit/));
  it("does not at exactly the limit", () => expect(irReason(2, 60)).toBeNull());
  it("uses the org limit", () => expect(irReason(1, 50, 45)).not.toBeNull());
});

describe("tracker due", () => {
  it("flags someone over 60 minutes with 2 NTEs", () => {
    const [r] = tracker([nte({ late_minutes: 40 }), nte({ late_minutes: 35 })]);
    expect(r.due).toMatch(/75 minutes/);
  });
  it("no flag when everything is already in an IR", () => {
    const [r] = tracker([nte({ late_minutes: 40, ir_id: "x" }), nte({ late_minutes: 35, ir_id: "x" })]);
    expect(r.due).toBeNull();
  });
  it("void NTEs don't count", () => {
    const [r] = tracker([nte({ late_minutes: 40 }), nte({ late_minutes: 35, state: "VOID" })]);
    expect(r.due).toBeNull();
  });
});
