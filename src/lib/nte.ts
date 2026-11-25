/** Late NTE (Notice to Explain): one per late time-in, past the grace period (update-0029). */
export type Nte = {
  id: string; nte_no: number; employee_id: string; name: string; position: string | null; branch: string | null;
  work_date: string; shift_start: string; time_in: string; late_minutes: number;
  state: "OPEN" | "EXPLAINED" | "VOID"; explanation: string | null; explained_at: string | null; void_reason: string | null;
  ir_id: string | null; mine: boolean; can_manage: boolean;
};
export type NteList = { month: string; grace: number; ntes: Nte[] };

export type TrackerRow = { employee_id: string; name: string; position: string | null; count: number; minutes: number; open: number; notInIr: number };

/** Per person for the month: Late NTEs (voided ones don't count), most first. */
export function tracker(ntes: Nte[]): TrackerRow[] {
  const by = new Map<string, TrackerRow>();
  for (const n of ntes) {
    if (n.state === "VOID" || !n.can_manage) continue;
    const r = by.get(n.employee_id) ?? { employee_id: n.employee_id, name: n.name, position: n.position, count: 0, minutes: 0, open: 0, notInIr: 0 };
    r.count += 1; r.minutes += n.late_minutes;
    if (n.state === "OPEN") r.open += 1;
    if (!n.ir_id) r.notInIr += 1;
    by.set(n.employee_id, r);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.name.localeCompare(b.name));
}

export const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
export const nteCount = (n: number) => `${n} Late NTE${n === 1 ? "" : "s"}`;
