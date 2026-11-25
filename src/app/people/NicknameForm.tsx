"use client";
import { useActionState } from "react";
import { setNickname } from "./actions";

/** The name the schedule shows (update-0043). Empty = their details nickname, else their first name. */
export function NicknameForm({ id, nickname }: { id: string; nickname: string | null }) {
  const [state, action, pending] = useActionState(setNickname, undefined);
  return (
    <form action={action} className="stack wide">
      <input type="hidden" name="id" value={id} />
      <div className="entry-grid">
        <label>Nickname<input name="nickname" defaultValue={nickname ?? ""} maxLength={40} placeholder="e.g. Kath" /></label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Shown on the schedule. Leave empty to use their first name.</p>
      <div><button type="submit" className="secondary" disabled={pending}>{pending ? "Saving…" : "Save nickname"}</button>
        {state?.error && <span className="field-error"> {state.error}</span>}
        {state?.ok && <span className="small ok-text"> {state.ok}</span>}</div>
    </form>
  );
}
