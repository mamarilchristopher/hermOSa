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

/** Short names for the by-branch grid, like the owner's sheet: first name, plus a last initial when two share it. */
export function shortNames(people: { id: string; name: string }[]): Record<string, string> {
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const count = new Map<string, number>();
  for (const p of people) count.set(first(p.name).toLowerCase(), (count.get(first(p.name).toLowerCase()) ?? 0) + 1);
  return Object.fromEntries(people.map((p) => {
    const parts = p.name.trim().split(/\s+/);
    const f = parts[0] ?? p.name;
    return [p.id, (count.get(f.toLowerCase()) ?? 0) > 1 && parts.length > 1 ? `${f} ${parts[parts.length - 1][0]}.` : f];
  }));
}
export const LEAVE_TEXT: Record<string, string> = { VL: "VL", SL: "SL", ABSENT: "Absent" };

/** Coordinates from a Google Maps link or a "lat, lng" pair. Short links (maps.app.goo.gl) can't be read. */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const t = decodeURIComponent(text.trim());
  const pats = [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /^\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?$/];
  for (const p of pats) {
    const m = t.match(p);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}
