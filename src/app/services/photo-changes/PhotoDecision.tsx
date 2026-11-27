"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

/** Approve / Not approved (owners and the GM), or Take back (the person who asked). update-0093. */
export function PhotoDecision({ id, approver, mine }: { id: string; approver: boolean; mine: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async (fn: "decide_photo_change" | "cancel_photo_change", approve?: boolean) => {
    setBusy(true); setError("");
    const sb = createClient();
    const { data, error: e } = fn === "cancel_photo_change" ? await sb.rpc(fn, { p_id: id }) : await sb.rpc(fn, { p_id: id, p_approve: approve, p_note: note.trim() || null });
    setBusy(false);
    if (e || !data?.ok) { setError(data?.error === "ALREADY_DECIDED" ? "Someone already decided this one." : "Could not save. Try again."); router.refresh(); return; }
    router.refresh();
  };
  return (
    <div className="photo-decision">
      {approver && <input value={note} maxLength={300} placeholder="Note (optional)" onChange={(e) => setNote(e.target.value)} aria-label="Note" />}
      <div className="fill-row">
        {approver && <button type="button" className="small" disabled={busy} onClick={() => go("decide_photo_change", true)}>Approve</button>}
        {approver && <button type="button" className="secondary small" disabled={busy} onClick={() => go("decide_photo_change", false)}>Not approved</button>}
        {mine && <button type="button" className="secondary small" disabled={busy} onClick={() => go("cancel_photo_change")}>Take back</button>}
      </div>
      {error && <span className="small" style={{ color: "var(--bad)" }}>{error}</span>}
    </div>
  );
}
