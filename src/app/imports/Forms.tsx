"use client";
import { useActionState } from "react";
import { publishImport, reverseImport, stageImport, type FormState } from "./actions";

function Notice({ state }: { state: FormState }) {
  if (state?.error) return <div className="notice error">{state.error}</div>;
  if (state?.ok) return <div className="notice ok">{state.ok}</div>;
  return null;
}

export function UploadForm({ branches }: { branches: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(stageImport, undefined);
  return (
    <form action={action} className="stack">
      <Notice state={state} />
      <label>
        Branch
        <select name="branch" required>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label>
        CSV file
        <input type="file" name="file" accept=".csv,text/csv" required />
      </label>
      <label>
        Number of sales in the branch's own report
        <input type="number" name="expectedRows" min={0} step={1} required />
      </label>
      <label>
        Total pesos in the branch's own report
        <input name="expectedTotal" inputMode="decimal" placeholder="e.g. 125000.00" required />
      </label>
      <button type="submit" disabled={pending}>{pending ? "Uploading…" : "Upload and check"}</button>
    </form>
  );
}

export function PublishForm({ batch }: { batch: string }) {
  const [state, action, pending] = useActionState(publishImport, undefined);
  return (
    <form action={action} className="stack">
      <Notice state={state} />
      <input type="hidden" name="batch" value={batch} />
      <p className="small muted">Re-enter the figures from the branch's source report yourself. Don't copy them from this page.</p>
      <label>Number of sales<input type="number" name="expectedRows" min={0} step={1} required /></label>
      <label>Total pesos<input name="expectedTotal" inputMode="decimal" required /></label>
      <button type="submit" disabled={pending}>{pending ? "Signing off…" : "Sign off and publish"}</button>
    </form>
  );
}

export function ReverseForm({ batch }: { batch: string }) {
  const [state, action, pending] = useActionState(reverseImport, undefined);
  return (
    <form action={action} className="stack">
      <Notice state={state} />
      <input type="hidden" name="batch" value={batch} />
      <label>Reason<textarea name="reason" minLength={8} maxLength={500} required rows={2} /></label>
      <button type="submit" className="danger" disabled={pending}>{pending ? "Reversing…" : "Reverse this batch"}</button>
    </form>
  );
}
