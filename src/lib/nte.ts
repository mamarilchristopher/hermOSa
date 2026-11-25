/** Late NTE (Notice to Explain): one per late time-in, past the grace period (update-0029). */
export type Nte = {
  id: string; nte_no: number; employee_id: string; name: string; position: string | null; branch: string | null;
  work_date: string; shift_start: string; time_in: string; late_minutes: number;
  state: "OPEN" | "EXPLAINED" | "VOID"; explanation: string | null; explained_at: string | null; void_reason: string | null;
  ir_id: string | null; mine: boolean; can_manage: boolean;
};
/** ir_minutes = monthly late-minutes limit (organizations.ir_late_minutes, default 60). */
export type NteList = { month: string; grace: number; ir_minutes?: number; ntes: Nte[] };

/** An IR is suggested at 3 Late NTEs in a month, or earlier once total minutes late pass the limit (CHRIS, Nov 25). */
export const IR_NTE_COUNT = 3;
export const IR_MINUTES_DEFAULT = 60;
export function irReason(count: number, minutes: number, limit = IR_MINUTES_DEFAULT): string | null {
  if (count >= IR_NTE_COUNT) return `${count} Late NTEs`;
  if (minutes > limit) return `${minutes} minutes late, more than the ${limit}-minute limit`;
  return null;
}

export type TrackerRow = { employee_id: string; name: string; position: string | null; count: number; minutes: number; open: number; notInIr: number; due: string | null };

/** Per person for the month: Late NTEs (voided ones don't count), most first; `due` says why an IR is suggested. */
export function tracker(ntes: Nte[], limit = IR_MINUTES_DEFAULT): TrackerRow[] {
  const by = new Map<string, TrackerRow>();
  for (const n of ntes) {
    if (n.state === "VOID" || !n.can_manage) continue;
    const r = by.get(n.employee_id) ?? { employee_id: n.employee_id, name: n.name, position: n.position, count: 0, minutes: 0, open: 0, notInIr: 0, due: null };
    r.count += 1; r.minutes += n.late_minutes;
    if (n.state === "OPEN") r.open += 1;
    if (!n.ir_id) r.notInIr += 1;
    by.set(n.employee_id, r);
  }
  for (const r of by.values()) r.due = r.notInIr > 0 ? irReason(r.count, r.minutes, limit) : null;
  return [...by.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.name.localeCompare(b.name));
}

export const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
export const nteCount = (n: number) => `${n} Late NTE${n === 1 ? "" : "s"}`;
