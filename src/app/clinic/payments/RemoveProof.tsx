"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

/** Remove a proof (whoever attached it, or owners and the GM). Asks first, in the page. */
export function RemoveProof({ id }: { id: string }) {
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!ask) return <button type="button" className="link-like small" onClick={() => setAsk(true)}>Remove</button>;
  const go = async () => {
    setBusy(true);
    const sb = createClient();
    const { data } = await sb.rpc("remove_payment_proof", { p_id: id });
    if (data?.ok) await sb.storage.from("payment-proofs").remove([data.path, data.thumb].filter(Boolean));
    setBusy(false); setAsk(false); router.refresh();
  };
  return (
    <span className="small">Remove this proof? <button type="button" className="danger small" disabled={busy} onClick={go}>{busy ? "Removing…" : "Remove"}</button>{" "}
      <button type="button" className="secondary small" onClick={() => setAsk(false)}>Keep</button></span>
  );
}
