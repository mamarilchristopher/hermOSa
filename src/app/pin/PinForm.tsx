"use client";
import { useActionState } from "react";
import { verifyPin } from "./actions";

export function PinForm() {
  const [state, action, pending] = useActionState(verifyPin, undefined);
  return (
    <form action={action} className="stack" key={state?.n ?? 0}>
      {state?.error && <div className="notice error">{state.error}</div>}
      <label>
        PIN
        <input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" autoFocus required className="pin-input" />
      </label>
      <button type="submit" disabled={pending}>{pending ? "Checking…" : "Continue"}</button>
    </form>
  );
}
