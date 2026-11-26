import Link from "next/link";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { FollowUpForm } from "../Forms";
import { LiveBookings } from "../LiveBookings";

type Booking = {
  id: string; client_name: string; contact: string | null; platform: string; services: string; appointment_date: string;
  branch_id: string; deposit_cents: number | null; note: string | null; status_note: string | null; status_by: string | null; status_at: string | null; csr_employee_id: string | null;
};
type FollowUp = {
  id: string; booking_id: string; channel: string; outcome: string; old_date: string; new_date: string | null; note: string | null; created_by: string; created_at: string;
  bookings: { client_name: string; branch_id: string; services: string } | null;
};

const CHANNEL: Record<string, string> = { CALL: "Called", FACEBOOK: "Facebook message", SMS: "Text", OTHER: "Other" };
const OUTCOME: Record<string, [string, string]> = { STILL_UNRESPONSIVE: ["Still unresponsive", "STAGED"], REBOOKED: ["Rebooked", "PUBLISHED"], CANCELLED: ["Cancelled", "REVERSED"] };
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const when = (ts: string) => new Date(ts).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const firstName = (n?: string) => (n ?? "").replace(/^ma\.?\s+/i, "").split(" ")[0];
const peso = (c: number) => `₱${(c / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;

/** Sales follow-ups (update-0081, CHRIS Nov 26): every Unresponsive booking, for the GM (and CSRs, owners) to call or
 *  message again. Each follow-up is logged with its outcome; rebooked ones go back to Bookings on their new date. */
export default async function FollowUpsPage() {
  const { supabase, access, branches } = await requireAccess();
  const allowed = can(access, ["CSR", "OWNER"], null) || can(access, ["MANAGER"], null);
  if (!allowed) redirect("/bookings");
  const today = manilaToday();
  const month = today.slice(0, 7);
  const since = new Date(Date.parse(`${month}-01T00:00:00+08:00`) - 31 * 86400000).toISOString();
  const [{ data: open, error }, { data: logs, error: logErr }, { data: ppl }] = await Promise.all([
    supabase.from("bookings").select("id, client_name, contact, platform, services, appointment_date, branch_id, deposit_cents, note, status_note, status_by, status_at, csr_employee_id")
      .eq("status", "UNRESPONSIVE").order("appointment_date", { ascending: false }).limit(500),
    supabase.from("booking_followups").select("id, booking_id, channel, outcome, old_date, new_date, note, created_by, created_at, bookings(client_name, branch_id, services)")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(2000),
    supabase.rpc("chat_people"),
  ]);
  const list = (open ?? []) as Booking[];
  const fu = (logs ?? []) as unknown as FollowUp[];
  const who = new Map(((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const bName = new Map(branches.map((b) => [b.id, b.name.replace(/ \(.*\)$/, "")]));
  const manilaDay = (ts: string) => manilaToday(new Date(ts));
  const doneToday = fu.filter((f) => manilaDay(f.created_at) === today);
  const thisMonth = fu.filter((f) => manilaDay(f.created_at).startsWith(month));
  const byPerson = new Map<string, number>();
  for (const f of thisMonth) byPerson.set(f.created_by, (byPerson.get(f.created_by) ?? 0) + 1);
  const forBooking = (id: string) => fu.filter((f) => f.booking_id === id);
  const resolved = fu.filter((f) => f.outcome !== "STILL_UNRESPONSIVE").slice(0, 30);
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", timeZone: "UTC" });

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1 className="title-row">Sales follow-ups <LiveBookings /></h1>
        <p className="muted small">Every client marked Unresponsive on <Link href="/bookings">Bookings</Link>. Call or message them, then log what happened. Rebooked clients go back on Bookings on their new date. Each follow-up is counted.</p>
        {(error || logErr) && <div className="notice info">{(logErr ?? error)?.code === "42P01" ? "The owner needs to run update-0081 in Supabase first." : "Could not load. Try again."}</div>}

        <div className="fu-stats">
          <div className="card stat hero"><div className="label">To follow up</div><div className="value">{list.length}</div><div className="note">unresponsive clients</div></div>
          <div className="card stat"><div className="label">Follow-ups today</div><div className="value">{doneToday.length}</div><div className="note">{doneToday.filter((f) => f.outcome === "REBOOKED").length} rebooked</div></div>
          <div className="card stat"><div className="label">{monthLabel} so far</div><div className="value">{thisMonth.length}</div>
            <div className="note">{thisMonth.filter((f) => f.outcome === "REBOOKED").length} rebooked · {thisMonth.filter((f) => f.outcome === "CANCELLED").length} cancelled</div></div>
        </div>
        {byPerson.size > 0 && (
          <p className="small muted">Follow-ups this month: {[...byPerson.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${who.get(id) ?? "Staff"} ${n}`).join(" · ")}</p>
        )}

        <div className="card">
          <h2>To follow up ({list.length})</h2>
          {list.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nobody to follow up. 🎉</p>}
          {list.map((r) => {
            const h = forBooking(r.id);
            return (
              <div key={r.id} className="fu-row">
                <p style={{ margin: "0 0 2px" }}>
                  <strong>{r.client_name}</strong>{" "}
                  {r.contact ? <a className="small" href={`tel:${r.contact.replace(/\s/g, "")}`}>{r.contact}</a> : <span className="small muted">no number</span>}{" "}
                  <span className={`pill ${h.length ? "STAGED" : "REVERSED"}`}>{h.length ? `${h.length} follow-up${h.length === 1 ? "" : "s"}` : "Not followed up yet"}</span>
                </p>
                <p className="small" style={{ margin: "0 0 2px" }}>
                  {r.services} · {bName.get(r.branch_id) ?? "Branch"} · was booked for {fmt(r.appointment_date)}
                  {r.deposit_cents ? ` · DP ${peso(r.deposit_cents)}` : ""}
                  {r.platform !== "FACEBOOK" && ` · booked by ${r.platform.replace("_", "-").toLowerCase()}`}
                </p>
                <p className="small muted" style={{ margin: 0 }}>
                  {r.note && <>“{r.note}” · </>}
                  {r.status_note && <>{r.status_note} · </>}
                  {r.status_by && r.status_at ? `Marked unresponsive by ${firstName(who.get(r.status_by)) || "staff"}, ${when(r.status_at)}` : "Marked unresponsive"}
                </p>
                {h.length > 0 && (
                  <details className="small">
                    <summary>Last: {CHANNEL[h[0].channel]} by {firstName(who.get(h[0].created_by)) || "staff"}, {when(h[0].created_at)}</summary>
                    <ol className="fu-history">
                      {h.slice().reverse().map((f) => <li key={f.id}>{when(f.created_at)} · {CHANNEL[f.channel]} by {who.get(f.created_by) ?? "staff"} · {OUTCOME[f.outcome][0]}{f.note ? ` · ${f.note}` : ""}</li>)}
                    </ol>
                  </details>
                )}
                <FollowUpForm id={r.id} today={today} />
              </div>
            );
          })}
        </div>

        {resolved.length > 0 && (
          <div className="card">
            <h2>Recently rebooked or cancelled</h2>
            {resolved.map((f) => (
              <p key={f.id} className="small" style={{ margin: "0 0 6px" }}>
                <span className={`pill ${OUTCOME[f.outcome][1]}`}>{OUTCOME[f.outcome][0]}</span>{" "}
                <strong>{f.bookings?.client_name ?? "Client"}</strong>
                {f.outcome === "REBOOKED" && f.new_date && <> to <Link href={`/bookings?d=${f.new_date}`}>{fmt(f.new_date)}</Link></>}
                <span className="muted"> · {f.bookings ? bName.get(f.bookings.branch_id) : ""} · {CHANNEL[f.channel]} by {firstName(who.get(f.created_by)) || "staff"}, {when(f.created_at)}{f.note ? ` · ${f.note}` : ""}</span>
              </p>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
