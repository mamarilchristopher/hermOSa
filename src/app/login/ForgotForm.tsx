"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { resetWithCode, resetSignedIn, sendResetEmail, type ForgotState } from "./password-actions";

function Done() {
  return (
    <div className="stack">
      <div className="notice ok">Your password is changed. Use it the next time you sign in.</div>
      <Link className="button" href="/">Continue to Hermosa OS</Link>
    </div>
  );
}

function NewPassword() {
  return (
    <>
      <label>
        New password
        <input name="password" type="password" autoComplete="new-password" minLength={10} required />
        <span className="small muted">At least 10 characters.</span>
      </label>
      <label>
        New password again
        <input name="again" type="password" autoComplete="new-password" minLength={10} required />
      </label>
    </>
  );
}

/** Forgot password: email → code (or the link) → new password. No approval needed. */
export function ForgotForm() {
  const [sent, sendAction, sending] = useActionState<ForgotState, FormData>(sendResetEmail, undefined);
  const [res, resetAction, resetting] = useActionState<ForgotState, FormData>(resetWithCode, undefined);
  const [again, setAgain] = useState(false);
  const email = res?.sent ?? sent?.sent;
  if (res?.done) return <Done />;
  if (!email || again) {
    return (
      <form action={(fd) => { setAgain(false); sendAction(fd); }} className="stack">
        {sent?.error && <div className="notice error">{sent.error}</div>}
        <label>
          Email
          <input name="email" type="email" autoComplete="username" defaultValue={email ?? ""} required />
          <span className="small muted">The email you sign in with. We&apos;ll email you a code to set a new password.</span>
        </label>
        <button type="submit" disabled={sending}>{sending ? "Sending…" : "Email me a code"}</button>
        <Link href="/login" className="small center-link">Back to sign in</Link>
      </form>
    );
  }
  return (
    <form action={resetAction} className="stack">
      <div className="notice">If <strong>{email}</strong> has a Hermosa OS login, a code is on its way. Check Spam too. You can also tap the link in that email instead.</div>
      {res?.error && <div className="notice error">{res.error}</div>}
      <input type="hidden" name="email" value={email} />
      <label>
        Code from the email
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,12}" placeholder="123456" required />
      </label>
      <NewPassword />
      <button type="submit" disabled={resetting}>{resetting ? "Saving…" : "Set new password"}</button>
      <button type="button" className="link-like small" onClick={() => setAgain(true)}>Send a new code</button>
    </form>
  );
}

/** Signed in (from the emailed link, or anytime): set a new password. */
export function ResetForm() {
  const [res, action, pending] = useActionState<ForgotState, FormData>(resetSignedIn, undefined);
  if (res?.done) return <Done />;
  return (
    <form action={action} className="stack">
      {res?.error && <div className="notice error">{res.error}</div>}
      <NewPassword />
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Set new password"}</button>
    </form>
  );
}
