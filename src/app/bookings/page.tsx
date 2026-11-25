import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { AddBookingForm, CopyForGc, NoteForm, StatusForm } from "./Forms";

type Booking = {
  id: string; booked_on: string; csr_employee_id: string | null; client_name: string; contact: string | null; platform: string; services: string;
  appointment_date: string; appointment_time: string | null; branch_id: string; deposit_cents: number | null; follow_up: boolean; note: string | null;
  status: string; resched_count: number; rescheduled_from: string | null; status_note: string | null;
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
  const clinics = branches.filter((b) => b.kind === "CLINIC" && (booker || can(access, ["MANAGER", "CLINICIAN", "CASHIER"], b.id)));
  const only = clinics.find((b) => b.code === sp.b);
  const shown = only ? [only] : clinics;

  const [{ data, error }, { data: emps }, { data: madeToday }] = await Promise.all([
    supabase.from("bookings")
      .select("id, booked_on, csr_employee_id, client_name, contact, platform, services, appointment_date, appointment_time, branch_id, deposit_cents, follow_up, note, status, resched_count, rescheduled_from, status_note")
      .or(`appointment_date.eq.${day},rescheduled_from.eq.${day}`).order("appointment_time", { ascending: true, nullsFirst: false }).order("created_at").limit(500),
    supabase.from("employees").select("id, full_name"),
    booker ? supabase.from("bookings").select("csr_employee_id").eq("booked_on", day).limit(2000) : Promise.resolve({ data: [] }),
  ]);
  const rows = (data ?? []) as Booking[];
  const name = new Map(((emps ?? []) as { id: string; full_name: string }[]).map((e) => [e.id, e.full_name]));
  const perCsr = new Map<string, number>();
  for (const r of (madeToday ?? []) as { csr_employee_id: string | null }[]) perCsr.set(r.csr_employee_id ?? "", (perCsr.get(r.csr_employee_id ?? "") ?? 0) + 1);
  const moved = (r: Booking) => r.appointment_date !== day;
  const byBranch = shown.map((b) => ({ b, list: rows.filter((r) => r.branch_id === b.id) }));
  const live = rows.filter((r) => !moved(r) && shown.some((b) => b.id === r.branch_id));
  const count = (s: string) => live.filter((r) => r.status === s).length;

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
        <h1>Bookings</h1>
        <p className="muted small">{booker ? "Log each booking here. The branch marks Arrived or Done, and you see it right away." : "Today's online bookings for your branch. Tap Arrived when they come in and Done when finished."}</p>
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
          {rows.length > 0 && <div style={{ marginTop: 8 }}><CopyForGc text={gc} /></div>}
        </div>

        {byBranch.map(({ b, list }) => (
          <div className="card" key={b.id}>
            <h2>{b.name} ({list.filter((r) => !moved(r)).length})</h2>
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
                  {r.appointment_time && ` · ${time12(r.appointment_time)}`}
                  {r.deposit_cents ? ` · DP ${peso(r.deposit_cents)}` : ""}
                  {r.follow_up && " · Follow-up session"}
                  {r.resched_count > 0 && !moved(r) && ` · moved ${r.resched_count}x${r.rescheduled_from ? ` (was ${fmt(r.rescheduled_from)})` : ""}`}
                </p>
                <p className="small muted" style={{ margin: "0 0 6px" }}>
                  {r.note && <>“{r.note}” · </>}
                  {r.status_note && <>{r.status_note} · </>}
                  Booked {fmt(r.booked_on)}{r.csr_employee_id && name.get(r.csr_employee_id) ? ` by ${name.get(r.csr_employee_id)}` : ""}
                  {r.platform !== "FACEBOOK" && ` · ${r.platform.replace("_", "-").toLowerCase()}`}
                </p>
                {!moved(r) && <><StatusForm id={r.id} status={r.status} booker={booker} today={today} /> <NoteForm id={r.id} note={r.status_note} /></>}
              </div>
            ))}
          </div>
        ))}

        {booker && (
          <div className="card">
            <h2>Add a booking</h2>
            <AddBookingForm branches={clinics.map((b) => ({ id: b.id, name: b.name }))} today={day < today ? today : day} min={addDays(today, -30)} max={addDays(today, 365)} />
          </div>
        )}

        {booker && perCsr.size > 0 && (
          <div className="card">
            <h2>Booked on {fmt(day)}</h2>
            {[...perCsr.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => (
              <p key={id} className="small" style={{ margin: "0 0 2px" }}><strong>{n}</strong> · {name.get(id) ?? "Owner / GM"}</p>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
