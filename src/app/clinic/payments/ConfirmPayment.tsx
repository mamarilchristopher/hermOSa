"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

/** Owners and the GM (update-0076): was the transfer received? The person who attached the proof is told. */
export function ConfirmPayment({ log, state }: { log: string; state: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redo, setRedo] = useState(false);
  if (state !== "PENDING" && !redo) return <button type="button" className="link-like small" onClick={() => setRedo(true)}>Change</button>;
  const go = async (received: boolean) => {
    setBusy(true); setError(null);
    const { data, error: e } = await createClient().rpc("confirm_payment", { p_log: log, p_received: received, p_note: note || null });
    setBusy(false);
    if (e?.code === "PGRST202") { setError("This needs database update-0076 first."); return; }
    if (e || !data?.ok) { setError("Could not save. Try again."); return; }
    setRedo(false); router.refresh();
  };
  return (
    <div className="confirm-pay">
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Note (optional), e.g. seen in BPI" aria-label="Note" />
      <button type="button" className="small" disabled={busy} onClick={() => go(true)}>✓ Received</button>
      <button type="button" className="danger small" disabled={busy} onClick={() => go(false)}>Not received</button>
      {error && <span className="small" style={{ color: "var(--bad)" }}>{error}</span>}
    </div>
  );
}

/** Opens and scrolls to the folder a notice pointed at. */
export function FocusFolder({ id }: { id: string }) {
  useEffect(() => { document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [id]);
  return null;
}
