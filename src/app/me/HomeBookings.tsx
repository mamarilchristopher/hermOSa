import Link from "next/link";
import { LiveBookings } from "../bookings/LiveBookings";
import type { requireAccess } from "@/lib/access";

type Db = Awaited<ReturnType<typeof requireAccess>>["supabase"];
/** Today's bookings at every branch, names for "Arrived by Ana", and (for CSRs, owners, the GM) the follow-up count. */
export async function loadHomeBookings(supabase: Db, today: string, booker: boolean) {
  const [{ data: bk }, { data: ppl }, { count }] = await Promise.all([
    supabase.from("bookings").select("id, branch_id, client_name, services, appointment_time, status, status_by, status_at")
      .eq("appointment_date", today).order("appointment_time", { ascending: true, nullsFirst: false }).order("created_at").limit(300),
    supabase.rpc("chat_people"),
    booker ? supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "UNRESPONSIVE") : Promise.resolve({ count: 0 }),
  ]);
  if (!bk) return null; // bookings not set up (before update-0040) or not readable
  const who = Object.fromEntries(((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  return { rows: bk as HomeBooking[], who, toFollow: count ?? 0 };
}

/** One booking on the management Home's live board (today's visits at every branch). */
export type HomeBooking = {
  id: string; branch_id: string; client_name: string; services: string; appointment_time: string | null;
  status: string; status_by: string | null; status_at: string | null;
};

const STATUS: Record<string, [string, string]> = {
  BOOKED: ["Booked", "STAGED"], CONFIRMED: ["Confirmed", "STAGED"], ARRIVED: ["Arrived", "PUBLISHED"], DONE: ["Done", "PUBLISHED"],
  UNRESPONSIVE: ["Unresponsive", "REVERSED"], CANCELLED: ["Cancelled", "REVERSED"],
};
const time12 = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const at = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const first = (n?: string) => (n ?? "").replace(/^ma\.?\s+/i, "").split(" ")[0];

/** CHRIS Nov 26: the live Bookings board sits on Home right after Today so far. It updates by itself (update-0081). */
export function HomeBookings({ rows, branches, who, toFollow }: {
  rows: HomeBooking[]; branches: { id: string; name: string; code?: string }[]; who: Record<string, string>; toFollow: number;
}) {
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const waiting = rows.filter((r) => r.status === "BOOKED" || r.status === "CONFIRMED").length;
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="title-row">Bookings today <LiveBookings /></h2>
        <Link className="small" href="/bookings">Bookings →</Link>
      </div>
      <p className="small muted" style={{ margin: "0 0 10px" }}>
        {rows.length} booked · {waiting} still to come · {n("ARRIVED")} arrived · {n("DONE")} done · {n("UNRESPONSIVE")} unresponsive · {n("CANCELLED")} cancelled
        {toFollow > 0 && <> · <Link href="/bookings/followups">{toFollow} to follow up</Link></>}
      </p>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No bookings for today yet.</p> : (
        <div className="glance-branches home-bookings">
          {branches.map((b) => {
            const list = rows.filter((r) => r.branch_id === b.id);
            return (
              <div key={b.id} className="glance-branch">
                <Link className="small muted" href={`/bookings?b=${b.code ?? ""}`}>{b.name} ({list.length})</Link>
                {list.length === 0 ? <span className="small muted">No bookings</span> : list.map((r) => (
                  <div key={r.id} className="hb-row">
                    <span className="hb-name"><strong>{r.client_name}</strong>{r.appointment_time && <span className="small muted"> {time12(r.appointment_time)}</span>}</span>
                    <span className="small muted hb-svc">{r.services}</span>
                    <span className="small"><span className={`pill ${STATUS[r.status]?.[1] ?? ""}`}>{STATUS[r.status]?.[0] ?? r.status}</span>
                      {r.status !== "BOOKED" && r.status_by && r.status_at && <span className="muted"> by {first(who[r.status_by]) || "staff"}, {at(r.status_at)}</span>}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
