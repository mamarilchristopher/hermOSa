"use client";
import { useActionState, useState } from "react";
import { cancelLeave, decideLeave, fileLeave } from "./actions";

export function FileLeaveForm({ today, slFrom }: { today: string; slFrom: string }) {
  const [s, action, pending] = useActionState(fileLeave, undefined);
  const [kind, setKind] = useState("VL");
  const [start, setStart] = useState("");
  return (
    <form action={action} className="field-grid">
      {s?.error && <div className="notice error field">{s.error}</div>}
      {s?.ok && <div className="notice ok field">{s.ok}</div>}
      <label className="field">Type of leave
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="VL">Vacation leave (VL)</option>
          <option value="SL">Sick leave (SL)</option>
        </select>
      </label>
      <label className="field half">First day<input type="date" name="start" required min={kind === "VL" ? today : slFrom} value={start} onChange={(e) => setStart(e.target.value)} /></label>
      <label className="field half">Last day<input type="date" name="end" min={start || (kind === "VL" ? today : slFrom)} placeholder="Same day" /></label>
      <label className="field">Reason<textarea name="reason" required maxLength={500} rows={2} placeholder={kind === "VL" ? "e.g. Family trip" : "e.g. Fever, saw a doctor"} /></label>
      <p className="field small muted" style={{ margin: 0 }}>
        {kind === "VL" ? "File vacation leave ahead of time." : "Sick leave can be filed up to 14 days after, when you are back."} Leave the last day empty for one day. Your days off are not counted.
      </p>
      <div className="field row-buttons"><button disabled={pending}>{pending ? "Sending…" : "Send for approval"}</button></div>
    </form>
  );
}

export function CancelLeaveButton({ id }: { id: string }) {
  const [s, action, pending] = useActionState(cancelLeave, undefined);
  if (s?.ok) return <span className="small muted">{s.ok}</span>;
  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="id" value={id} />
      <button className="secondary small" disabled={pending}>Withdraw</button>
      {s?.error && <span className="small" style={{ color: "var(--bad)" }}> {s.error}</span>}
    </form>
  );
}

export function DecideLeaveForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(decideLeave, undefined);
  const [decline, setDecline] = useState(false);
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return (
    <form action={action} className="field-grid">
      {s?.error && <div className="notice error field">{s.error}</div>}
      <input type="hidden" name="id" value={id} />
      <label className="field">{decline ? "Why not?" : "Note (optional)"}<input name="note" maxLength={300} required={decline} placeholder={decline ? "e.g. Short-staffed that week, please choose other dates" : ""} /></label>
      <div className="field row-buttons">
        {decline ? (
          <><button name="decision" value="decline" className="danger" disabled={pending}>Decline</button>
            <button type="button" className="secondary" onClick={() => setDecline(false)}>Back</button></>
        ) : (
          <><button name="decision" value="paid" disabled={pending}>{pending ? "Saving…" : "Approve with pay"}</button>
            <button name="decision" value="unpaid" className="secondary" disabled={pending}>Approve without pay</button>
            <button type="button" className="secondary" onClick={() => setDecline(true)}>Decline</button></>
        )}
      </div>
    </form>
  );
}
