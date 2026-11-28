import { isTestService, sortServices } from "@/lib/serviceOrder";
import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { AddBookingForm, CancelReasonForm, CopyForGc, NoteForm, StatusForm } from "./Forms";
import { LiveBookings } from "./LiveBookings";
import { LogSale, type LinkChoice } from "./Receive";
import { nameScore } from "@/lib/arrivals";
import { AddPanel, ControlBar, DayPicker, Stat, Stats, Tabs } from "@/components/Controls";
import { IconWarning } from "@/components/Icons";

type Booking = {
  id: string; booked_on: string; csr_employee_id: string | null; client_name: string; contact: string | null; platform: string; services: string;
  expected_cents: number | null; appointment_date: string; appointment_time: string | null; branch_id: string; deposit_cents: number | null; follow_up: boolean; note: string | null;
  status: string; waiver_name?: string | null; resched_count: number; rescheduled_from: string | null; status_note: string | null; status_by: string | null; status_at: string | null;
};

const STATUS: Record<string, [string, string]> = {
  BOOKED: ["Booked", "STAGED"], CONFIRMED: ["Confirmed", "STAGED"], ARRIVING: ["Arriving", "ARRIVING"], ARRIVED: ["Arrived", "PUBLISHED"], DONE: ["Done", "PUBLISHED"],
  NO_SHOW: ["Did not arrive", "REVERSED"], UNRESPONSIVE: ["Unresponsive", "REVERSED"], CANCELLED: ["Cancelled", "REVERSED"],
};
/** update-0091 (CHRIS Nov 27): still to be closed out today (Arrived or Did not arrive, within clinic hours). */
const WAITING = ["BOOKED", "CONFIRMED", "ARRIVING"];
const LOG_ROLES = ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN"] as const;
const GC_NAME: Record<string, string> = { QC_MAIN: "MAIN", FAIRVIEW: "FAIRVIEW", STA_MARIA: "SMB", MARIKINA: "MARIKINA" };
const GC_STATUS: Record<string, string> = { ARRIVING: "ARRIVING", ARRIVED: "ARRIVED", DONE: "DONE", NO_SHOW: "DID NOT ARRIVE", UNRESPONSIVE: "UNRESPONSIVE", CANCELLED: "CANCELLED", CONFIRMED: "CONFIRMED" };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const mdy = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(2, 4)}`;
const time12 = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const peso = (c: number) => `₱${(c / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;

/** Online bookings (update-0040): CSRs log Facebook bookings; each branch marks its visits; everyone sees the day live. */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ d?: string; b?: string; focus?: string }> }) {
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
  const cols = "id, booked_on, csr_employee_id, client_name, contact, platform, services, appointment_date, appointment_time, branch_id, deposit_cents, expected_cents, follow_up, note, status, resched_count, rescheduled_from, status_note, status_by, status_at, waiver_name";
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
    booker ? supabase.from("bookings").select("id", { count: "exact", head: true }).in("status", ["UNRESPONSIVE", "NO_SHOW"]) : Promise.resolve({ count: 0 }),
  ]);
  const who = new Map(((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const at = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
  const firstName = (n?: string) => (n ?? "").replace(/^ma\.?\s+/i, "").split(" ")[0];
  // moved_from comes with update-0071; until it runs, fall back to the last move only.
  const { data, error } = first.error?.code === "42703" ? await forDay(false) : first;
  const rows = (data ?? []) as Booking[];
  // update-0091: bookings whose sale is already in the Service log (so nobody logs it twice).
  const { data: linked } = rows.length ? await supabase.from("service_logs").select("booking_id, log_no, merged_into").in("booking_id", rows.map((r) => r.id)).neq("state", "REJECTED") : { data: [] };
  const soldNo = new Map<string, string>();
  for (const x of (linked ?? []) as { booking_id: string; log_no: string | null; merged_into: string | null }[]) if (!soldNo.has(x.booking_id) || !x.merged_into) soldNo.set(x.booking_id, x.log_no ?? "");
  const sold = new Set(soldNo.keys());
  // v0.106.6 (CHRIS Nov 28): the day's entries not tied to a booking, so an arrived booking can be linked to the sale
  // someone logged on its own ("Already logged? Link it"). Best name match first.
  const { data: looseRows } = rows.some((r) => (r.status === "ARRIVED" || r.status === "ARRIVING" || r.status === "DONE") && !sold.has(r.id))
    ? await supabase.from("service_logs").select("id, branch_id, log_no, client_name, booking_id, merged_into, services(name)").eq("service_date", day).neq("state", "REJECTED").is("booking_id", null).is("merged_into", null).limit(500)
    : { data: [] };
  const loose = (looseRows ?? []) as unknown as { id: string; branch_id: string; log_no: string | null; client_name: string | null; services: { name: string } | null }[];
  const linkChoices = (r: Booking): LinkChoice[] => loose.filter((l) => l.branch_id === r.branch_id)
    .map((l) => ({ id: l.id, label: `${l.client_name ?? "No name"} · ${l.services?.name ?? "Service"}${l.log_no ? ` · ${l.log_no}` : ""}`, score: Math.max(nameScore(r.client_name, l.client_name), nameScore(r.waiver_name, l.client_name)) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  // update-0094: the client's reason on Cancelled bookings (CHRIS Nov 27). Before the update runs this finds nothing.
  const cancelledIds = rows.filter((r) => r.status === "CANCELLED").map((r) => r.id);
  const { data: reasonRows, error: reasonErr } = cancelledIds.length ? await supabase.from("bookings").select("id, cancel_reason").in("id", cancelledIds) : { data: [], error: null };
  const reasonOf = new Map(((reasonRows ?? []) as { id: string; cancel_reason: string | null }[]).map((x) => [x.id, x.cancel_reason]));
  const reasonsLive = !reasonErr;
  const codeOf = new Map(clinics.map((b) => [b.id, b.code]));
  const canLog = (branchId: string) => can(access, [...LOG_ROLES], branchId);
  // Clinic hours end at 7 PM: after that (or for an earlier day) anyone still Booked, Confirmed or Arriving needs closing out.
  const manilaHour = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", hour: "numeric", hour12: false })) % 24;
  const closingTime = day < today || (day === today && manilaHour >= 19);
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
  const open = (list: Booking[]) => list.filter((r) => !moved(r) && r.status !== "CANCELLED" && r.status !== "UNRESPONSIVE" && r.status !== "NO_SHOW");
  const toClose = live.filter((r) => WAITING.includes(r.status));
  const came = (list: Booking[]) => list.filter((r) => !moved(r) && (r.status === "ARRIVED" || r.status === "DONE"));
  const noValue = open(live).filter((r) => r.expected_cents == null).length;

  // Same layout as the CSR group chat: branch, then "number name" (dashes when there's no number), then the status.
  const gc = [mdy(day), ""].concat(byBranch.filter((x) => x.list.length).flatMap(({ b, list }) => [
    GC_NAME[b.code] ?? b.name.toUpperCase(),
    ...list.flatMap((r) => {
      const line = `${r.contact ?? "----------"} ${r.client_name}${r.note ? ` (${r.note})` : ""}`;
      const st = moved(r) ? `RE-SCHED (${mdy(r.appointment_date)}${r.deposit_cents ? " w/ dp" : ""})` : GC_STATUS[r.status];
      const why = r.status === "CANCELLED" && !moved(r) ? reasonOf.get(r.id) : null;
      const extra = [r.status_note && !moved(r) ? r.status_note.toUpperCase() : "", why ? `REASON: ${why.toUpperCase()}` : ""].filter(Boolean).join(" · ");
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
        <p className="muted small">{booker ? "Log each booking here, from Facebook, calls, texts or walk-ins. Tap Arriving when the client says they're on the way; the branch marks Arrived, and every booking is closed out (Arrived or Did not arrive) by 7 PM." : "Run client receiving from here. Tap Arriving when the client is on the way and Arrived when they come in. After they pay, tap Log the sale on their booking (or their name) so the sale is tied to the booking. Add a new Service log entry only for walk-ins who aren't in Bookings. Close out everyone (Arrived or Did not arrive) by 7 PM."}</p>
        {error && <div className="notice info">{error.code === "42P01" ? "The owner needs to run update-0040 in Supabase first." : "Could not load. Try again."}</div>}

        {/* v0.98.1 (CHRIS Nov 27): the Service log pattern. Branch tabs and the day picker in one bar, counts as cards,
            actions as buttons, and "Add a booking" as a real button. */}
        <ControlBar>
          <Tabs tabs={[{ href: `/bookings?d=${day}`, label: "All branches", on: !only },
            ...clinics.map((b) => ({ href: `/bookings?d=${day}&b=${b.code}`, label: b.name, on: only?.id === b.id }))]} />
          <DayPicker name="d" value={day} prev={href(addDays(day, -1))} next={href(addDays(day, 1))} today={day !== today ? href(today) : null}
            keep={sp.b ? { b: sp.b } : {}} />
        </ControlBar>

        <Stats>
          <Stat hero label={`${only?.name ?? "All branches"} · ${fmt(day)}${day === today ? " (today)" : ""}`} value={`${live.length} booked`}
            note={seesValue && live.length > 0 ? <>Expected {peso(worth(open(live)))}{noValue > 0 ? ` · ${noValue} without a value` : ""}</> : undefined} />
          <Stat label="Arrived or done" value={count("ARRIVED") + count("DONE")} tone={count("ARRIVED") + count("DONE") > 0 ? "good" : undefined}
            note={seesValue && live.length > 0 ? <>{peso(worth(came(live)))} so far</> : undefined} />
          <Stat label="Still to come" value={toClose.length} note={`${count("ARRIVING")} on the way`} tone={closingTime && toClose.length > 0 ? "bad" : undefined} />
          <Stat label="Did not arrive" value={count("NO_SHOW") + count("UNRESPONSIVE")} note={`${count("UNRESPONSIVE")} unresponsive`} tone={count("NO_SHOW") + count("UNRESPONSIVE") > 0 ? "warn" : undefined} />
          <Stat label="Cancelled" value={count("CANCELLED")} note={`${rows.filter(moved).length} re-scheduled`} />
        </Stats>

        {toClose.length > 0 && day <= today && (
          <div className={`notice ${closingTime ? "error" : "info"}`}>
            {closingTime
              ? <><IconWarning className="ic-lead" />{toClose.length} client{toClose.length === 1 ? "" : "s"} still not closed out. Set each one to <strong>Arrived</strong> or <strong>Did not arrive</strong>.</>
              : <>{toClose.length} still to come today. Before 7 PM, set each one to <strong>Arrived</strong> or <strong>Did not arrive</strong>.</>}
          </div>
        )}
        {(rows.length > 0 || (booker && (toFollow ?? 0) > 0)) && (
          <div className="action-row">
            {rows.length > 0 && <CopyForGc text={gc} />}
            {booker && (toFollow ?? 0) > 0 && <Link className="button secondary small" href="/bookings/followups">{toFollow} unresponsive to follow up ›</Link>}
          </div>
        )}

        {booker && (
          // At the top (CHRIS Nov 25): management also books calls, walk-ins and texts, not only CSRs' online bookings.
          <AddPanel title="Add a booking" hint="Online, call, text or walk-in">
            <AddBookingForm branches={clinics.map((b) => ({ id: b.id, name: b.name }))} today={day < today ? today : day} min={addDays(today, -30)} max={addDays(today, 365)} services={sortServices(((svcs ?? []) as { name: string; price_cents: number | null }[]).filter((x) => !isTestService(x.name))).map((x) => ({ name: x.name, price: x.price_cents }))} />
          </AddPanel>
        )}

        {byBranch.map(({ b, list }) => (
          <div className="card" key={b.id}>
            <h2>{b.name} ({list.filter((r) => !moved(r)).length}){seesValue && worth(open(list)) > 0 && <span className="small muted" style={{ fontWeight: 500 }}> · expected {peso(worth(open(list)))}</span>}</h2>
            {list.length === 0 && <p className="muted small" style={{ margin: 0 }}>No bookings.</p>}
            {list.map((r) => (
              <div key={r.id} id={`bk-${r.id}`} className={`booking-row${sp.focus === r.id ? " focused" : ""}${closingTime && !moved(r) && WAITING.includes(r.status) ? " closeout" : ""}`}>
                <p style={{ margin: "0 0 2px" }}>
                  {/* CHRIS Nov 28: an arrived client's name logs their sale, tied to this booking. */}
                  {!moved(r) && !sold.has(r.id) && canLog(r.branch_id) && (r.status === "ARRIVING" || r.status === "ARRIVED" || r.status === "DONE")
                    ? <Link className="booking-client" href={`/services?branch=${codeOf.get(r.branch_id) ?? ""}&booking=${r.id}#add`} title="Log the sale for this client"><strong>{r.waiver_name ?? r.client_name}</strong> ›</Link>
                    : <strong>{r.waiver_name ?? r.client_name}</strong>}{" "}
                  {r.waiver_name && <span className="small muted">(FB: {r.client_name}) </span>}
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
                {r.status === "CANCELLED" && !moved(r) && reasonOf.get(r.id) && <p className="small" style={{ margin: "0 0 6px" }}><strong>Client reason:</strong> {reasonOf.get(r.id)}</p>}
                {r.status === "CANCELLED" && !moved(r) && reasonsLive && !reasonOf.get(r.id) && booker && <CancelReasonForm id={r.id} />}
                {sold.has(r.id) && <p className="small" style={{ margin: "0 0 6px", color: "var(--good)" }}>✓ Sale logged in the Service log{soldNo.get(r.id) ? ` · ${soldNo.get(r.id)}` : ""}{canLog(r.branch_id) && <> · <Link href={`/services?branch=${codeOf.get(r.branch_id) ?? ""}&booking=${r.id}#add`}>Add another service</Link></>}</p>}
                {/* v0.106.6 (CHRIS Nov 28): an arrived client's sale is logged FROM the booking, so the two stay tied. */}
                {!moved(r) && !sold.has(r.id) && (r.status === "ARRIVING" || r.status === "ARRIVED" || r.status === "DONE") && (canLog(r.branch_id)
                  ? <div style={{ margin: "0 0 8px" }}><LogSale booking={r.id} href={`/services?branch=${codeOf.get(r.branch_id) ?? ""}&booking=${r.id}#add`} entries={linkChoices(r)} /></div>
                  : (r.status === "ARRIVED" || r.status === "DONE") && <p className="small rcv-wait" style={{ margin: "0 0 6px" }}>Sale not logged yet</p>)}
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
