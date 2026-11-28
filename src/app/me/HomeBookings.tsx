import Link from "next/link";
import { LiveBookings } from "../bookings/LiveBookings";
import { LogSale, QuickStatus } from "../bookings/Receive";
import type { requireAccess } from "@/lib/access";

type Db = Awaited<ReturnType<typeof requireAccess>>["supabase"];
/** Today's bookings at every branch, names for "Arrived by Ana", and (for CSRs, owners, the GM) the follow-up count. */
export async function loadHomeBookings(supabase: Db, today: string, booker: boolean) {
  const [{ data: bk }, { data: ppl }, { count }] = await Promise.all([
    supabase.from("bookings").select("id, branch_id, client_name, waiver_name, services, appointment_time, status, status_by, status_at")
      .eq("appointment_date", today).order("appointment_time", { ascending: true, nullsFirst: false }).order("created_at").limit(300),
    supabase.rpc("chat_people"),
    booker ? supabase.from("bookings").select("id", { count: "exact", head: true }).in("status", ["UNRESPONSIVE", "NO_SHOW"]) : Promise.resolve({ count: 0 }),
  ]);
  if (!bk) return null; // bookings not set up (before update-0040) or not readable
  const who = Object.fromEntries(((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  // v0.106.6: which bookings already have their sale in the Service log (linked entry), with its SL number.
  const ids = (bk as { id: string }[]).map((r) => r.id);
  const { data: linked } = ids.length ? await supabase.from("service_logs").select("booking_id, log_no, merged_into").in("booking_id", ids).neq("state", "REJECTED") : { data: [] };
  const sold: Record<string, string> = {};
  for (const l of (linked ?? []) as { booking_id: string; log_no: string | null; merged_into: string | null }[]) if (!sold[l.booking_id] || !l.merged_into) sold[l.booking_id] = l.log_no ?? "logged";
  return { rows: bk as HomeBooking[], who, toFollow: count ?? 0, sold };
}

/** One booking on the management Home's live board (today's visits at every branch). */
export type HomeBooking = {
  id: string; branch_id: string; client_name: string; waiver_name?: string | null; services: string; appointment_time: string | null;
  status: string; status_by: string | null; status_at: string | null;
};

const STATUS: Record<string, [string, string]> = {
  BOOKED: ["Booked", "STAGED"], CONFIRMED: ["Confirmed", "STAGED"], ARRIVING: ["Arriving", "ARRIVING"], ARRIVED: ["Arrived", "PUBLISHED"], DONE: ["Done", "PUBLISHED"],
  NO_SHOW: ["Did not arrive", "REVERSED"], UNRESPONSIVE: ["Unresponsive", "REVERSED"], CANCELLED: ["Cancelled", "REVERSED"],
};
const time12 = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const at = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const toCome = (l: HomeBooking[]) => l.filter((r) => r.status === "BOOKED" || r.status === "CONFIRMED" || r.status === "ARRIVING").length;
const first = (n?: string) => (n ?? "").replace(/^ma\.?\s+/i, "").split(" ")[0];

/** CHRIS Nov 26: the live Bookings board sits on Home right after Today so far. It updates by itself (update-0081). */
export function HomeBookings({ rows, branches, who, toFollow, sold = {}, markable = [], loggable = [] }: {
  rows: HomeBooking[]; branches: { id: string; name: string; code?: string }[]; who: Record<string, string>; toFollow: number;
  sold?: Record<string, string>; markable?: string[]; loggable?: string[];
}) {
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const waiting = toCome(rows);
  const unlogged = rows.filter((r) => (r.status === "ARRIVED" || r.status === "DONE") && !sold[r.id]).length;
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="title-row">Bookings today <LiveBookings /></h2>
        <Link className="small" href="/bookings">Bookings →</Link>
      </div>
      <p className="small muted" style={{ margin: "0 0 10px" }}>
        {rows.length} booked · {waiting} still to come · {n("ARRIVING")} arriving · <span className={unlogged ? "arr-bad" : ""}>{unlogged} arrived, sale not logged</span> · {Object.keys(sold).filter((id) => rows.some((r) => r.id === id)).length} sale logged · {n("NO_SHOW")} did not arrive · {n("UNRESPONSIVE")} unresponsive · {n("CANCELLED")} cancelled
        {toFollow > 0 && <> · <Link href="/bookings/followups">{toFollow} to follow up</Link></>}
      </p>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No bookings for today yet.</p> : (
        <div className="glance-branches home-bookings">
          {branches.map((b) => {
            const list = rows.filter((r) => r.branch_id === b.id);
            return (
              <div key={b.id} className="glance-branch">
                {/* CHRIS Nov 26 (v0.82.1): a bold band per branch so each list is easy to tell apart. */}
                <Link className="hb-branch" href={`/bookings?b=${b.code ?? ""}`}>
                  <span className="hb-branch-name">{b.name}</span>
                  <span className="hb-branch-count">{list.length} {list.length === 1 ? "booking" : "bookings"}</span>
                </Link>
                {list.length > 0 && <span className="small muted hb-branch-sum">{toCome(list)} to come · {list.filter((r) => (r.status === "ARRIVED" || r.status === "DONE") && !sold[r.id]).length} arrived, sale not logged · {list.filter((r) => sold[r.id]).length} sale logged</span>}
                {list.length === 0 ? <span className="small muted">No bookings</span> : list.map((r) => {
                  // v0.106.6 (CHRIS Nov 28): receiving runs from here. Each booking shows its next step.
                  const focus = `/bookings?b=${b.code ?? ""}&focus=${r.id}#bk-${r.id}`;
                  const sl = sold[r.id];
                  const arrived = r.status === "ARRIVED" || r.status === "DONE";
                  // CHRIS Nov 28: once the client has arrived, tapping their name logs their sale (from the booking).
                  const logHref = arrived && !sl && b.code && loggable.includes(r.branch_id) ? `/services?branch=${b.code}&booking=${r.id}#add` : null;
                  return (
                    <div key={r.id} className={`hb-row${arrived && !sl ? " hb-unlogged" : ""}`}>
                      {/* CHRIS Nov 26: tapping a client opens their booking on the Bookings page (scrolled to and highlighted). */}
                      <Link className="hb-row-main" href={logHref ?? focus}>
                        <span className="hb-name"><strong>{r.waiver_name ?? r.client_name}</strong>{r.appointment_time && <span className="small muted"> {time12(r.appointment_time)}</span>}</span>
                        <span className="small muted hb-svc">{r.services}</span>
                        <span className="small"><span className={`pill ${sl ? "PUBLISHED" : STATUS[r.status]?.[1] ?? ""}`}>{sl ? "Done" : STATUS[r.status]?.[0] ?? r.status}</span>
                          {r.status !== "BOOKED" && r.status_by && r.status_at && <span className="muted"> by {first(who[r.status_by]) || "staff"}, {at(r.status_at)}</span>}</span>
                      </Link>
                      {sl ? <span className="rcv-done small">✓ Sale logged{sl !== "logged" ? ` · ${sl}` : ""}</span>
                        : arrived ? (logHref
                          ? <LogSale booking={r.id} href={logHref} linkHref={focus} />
                          : <span className="rcv-wait small">Sale not logged yet</span>)
                        : ["BOOKED", "CONFIRMED", "ARRIVING"].includes(r.status) && markable.includes(r.branch_id) ? <QuickStatus id={r.id} status={r.status} /> : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
