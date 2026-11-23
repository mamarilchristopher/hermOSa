"use client";
import { useActionState } from "react";
import { register } from "./actions";

export function JoinForm({ code, branches }: { code: string; branches: { id: string; code: string; name: string }[] }) {
  const [state, action, pending] = useActionState(register, undefined);
  if (state?.done) {
    return (
      <div className="notice ok">
        You're registered. {state.confirm ? "Check your email and tap the confirmation link, then sign in." : "You can sign in now."} You'll
        see a waiting screen until the owner approves you.
      </div>
    );
  }
  return (
    <form action={action} className="stack">
      {state?.error && <div className="notice error">{state.error}</div>}
      <input type="hidden" name="code" value={code} />
      <label>Full name<input name="full_name" autoComplete="name" required minLength={2} maxLength={120} /></label>
      <label>
        Your branch
        <select name="branch" required defaultValue="">
          <option value="" disabled>Choose…</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="new-password" minLength={10} required /><span className="small muted">At least 10 characters.</span></label>
      <button type="submit" disabled={pending}>{pending ? "Registering…" : "Register"}</button>
    </form>
  );
}
