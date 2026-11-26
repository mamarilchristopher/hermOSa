/** Late NTE (Notice to Explain): one per late time-in, past the grace period (update-0030). */
export type Nte = {
  id: string; nte_no: number; employee_id: string; name: string; uid?: string; position: string | null; branch: string | null;
  work_date: string; shift_start: string; time_in: string; late_minutes: number; respond_by?: string | null;
  state: "OPEN" | "EXPLAINED" | "VOID"; explanation: string | null; proof_paths?: string[] | null; explained_at: string | null; void_reason: string | null;
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

export type TrackerRow = { employee_id: string; name: string; uid?: string; position: string | null; count: number; minutes: number; open: number; notInIr: number; due: string | null };

/** Per person for the month: Late NTEs (voided ones don't count), most first; `due` says why an IR is suggested. */
export function tracker(ntes: Nte[], limit = IR_MINUTES_DEFAULT): TrackerRow[] {
  const by = new Map<string, TrackerRow>();
  for (const n of ntes) {
    if (n.state === "VOID" || !n.can_manage) continue;
    const r = by.get(n.employee_id) ?? { employee_id: n.employee_id, name: n.name, uid: n.uid, position: n.position, count: 0, minutes: 0, open: 0, notInIr: 0, due: null };
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

/**
 * The time left to explain a Late NTE (update-0032): until the end of `respondBy` (Manila), which is the employee's
 * next scheduled working day after the late day, so 2 working days counting the late day. NULL = not scheduled yet.
 */
export function nteDeadline(respondBy: string | null | undefined, now = Date.now()): { text: string; urgent: boolean; overdue: boolean } {
  if (!respondBy) return { text: "Explain by the end of your next scheduled working day, or an IR is issued automatically.", urgent: false, overdue: false };
  const end = Date.parse(`${respondBy}T23:59:59+08:00`);
  const left = end - now;
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(`${respondBy}T12:00:00+08:00`);
  const label = `${DW[d.getUTCDay()]}, ${MO[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (left <= 0) return { text: `The deadline (end of ${label}) has passed. An IR is issued automatically.`, urgent: true, overdue: true };
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
  const span = h >= 24 ? `${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? "" : "s"} ${h % 24} hour${h % 24 === 1 ? "" : "s"}` : h > 0 ? `${h} hour${h === 1 ? "" : "s"} ${m} min` : `${m} min`;
  return { text: `${span} left: explain by the end of ${label}, or an IR is issued automatically.`, urgent: h < 24, overdue: false };
}
