// CHRIS Nov 28 (v0.106.2, matching improved v0.106.3): Home branch tiles show clients and services logged that day,
// bookings marked Arrived, and which arrived bookings have no Service log entry yet.
// A booking is "logged" when an entry links to it (logged from Bookings), else when a logged client's name matches the
// booking's FB name or waiver name. Bookings carry the FB name, entries the waiver name, so names match loosely
// (accents, "Ma.", punctuation and particles ignored; two shared name words, or a shared surname), one entry client per booking.

export type BranchCount = { clients: number; services: number; arrived: number; notLogged: number; unlogged: string[] };
export type ArrivalLog = { id: string; branch_id: string; client_name: string | null; booking_id: string | null; is_meds: boolean };
export type ArrivalBooking = { id: string; branch_id: string; client_name: string | null; waiver_name: string | null };

const PARTICLES = new Set(["ma", "maria", "de", "del", "dela", "delos", "los", "la", "san", "sta", "sto", "jr", "sr", "ii", "iii", "iv", "mrs", "ms", "mr", "miss"]);

export function normName(v: string | null | undefined): string {
  return (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\bma\.\s*/g, "ma ").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
}
const words = (n: string) => n.split(" ").filter((w) => w.length >= 2 && !PARTICLES.has(w));

/** 3 = same name, 2 = two name words shared, 1 = shares the surname (last word) or a one-word FB name. 0 = no match. */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y || x.replace(/ /g, "") === y.replace(/ /g, "")) return 3;
  const wx = words(x), wy = words(y);
  if (!wx.length || !wy.length) return 0;
  const shared = wx.filter((w) => wy.includes(w));
  if (shared.length >= 2) return 2;
  if (shared.length === 1) {
    const s = shared[0];
    if (s === wx[wx.length - 1] || s === wy[wy.length - 1] || wx.length === 1 || wy.length === 1) return 1;
  }
  return 0;
}

export function countArrivals(logs: ArrivalLog[], bookings: ArrivalBooking[]): Record<string, BranchCount> {
  const out: Record<string, BranchCount> = {};
  const at = (b: string) => (out[b] ??= { clients: 0, services: 0, arrived: 0, notLogged: 0, unlogged: [] });
  // Clients per branch: one per distinct name (an entry with no name counts on its own).
  const clients = new Map<string, Map<string, { name: string; used: boolean }>>();
  const linked = new Set<string>();
  const clientOfBooking = new Map<string, string>();
  for (const l of logs) {
    const c = at(l.branch_id);
    if (!l.is_meds) c.services += 1;
    const key = normName(l.client_name) || `#${l.id}`;
    if (!clients.has(l.branch_id)) clients.set(l.branch_id, new Map());
    const m = clients.get(l.branch_id)!;
    if (!m.has(key)) m.set(key, { name: l.client_name ?? "", used: false });
    if (l.booking_id) { linked.add(l.booking_id); clientOfBooking.set(l.booking_id, key); }
  }
  for (const [b, m] of clients) at(b).clients = m.size;
  const open: ArrivalBooking[] = [];
  for (const k of bookings) {
    at(k.branch_id).arrived += 1;
    if (linked.has(k.id)) {
      const m = clients.get(k.branch_id);
      const key = clientOfBooking.get(k.id);
      if (m && key && m.has(key)) m.get(key)!.used = true;
    } else open.push(k);
  }
  // Best name matches first, each logged client used once.
  const pairs: { k: ArrivalBooking; key: string; s: number }[] = [];
  for (const k of open) {
    for (const [key, v] of clients.get(k.branch_id) ?? []) {
      if (v.used || key.startsWith("#")) continue;
      const s = Math.max(nameScore(k.client_name, v.name), nameScore(k.waiver_name, v.name));
      if (s > 0) pairs.push({ k, key, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  const done = new Set<string>();
  for (const p of pairs) {
    const v = clients.get(p.k.branch_id)!.get(p.key)!;
    if (done.has(p.k.id) || v.used) continue;
    v.used = true; done.add(p.k.id);
  }
  for (const k of open) if (!done.has(k.id)) {
    const c = at(k.branch_id);
    c.notLogged += 1;
    c.unlogged.push((k.waiver_name || k.client_name || "No name").trim());
  }
  return out;
}
