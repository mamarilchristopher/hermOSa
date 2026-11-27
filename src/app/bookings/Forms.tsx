"use client";
import { useActionState, useEffect, useState } from "react";
import { pick } from "@/lib/decision";
import { addBooking, logFollowUp, setStatus } from "./actions";


export function AddBookingForm({ branches, today, min, max, services }: { branches: { id: string; name: string }[]; today: string; min: string; max: string; services: { name: string; price: number | null }[] }) {
  const [s, action, pending] = useActionState(addBooking, undefined);
  const [dp, setDp] = useState("");
  const [value, setValue] = useState("");
  useEffect(() => { if (s?.ok) { setValue(""); setDp(""); } }, [s]);
  // Picking a service from the price list fills in its price as the expected value (it can still be changed).
  const onService = (v: string) => {
    const hit = services.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
    if (hit?.price != null) setValue(String(hit.price / 100));
  };
  return (
    // key resets the inputs after each saved booking, so the next one starts clean.
    <form action={action} className="field-grid" key={s?.ok ? s.n : "form"}>
      {s?.error && <div className="notice error field">{s.error}</div>}
      {s?.ok && <div className="notice ok field">{s.ok}</div>}
      <label className="field half">Client name<input name="client" required maxLength={120} autoComplete="off" /></label>
      <label className="field half">Contact number<input name="contact" type="tel" maxLength={40} placeholder="Leave blank if none" autoComplete="off" /></label>
      <label className="field half">Service<input name="services" required maxLength={200} list="booking-services" placeholder="Type to search the price list" onChange={(e) => onService(e.target.value)} /></label>
      <datalist id="booking-services">{services.map((x) => <option key={x.name} value={x.name}>{x.price != null ? `₱${(x.price / 100).toLocaleString("en-PH")}` : ""}</option>)}</datalist>
      <label className="field half">Branch
        <select name="branch" required defaultValue="">
          <option value="" disabled>Choose…</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label className="field half">Visit date<input type="date" name="date" required defaultValue={today} min={min} max={max} /></label>
      <label className="field half">Time (optional)<input type="time" name="time" /></label>
      <label className="field half">Booked through
        <select name="platform" defaultValue="FACEBOOK">
          <option value="FACEBOOK">Facebook</option><option value="INSTAGRAM">Instagram</option><option value="CALL">Call</option>
          <option value="SMS">Text / Messenger</option><option value="WALK_IN">Walk-in</option><option value="OTHER">Other</option>
        </select>
      </label>
      <label className="field half">Down payment (₱, optional)<input name="dp" inputMode="decimal" value={dp} onChange={(e) => setDp(e.target.value)} placeholder="e.g. 500" /></label>
      <label className="field half">Expected value (₱)<input name="value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Fills in from the price list" /></label>
      <label className="field half">Note (optional)<input name="note" maxLength={300} placeholder="e.g. Marikina chat, call first, around 6 PM" /></label>
      <label className="field check"><input type="checkbox" name="follow_up" /> Follow-up session (FFUP)</label>
      <div className="field row-buttons"><button disabled={pending}>{pending ? "Saving…" : "Add booking"}</button></div>
    </form>
  );
}

export function StatusForm({ id, status, booker, today }: { id: string; status: string; booker: boolean; today: string }) {
  const [s, action, pending] = useActionState(setStatus, undefined);
  const [resched, setResched] = useState(false);
  const btn = (v: string, label: string) => (
    <button key={v} className={status === v ? "on" : ""} onClick={pick(v)} disabled={pending}>{label}</button>
  );
  return (
    <form action={action} className="booking-actions">
      <input type="hidden" name="id" value={id} />
      <div className="status-pick">
        {booker && btn("CONFIRMED", "Confirmed")}
        {btn("ARRIVING", "Arriving")}
        {btn("ARRIVED", "Arrived")}
        {btn("DONE", "Done")}
        {btn("NO_SHOW", "Did not arrive")}
        {btn("UNRESPONSIVE", "Unresponsive")}
        <button type="button" className={resched ? "on" : ""} onClick={() => setResched(!resched)}>Re-sched…</button>
        {booker && btn("CANCELLED", "Cancelled")}
      </div>
      {resched && (
        <div className="booking-resched">
          <input type="date" name="new_date" min={today} />
          <input name="note" maxLength={300} placeholder="Note, e.g. w/ DP" />
          <button className="small" onClick={pick("RESCHEDULED")} disabled={pending}>Move</button>
        </div>
      )}
      {s?.error && <span className="small" style={{ color: "var(--bad)" }}>{s.error}</span>}
    </form>
  );
}

export function NoteForm({ id, note }: { id: string; note: string | null }) {
  const [s, action, pending] = useActionState(setStatus, undefined);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="secondary small" onClick={() => setOpen(true)}>{note ? "Edit note" : "Add note"}</button>;
  return (
    <form action={action} className="booking-resched">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value="NOTE" />
      <input name="note" maxLength={300} defaultValue={note ?? ""} placeholder="e.g. around 6 PM, call first" autoFocus />
      <button className="small" disabled={pending}>Save</button>
      {s?.error && <span className="small" style={{ color: "var(--bad)" }}>{s.error}</span>}
    </form>
  );
}

/** Builds the same text the team posts in the CSR group chat, for while both are in use. */
export function CopyForGc({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="secondary small" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { window.prompt("Copy this:", text); }
    }}>{done ? "Copied" : "Copy for GC"}</button>
  );
}

/** update-0081: Sales follow-ups. How they were contacted, then what happened. */
export function FollowUpForm({ id, today }: { id: string; today: string }) {
  const [s, action, pending] = useActionState(logFollowUp, undefined);
  const [rebook, setRebook] = useState(false);
  return (
    <form action={action} className="fu-form">
      <input type="hidden" name="id" value={id} />
      <select name="channel" defaultValue="CALL" aria-label="How you contacted them">
        <option value="CALL">Called</option>
        <option value="FACEBOOK">Facebook message</option>
        <option value="SMS">Text</option>
        <option value="OTHER">Other</option>
      </select>
      <input name="note" maxLength={300} placeholder="Note (optional), e.g. busy until Dec" />
      <div className="status-pick">
        <button onClick={pick("STILL_UNRESPONSIVE")} disabled={pending}>Still unresponsive</button>
        <button type="button" className={rebook ? "on" : ""} onClick={() => setRebook(!rebook)}>Rebooked…</button>
        <button onClick={pick("CANCELLED")} disabled={pending}>Cancelled</button>
      </div>
      {rebook && (
        <span className="booking-resched">
          <input type="date" name="new_date" min={today} aria-label="New visit date" />
          <button className="small" onClick={pick("REBOOKED")} disabled={pending}>Save new date</button>
        </span>
      )}
      {s?.error && <span className="small" style={{ color: "var(--bad)" }}>{s.error}</span>}
      {s?.ok && <span className="small" style={{ color: "var(--good)" }}>{s.ok}</span>}
    </form>
  );
}
