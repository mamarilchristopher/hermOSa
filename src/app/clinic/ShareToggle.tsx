"use client";
import { useActionState } from "react";
import { setSharing } from "./actions";

/** Owners and the GM: change whether a client's before/after photos show in Social media. */
export function ShareToggle({ id, on }: { id: string; on: boolean }) {
  const [state, action, pending] = useActionState(setSharing, undefined);
  const now = state?.on ?? on;
  return (
    <form action={action} className="fill-row">
      <input type="hidden" name="log" value={id} />
      <input type="hidden" name="share" value={now ? "0" : "1"} />
      <span className="small">{now ? "Client allowed sharing" : "Not shared"}</span>
      <button type="submit" className="secondary small" disabled={pending}>{now ? "Stop sharing" : "Allow sharing"}</button>
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
