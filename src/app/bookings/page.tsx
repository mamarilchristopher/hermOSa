import { sortServices } from "@/lib/serviceOrder";
import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { AddBookingForm, CopyForGc, NoteForm, StatusForm } from "./Forms";
import { LiveBookings } from "./LiveBookings";

type Booking = {
  id: string; booked_on: string; csr_employee_id: string | null; client_name: string; contact: string | null; platform: string; services: string;
  expected_cents: number | null; appointment_date: string; appointment_time: string | null; branch_id: string; deposit_cents: number | null; follow_up: boolean; note: string | null;
  status: string; resched_count: number; rescheduled_from: string | null; status_note: string | null; status_by: string | null; status_at: string | null;
};

const STATUS: Record<string, [string, string]> = {
  BOOKED: ["Booked", "STAGED"], CONFIRMED: ["Confirmed", "STAGED"], ARRIVED: ["Arrived", "PUBLISHED"], DONE: ["Done", "PUBLISHED"],
  UNRESPONSIVE: ["Unresponsive", "REVERSED"], CANCELLED: ["Cancelled", "REVERSED"],
};
const GC_NAME: Record<string, string> = { QC_MAIN: "MAIN", FAIRVIEW: "FAIRVIEW", STA_MARIA: "SMB", MARIKINA: "MARIKINA" };
const GC_STATUS: Record<string, string> = { ARRIVED: "ARRIVED", DONE: "DONE", UNRESPONSIVE: "UNRESPONSIVE", CANCELLED: "CANCELLED", CONFIRMED: "CONFIRMED" };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const mdy = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(2, 4)}`;
const time12 = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const peso = (c: number) => `₱${(c / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;

/** Online bookings (update-0040): CSRs log Facebook bookings; each branch marks its visits; everyone sees the day live. */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ d?: string; b?: string }> }) {
  const sp = await searchParams;
  const { supabase, access, branches } = await requireAccess();
  const today = manilaToday();
  const day = isIsoDate(sp.d) ? sp.d : today;
  const booker = can(access, ["CSR", "OWNER"], null) || can(access, ["MANAGER"], null);
  // CHRIS Nov 26 (update-0071): every employee sees every branch's bookings; marking stays with bookers and that branch's staff.
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const canMark = (branchId: string) => booker || can(access, ["MANAGER", "CLINICIAN", "CASHIER"], branchId);
  const only = clinics.find((b) => b.code === sp.b);
  const shown = only ? [only] : clinics;

  // Bookings FOR this day (the visit date), plus any that were moved away from it (CHRIS Nov 26).
  const cols = "id, booked_on, csr_employee_id, client_name, contact, platform, services, appointment_date, appointment_time, branch_id, deposit_cents, expected_cents, follow_up, note, status, resched_count, rescheduled_from, status_note, status_by, status_at";
  const forDay = (withMoves: boolean) => supabase.from("bookings").select(cols)
    .or(`appointment_date.eq.${day},rescheduled_from.eq.${day}${withMoves ? `,moved_from.cs.{${day}}` : ""}`)
    .order("appointment_time", { ascending: true, nullsFirst: false }).order("created_at").limit(500);
  const [first, { data: emps }, { data: madeToday }, { data: svcs }, { data: ppl }, { count: toFollow }] = await Promise.all([
    forDay(true),
    supabase.from("employees").select("id, full_name"),
    booker ? supabase.from("bookings").select("csr_employee_id, expected_cents").eq("booked_on", day).limit(2000) : Promise.resolve({ data: [] }),
    booker ? supabase.from("services").select("name, price_cents").eq("active", true).order("name") : Promise.resolve({ data: [] }),
    supabase.rpc("chat_people"), // names, for "Arrived · by Ana, 3:05 PM"
    // update-0081: Unresponsive bookings waiting on Sales follow-ups (CSRs, owners and the GM).
    booker ? supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "UNRESPONSIVE") : Promise.resolve({ count: 0 }),
  ]);
  const who = new Map(((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const at = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
  const firstName = (n?: string) => (n ?? "").replace(/^ma\.?\s+/i, "").split(" ")[0];
  // moved_from comes with update-0071; until it runs, fall back to the last move only.
  const { data, error } = first.error?.code === "42703" ? await forDay(false) : first;
  const rows = (data ?? []) as Booking[];
  const name = new Map(((emps ?? []) as { id: string; full_name: string }[]).map((e) => [e.id, e.full_name]));
  const perCsr = new Map<string, number>(), perCsrValue = new Map<string, number>();
  for (const r of (madeToday ?? []) as { csr_employee_id: string | null; expected_cents: number | null }[]) {
    const k = r.csr_employee_id ?? "";
    perCsr.set(k, (perCsr.get(k) ?? 0) + 1);
    perCsrValue.set(k, (perCsrValue.get(k) ?? 0) + (r.expected_cents ?? 0));
  }
  const moved = (r: Booking) => r.appointment_date !== day;
  const byBranch = shown.map((b) => ({ b, list: rows.filter((r) => r.branch_id === b.id) }));
  const live = rows.filter((r) => !moved(r) && shown.some((b) => b.id === r.branch_id));
  const count = (s: string) => live.filter((r) => r.status === s).length;
  // Expected value (CHRIS): owners and managers see what the day's bookings are worth, and how much of it showed up.
  const seesValue = can(access, ["OWNER", "MANAGER"], null) || clinics.some((b) => can(access, ["MANAGER"], b.id));
  const worth = (list: Booking[]) => list.reduce((t, r) => t + (r.expected_cents ?? 0), 0);
  const open = (list: Booking[]) => list.filter((r) => !moved(r) && r.status !== "CANCELLED" && r.status !== "UNRESPONSIVE");
  const came = (list: Booking[]) => list.filter((r) => !moved(r) && (r.status === "ARRIVED" || r.status === "DONE"));
  const noValue = open(live).filter((r) => r.expected_cents == null).length;

  // Same layout as the CSR group chat: branch, then "number name" (dashes when there's no number), then the status.
  const gc = [mdy(day), ""].concat(byBranch.filter((x) => x.list.length).flatMap(({ b, list }) => [
    GC_NAME[b.code] ?? b.name.toUpperCase(),
    ...list.flatMap((r) => {
      const line = `${r.contact ?? "----------"} ${r.client_name}${r.note ? ` (${r.note})` : ""}`;
      const st = moved(r) ? `RE-SCHED (${mdy(r.appointment_date)}${r.deposit_cents ? " w/ dp" : ""})` : GC_STATUS[r.status];
      const extra = r.status_note && !moved(r) ? r.status_note.toUpperCase() : "";
      return [line, ...(st ? [st] : []), ...(extra && extra !== st ? [extra] : [])];
    }),
    "",
  ])).join("\n").trim();

  const href = (d: string, b?: string) => `/bookings?d=${d}${(b ?? sp.b) ? `&b=${b ?? sp.b}` : ""}`;
  return (
    <>
      <TopBar access={access} />
      <main>
        <h1 className="title-row">Bookings <LiveBookings /></h1>
        <p className="muted small">{booker ? "Log each booking here, from Facebook, calls, texts or walk-ins. The branch marks Arrived or Done, and you see it right away." : "Who is booked for this day at every branch, and their status. Your branch taps Arrived when they come in and Done when finished."}</p>
        {error && <div className="notice info">{error.code === "42P01" ? "The owner needs to run update-0040 in Supabase first." : "Could not load. Try again."}</div>}

        <div className="card">
          <div className="booking-nav">
            <Link className="secondary small button" href={href(addDays(day, -1))}>‹ Prev</Link>
            <strong>{fmt(day)}{day === today ? " (today)" : ""}</strong>
            <Link className="secondary small button" href={href(addDays(day, 1))}>Next ›</Link>
            {day !== today && <Link className="small" href={href(today)}>Today</Link>}
          </div>
          {clinics.length > 1 && (
            <div className="booking-nav small">
              <Link href={`/bookings?d=${day}`} className={!only ? "on" : ""}>All branches</Link>
              {clinics.map((b) => <Link key={b.id} href={`/bookings?d=${day}&b=${b.code}`} className={only?.id === b.id ? "on" : ""}>{GC_NAME[b.code] ?? b.name}</Link>)}
            </div>
          )}
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            {live.length} booked · {count("ARRIVED")} arrived · {count("DONE")} done · {count("UNRESPONSIVE")} unresponsive · {rows.filter(moved).length} re-sched · {count("CANCELLED")} cancelled
          </p>
          {seesValue && live.length > 0 && (
            <p style={{ margin: "8px 0 0" }}>
              Expected value: <strong>{peso(worth(open(live)))}</strong> · arrived or done: <strong>{peso(worth(came(live)))}</strong>
              {noValue > 0 && <span className="small muted"> · {noValue} booking{noValue === 1 ? "" : "s"} without a value</span>}
            </p>
          )}
          {booker && (toFollow ?? 0) > 0 && <p className="small" style={{ margin: "8px 0 0" }}><Link href="/bookings/followups">{toFollow} unresponsive client{toFollow === 1 ? "" : "s"} to follow up ›</Link></p>}
          {rows.length > 0 && <div style={{ marginTop: 8 }}><CopyForGc text={gc} /></div>}
        </div>

        {booker && (
          // At the top (CHRIS Nov 25): management also books calls, walk-ins and texts, not only CSRs' online bookings.
          <details className="card add-booking">
            <summary><strong>+ Add a booking</strong> <span className="small muted">online, call, text or walk-in</span></summary>
            <AddBookingForm branches={clinics.map((b) => ({ id: b.id, name: b.name }))} today={day < today ? today : day} min={addDays(today, -30)} max={addDays(today, 365)} services={sortServices((svcs ?? []) as { name: string; price_cents: number | null }[]).map((x) => ({ name: x.name, price: x.price_cents }))} />
          </details>
        )}

        {byBranch.map(({ b, list }) => (
          <div className="card" key={b.id}>
            <h2>{b.name} ({list.filter((r) => !moved(r)).length}){seesValue && worth(open(list)) > 0 && <span className="small muted" style={{ fontWeight: 500 }}> · expected {peso(worth(open(list)))}</span>}</h2>
            {list.length === 0 && <p className="muted small" style={{ margin: 0 }}>No bookings.</p>}
            {list.map((r) => (
              <div key={r.id} className="booking-row">
                <p style={{ margin: "0 0 2px" }}>
                  <strong>{r.client_name}</strong>{" "}
                  {r.contact ? <a className="small" href={`tel:${r.contact.replace(/\s/g, "")}`}>{r.contact}</a> : <span className="small muted">no number</span>}{" "}
                  {moved(r) ? <span className="pill REVERSED">Re-sched to {fmt(r.appointment_date)}</span> : <span className={`pill ${STATUS[r.status]?.[1] ?? ""}`}>{STATUS[r.status]?.[0] ?? r.status}</span>}
                </p>
                <p className="small" style={{ margin: "0 0 2px" }}>
                  {r.services}
                  {seesValue && r.expected_cents ? ` · ${peso(r.expected_cents)}` : ""}
                  {r.appointment_time && ` · ${time12(r.appointment_time)}`}
                  {r.deposit_cents ? ` · DP ${peso(r.deposit_cents)}` : ""}
                  {r.follow_up && " · Follow-up session"}
                  {r.resched_count > 0 && !moved(r) && ` · moved ${r.resched_count}x${r.rescheduled_from ? ` (was ${fmt(r.rescheduled_from)})` : ""}`}
                </p>
                <p className="small muted" style={{ margin: "0 0 6px" }}>
                  {r.note && <>“{r.note}” · </>}
                  {r.status_note && <>{r.status_note} · </>}
                  {r.status_by && r.status_at && r.status !== "BOOKED" && !moved(r) && <>{STATUS[r.status]?.[0] ?? r.status} by {firstName(who.get(r.status_by)) || "staff"}, {at(r.status_at)} · </>}
                  Logged {fmt(r.booked_on)}{r.csr_employee_id && name.get(r.csr_employee_id) ? ` by ${name.get(r.csr_employee_id)}` : r.csr_employee_id ? "" : " by owner / GM"}
                  {r.platform !== "FACEBOOK" && ` · ${r.platform.replace("_", "-").toLowerCase()}`}
                </p>
                {!moved(r) && canMark(r.branch_id) && <><StatusForm id={r.id} status={r.status} booker={booker} today={today} /> <NoteForm id={r.id} note={r.status_note} /></>}
              </div>
            ))}
          </div>
        ))}

        {booker && perCsr.size > 0 && (
          <div className="card">
            <h2>Booked on {fmt(day)}</h2>
            {[...perCsr.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => (
              <p key={id} className="small" style={{ margin: "0 0 2px" }}><strong>{n}</strong> · {name.get(id) ?? "Owner / GM"}{seesValue && perCsrValue.get(id) ? ` · ${peso(perCsrValue.get(id) ?? 0)} expected` : ""}</p>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
