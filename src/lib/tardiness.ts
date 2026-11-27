// Tardiness dashboard (CHRIS Nov 28, option A "Leaderboard + heat strip"): everyone's punctuality for a month in one view.
// Pure: the page fetches shifts, time-ins and Late NTEs; this turns them into KPIs and one row per person.
import { IR_NTE_COUNT, IR_MINUTES_DEFAULT, tracker, type Nte } from "./nte";

export type ShiftDay = { employee_id: string; work_date: string };
export type Person = { id: string; name: string; uid?: string | null; branch: string | null; position: string | null };

/** One day of a person's month. off = no shift; absent = shift but no time-in; ok = on time; late = Late NTE (excused = reason accepted). */
export type StripDay = { date: string; kind: "off" | "future" | "absent" | "ok" | "late" | "excused"; minutes?: number };

export type Status = { key: "due" | "inir" | "near" | "ok"; text: string };
export type BoardRow = Person & {
  worked: number; lates: number; onTime: number | null; lateMinutes: number; // every Late NTE not voided
  counted: number; minutes: number; // counted toward an IR (voided and accepted ones don't count)
  status: Status; strip: StripDay[];
};
export type Kpis = { onTime: number | null; lates: number; minutes: number; near: number; due: number; worked: number };
export type Board = { rows: BoardRow[]; kpis: Kpis; limit: number };

const pad = (n: number) => String(n).padStart(2, "0");
export const monthDays = (ym: string): string[] => {
  const n = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`);
};

/** Where someone stands against the IR rule (3 counted Late NTEs, or more than `limit` minutes, in a month). */
export function irStatus(count: number, minutes: number, notInIr: number, limit = IR_MINUTES_DEFAULT): Status {
  if (count > 0 && notInIr === 0) return { key: "inir", text: "In an IR" };
  if (count >= IR_NTE_COUNT || minutes > limit) return { key: "due", text: "IR due" };
  if (count === IR_NTE_COUNT - 1 || minutes > limit * 0.75) return { key: "near", text: count === IR_NTE_COUNT - 1 ? "1 NTE away" : `${limit - minutes + 1} min away` };
  return { key: "ok", text: "OK" };
}

function kpisOf(rows: Pick<BoardRow, "worked" | "lates" | "lateMinutes" | "status">[]): Kpis {
  const worked = rows.reduce((s, r) => s + r.worked, 0);
  const lates = rows.reduce((s, r) => s + r.lates, 0);
  return {
    worked, lates,
    onTime: worked ? Math.max(0, worked - lates) / worked : null,
    minutes: rows.reduce((s, r) => s + r.lateMinutes, 0),
    due: rows.filter((r) => r.status.key === "due").length,
    near: rows.filter((r) => r.status.key === "near").length,
  };
}

/**
 * One row per person who had a working shift (or a Late NTE) in the month, worst first.
 * `upTo` = the last day that counts (today for this month). Lates = every Late NTE that wasn't voided, so the on-time
 * rate is honest; the IR columns use the tracker's count (accepted reasons don't count), as on the Late NTEs page.
 */
export function buildBoard(input: {
  ym: string; upTo: string; people: Person[]; shifts: ShiftDay[]; ins: ShiftDay[]; ntes: Nte[]; limit?: number;
}): Board {
  const limit = input.limit ?? IR_MINUTES_DEFAULT;
  const days = monthDays(input.ym);
  const key = (e: string, d: string) => `${e}|${d}`;
  const shift = new Set(input.shifts.filter((s) => s.work_date.startsWith(input.ym)).map((s) => key(s.employee_id, s.work_date)));
  const timedIn = new Set(input.ins.filter((s) => s.work_date.startsWith(input.ym)).map((s) => key(s.employee_id, s.work_date)));
  const ntes = input.ntes.filter((n) => n.state !== "VOID" && n.work_date.startsWith(input.ym));
  const late = new Map(ntes.map((n) => [key(n.employee_id, n.work_date), n]));
  const counted = new Map(tracker(input.ntes.filter((n) => n.work_date.startsWith(input.ym)), limit).map((r) => [r.employee_id, r]));
  const withShift = new Set([...shift].map((k) => k.split("|")[0]));
  const withNte = new Set(ntes.map((n) => n.employee_id));

  const rows: BoardRow[] = input.people.filter((p) => withShift.has(p.id) || withNte.has(p.id)).map((p) => {
    const strip: StripDay[] = days.map((date) => {
      const k = key(p.id, date), n = late.get(k);
      if (n) return { date, kind: n.state === "ACCEPTED" || n.review === "ACCEPTED" ? "excused" : "late", minutes: n.late_minutes };
      if (date > input.upTo) return { date, kind: shift.has(k) ? "future" : "off" };
      if (timedIn.has(k)) return { date, kind: shift.has(k) ? "ok" : "off" };
      return { date, kind: shift.has(k) ? "absent" : "off" };
    });
    const lates = strip.filter((d) => d.kind === "late" || d.kind === "excused").length;
    const worked = strip.filter((d) => d.kind === "ok").length + lates;
    const t = counted.get(p.id);
    return {
      ...p, worked, lates, onTime: worked ? (worked - lates) / worked : null,
      lateMinutes: strip.reduce((s, d) => s + (d.minutes ?? 0), 0),
      counted: t?.count ?? 0, minutes: t?.minutes ?? 0,
      status: irStatus(t?.count ?? 0, t?.minutes ?? 0, t?.notInIr ?? 0, limit), strip,
    };
  });
  const rank: Record<Status["key"], number> = { due: 0, inir: 1, near: 2, ok: 3 };
  rows.sort((a, b) => rank[a.status.key] - rank[b.status.key] || b.counted - a.counted || b.minutes - a.minutes
    || b.lates - a.lates || (a.onTime ?? 1) - (b.onTime ?? 1) || a.name.localeCompare(b.name));
  return { rows, kpis: kpisOf(rows), limit };
}
