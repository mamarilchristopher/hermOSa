"use client";
import { useActionState, useEffect, useState } from "react";
import { setStaffPin } from "./actions";

/** Sign-in PIN for staff without an authenticator: set privately by the owner, never shown again. */
export function PinCell({ userId, hasPin }: { userId: string; hasPin: boolean }) {
  const [state, action, pending] = useActionState(setStaffPin, undefined);
  const [open, setOpen] = useState(false);
  const has = state?.has ?? hasPin;
  useEffect(() => { if (state?.ok) setOpen(false); }, [state]);
  if (!open) {
    return (
      <span className="pin-cell">
        {has ? <span className="tag">PIN on</span> : null}
        <button type="button" className="secondary small" onClick={() => setOpen(true)}>{has ? "Change PIN" : "Set PIN"}</button>
        {state?.ok && <span className="small saved-tick">✓ {state.ok}</span>}
      </span>
    );
  }
  return (
    <form action={action} className="pin-cell" key={state?.n ?? 0}>
      <input type="hidden" name="user" value={userId} />
      <input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="4 digits" aria-label="New PIN" autoComplete="new-password" />
      <button type="submit" className="small" disabled={pending}>Confirm</button>
      {has && <button type="submit" name="remove" value="1" className="secondary small" disabled={pending} formNoValidate>Remove PIN</button>}
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
      {state?.error && <span className="field-error">{state.error}</span>}
    </form>
  );
}
