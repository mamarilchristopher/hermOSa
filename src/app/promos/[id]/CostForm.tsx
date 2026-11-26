"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setServiceCost } from "../actions";

/** Product cost of one session of a service (update-0087), typed by owners and the GM for the promo's profit. */
export function CostForm({ service, promo, cents }: { service: string; promo: string; cents: number | null }) {
  const [v, setV] = useState(cents == null ? "" : String(cents / 100));
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <span className="cost-form">
      <input inputMode="decimal" aria-label="Product cost per session (₱)" placeholder="₱ cost" value={v} onChange={(e) => { setV(e.target.value); setMsg(null); }} />
      <button type="button" className="secondary small" disabled={pending} onClick={() => start(async () => { const r = await setServiceCost(service, v, promo); setMsg(r.ok ?? r.error ?? null); if (r.ok) router.refresh(); })}>Save</button>
      {msg && <span className="small muted">{msg}</span>}
    </span>
  );
}
