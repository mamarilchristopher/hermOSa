// Weekly schedule helpers. Weeks run Monday to Sunday (Manila dates, YYYY-MM-DD).
import { addDays, weekday } from "./insights";

export const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));
export const weekDates = (monday: string) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (d: string) => `${MO[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
export const weekLabel = (monday: string) => `${shortDate(monday)} – ${shortDate(addDays(monday, 6))}`;

/** "10:00:00" -> "10 AM", "13:30" -> "1:30 PM" */
export function timeLabel(t: string | null | undefined): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hh = h % 12 || 12;
  return `${hh}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
/** Short branch tag for grid cells: "QC Main" -> "QC Main", "Sta. Maria Bulacan" -> "Sta. Maria". */
export const branchShort = (name: string) => name.replace(/\s*\(.*\)$/, "").replace(/ Bulacan$/, "").replace(/^Quezon City /, "QC ");
