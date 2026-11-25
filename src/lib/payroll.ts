/** Shared payroll helpers (server and browser). */
export const peso = (c: number | null | undefined) =>
  `₱${(Number(c ?? 0) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 1–15, 2026" or "Nov 16–30, 2026" for the cutoff holding the date. */
export function periodLabel(date: string) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= 15 ? `${MO[m - 1]} 1–15, ${y}` : `${MO[m - 1]} 16–${last}, ${y}`;
}

export const manilaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

export const shortDate = (d: string) => `${MO[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

export type PayLine = { label: string; amount: number; adjustment?: string };
export type CommissionItem = { id: string; date: string; service: string; role: string; paid: number; amount: number };
export type Payslip = {
  id: string; slip_no: string; basis: "MONTHLY" | "DAILY"; rate_cents: number;
  earnings: PayLine[]; deductions: PayLine[]; commissions: CommissionItem[];
  attendance: { worked?: number; paid_leave?: number; unpaid_leave?: number; absent?: number; late_min?: number; daily_rate?: number };
  gross_cents: number; deductions_cents: number; net_cents: number;
  name: string; uid: string | null; position: string | null; period_start: string; period_end: string; state: "DRAFT" | "FINAL";
};

export const ROLE_TEXT: Record<string, string> = { SOLO: "Solo", LEAD: "Lead", ASSIST: "Assist" };
