import { describe, expect, it } from "vitest";
import { buildBoard, irStatus, monthDays } from "../../src/lib/tardiness";
import type { Nte } from "../../src/lib/nte";

const nte = (o: Partial<Nte> & { employee_id: string; work_date: string; late_minutes: number }): Nte => ({
  id: `${o.employee_id}-${o.work_date}`, nte_no: 1, name: "DEMO", position: null, branch: null, shift_start: "10:00", time_in: "10:30",
  state: "OPEN", explanation: null, explained_at: null, void_reason: null, ir_id: null, mine: false, can_manage: true, ...o,
});
const people = [
  { id: "a", name: "DEMO Ana", branch: "QC Main", position: "CMA" },
  { id: "b", name: "DEMO Bea", branch: "Fairview", position: "CMA" },
  { id: "c", name: "DEMO Cy", branch: "Fairview", position: "CMA" }, // no shifts: left out
];
const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
const shifts = days.flatMap((d) => [{ employee_id: "a", work_date: d }, { employee_id: "b", work_date: d }]);
const ins = days.slice(0, 3).flatMap((d) => [{ employee_id: "a", work_date: d }, { employee_id: "b", work_date: d }]);

describe("tardiness board", () => {
  it("counts lates, on-time rate and strip days", () => {
    const board = buildBoard({ ym: "2026-11", upTo: "2026-11-04", people, shifts, ins, limit: 60, ntes: [
      nte({ employee_id: "a", work_date: "2026-11-02", late_minutes: 40 }),
      nte({ employee_id: "a", work_date: "2026-11-03", late_minutes: 25 }),
      nte({ employee_id: "b", work_date: "2026-11-02", late_minutes: 20, state: "ACCEPTED" }),
      nte({ employee_id: "b", work_date: "2026-11-03", late_minutes: 20, state: "VOID" }),
    ] });
    expect(board.rows.map((r) => r.id)).toEqual(["a", "b"]);
    const [a, b] = board.rows;
    expect(a.lates).toBe(2); expect(a.worked).toBe(3); expect(a.onTime).toBeCloseTo(1 / 3);
    expect(a.minutes).toBe(65); expect(a.status.key).toBe("due");
    expect(b.lates).toBe(1); expect(b.counted).toBe(0); expect(b.status.key).toBe("ok");
    expect(b.strip.find((d) => d.date === "2026-11-02")?.kind).toBe("excused");
    expect(b.strip.find((d) => d.date === "2026-11-03")?.kind).toBe("ok"); // voided = on time
    expect(a.strip.find((d) => d.date === "2026-11-05")?.kind).toBe("future");
    expect(a.strip.find((d) => d.date === "2026-11-01")?.kind).toBe("off");
    expect(board.kpis.lates).toBe(3); expect(board.kpis.worked).toBe(6); expect(board.kpis.minutes).toBe(85); expect(board.kpis.due).toBe(1);
  });
  it("marks people close to an IR", () => {
    expect(irStatus(2, 30, 2).key).toBe("near");
    expect(irStatus(1, 50, 1)).toEqual({ key: "near", text: "11 min away" });
    expect(irStatus(3, 30, 0).key).toBe("inir");
    expect(irStatus(1, 10, 1).key).toBe("ok");
    expect(monthDays("2026-02")).toHaveLength(28);
  });
});
