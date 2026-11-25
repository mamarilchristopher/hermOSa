"use client";
import { useActionState, useState } from "react";
import { decidePhoto } from "./actions";

export function DecidePhotoForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(decidePhoto, undefined);
  const [back, setBack] = useState(false);
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return (
    <form action={action} className="field-grid">
      {s?.error && <div className="notice error">{s.error}</div>}
      <input type="hidden" name="id" value={id} />
      {back && <label className="field">Why send it back?<input name="note" maxLength={300} required placeholder="e.g. Face not clear, please use a front-facing photo" /></label>}
      <div className="field row-buttons">
        {back ? (
          <><button name="decision" value="return" className="danger" disabled={pending}>Send back</button>
            <button type="button" className="secondary" onClick={() => setBack(false)}>Back</button></>
        ) : (
          <><button name="decision" value="approve" disabled={pending}>{pending ? "Saving…" : "Approve"}</button>
            <button type="button" className="secondary" onClick={() => setBack(true)}>Send back</button></>
        )}
      </div>
    </form>
  );
}
