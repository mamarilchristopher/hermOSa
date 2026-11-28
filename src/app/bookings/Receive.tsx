"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { pick } from "@/lib/decision";
import { linkEntry, setStatus } from "./actions";

// v0.106.6 (CHRIS Nov 28): client receiving runs from the booking. Each booking shows only its next step:
// Arriving / Arrived / Did not arrive, then "Log the sale" (the entry is linked to the booking, which becomes Done).

/** The next status taps for a booking still to come. */
export function QuickStatus({ id, status }: { id: string; status: string }) {
  const [s, action, pending] = useActionState(setStatus, undefined);
  const next = status === "ARRIVING" ? [["ARRIVED", "Arrived"], ["NO_SHOW", "Did not arrive"]] : [["ARRIVING", "Arriving"], ["ARRIVED", "Arrived"], ["NO_SHOW", "Did not arrive"]];
  return (
    <form action={action} className="rcv-status">
      <input type="hidden" name="id" value={id} />
      {next.map(([v, label]) => (
        <button key={v} className={`small ${v === "ARRIVED" ? "" : "secondary"}`} onClick={pick(v)} disabled={pending}>{label}</button>
      ))}
      {s?.error && <span className="small" style={{ color: "var(--bad)" }}>{s.error}</span>}
    </form>
  );
}

export type LinkChoice = { id: string; label: string; score: number };

/** Arrived, sale not linked: Log the sale (main path), or link an entry already saved for this client. */
export function LogSale({ booking, href, entries = [], linkHref }: { booking: string; href: string; entries?: LinkChoice[]; linkHref?: string }) {
  const [s, action, pending] = useActionState(linkEntry, undefined);
  const best = [...entries].sort((a, b) => b.score - a.score)[0];
  const [open, setOpen] = useState(false);
  if (s?.ok) return <span className="rcv-done">✓ {s.ok}</span>;
  return (
    <div className="rcv-log">
      <div className="rcv-log-row">
        <Link className="button small rcv-log-btn" href={href}>Log the sale ›</Link>
        {entries.length > 0 && !open && <button type="button" className="secondary small" onClick={() => setOpen(true)}>Already logged? Link it</button>}
        {entries.length === 0 && linkHref && <Link className="small" href={linkHref}>Already logged? Link it</Link>}
      </div>
      {open && (
        <form action={action} className="rcv-link">
          <input type="hidden" name="booking" value={booking} />
          <select name="log" defaultValue={best && best.score > 0 ? best.id : ""} aria-label="Service log entry for this client">
            <option value="" disabled>Pick the entry…</option>
            {entries.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <button className="small" disabled={pending}>Link</button>
          <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
          {s?.error && <span className="small" style={{ color: "var(--bad)" }}>{s.error}</span>}
        </form>
      )}
    </div>
  );
}
