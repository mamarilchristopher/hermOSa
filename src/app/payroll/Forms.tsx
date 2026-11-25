"use client";
import { useActionState } from "react";
import { addAdjustment, finalizePayroll, requestCola, saveHoliday, savePaySettings, savePayrollRules } from "./actions";

const php = (c: number | null | undefined) => (c == null ? "" : String(c / 100));
const Msg = ({ st }: { st?: { ok?: string; error?: string } }) => (
  <>
    {st?.error && <span className="small" style={{ color: "var(--bad)" }}>{st.error}</span>}
    {st?.ok && <span className="small" style={{ color: "var(--good)" }}>{st.ok}</span>}
  </>
);

export type PaySetting = { basis: "MONTHLY" | "DAILY"; rate_cents: number; allowance_cents: number; statutory: boolean; tax: boolean; deduct_lates: boolean; declared_cents?: number | null; cola_cents?: number | null };

/** One staff member's pay rate and switches. CSRs default to basic pay only (no government shares or tax). */
export function PayRateForm({ employee, s, csr }: { employee: string; s: PaySetting | null; csr: boolean }) {
  const [st, action, pending] = useActionState(savePaySettings, undefined);
  const gov = s ? s.statutory : !csr, tax = s ? s.tax : !csr;
  return (
    <form action={action} className="pay-rate">
      <input type="hidden" name="employee" value={employee} />
      <select name="basis" defaultValue={s?.basis ?? "MONTHLY"} aria-label="Pay basis">
        <option value="MONTHLY">Monthly</option>
        <option value="DAILY">Daily</option>
      </select>
      <input name="rate" defaultValue={php(s?.rate_cents)} inputMode="decimal" placeholder="Rate ₱" aria-label="Rate in pesos" required />
      <input name="allowance" defaultValue={php(s?.allowance_cents || null)} inputMode="decimal" placeholder="Allowance ₱/cutoff" aria-label="Allowance per cutoff" />
      <input name="declared" defaultValue={php(s?.declared_cents ?? null)} inputMode="decimal" placeholder="Declared salary ₱" aria-label="Declared salary for SSS, PhilHealth, Pag-IBIG and tax" title="Leave empty to use the rate" />
      <label className="check"><input type="checkbox" name="statutory" defaultChecked={gov} /> SSS, PhilHealth, Pag-IBIG</label>
      <label className="check"><input type="checkbox" name="tax" defaultChecked={tax} /> Tax</label>
      <label className="check"><input type="checkbox" name="lates" defaultChecked={s ? s.deduct_lates : false} /> Deduct lates</label>
      <button className="small" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      <Msg st={st} />
    </form>
  );
}

export function FinalizeForm({ run }: { run: string }) {
  const [st, action, pending] = useActionState(finalizePayroll, undefined);
  return (
    <form action={action} className="row-buttons">
      <input type="hidden" name="run" value={run} />
      <label className="check"><input type="checkbox" name="confirm" /> I checked the payslips</label>
      <button disabled={pending}>{pending ? "Finalizing…" : "Finalize and send payslips"}</button>
      <Msg st={st} />
    </form>
  );
}

export function AdjustmentForm({ run, employee }: { run: string; employee: string }) {
  const [st, action, pending] = useActionState(addAdjustment, undefined);
  return (
    <form action={action} className="field-grid" key={st?.ok ? st.n : "adj"}>
      <input type="hidden" name="run" value={run} />
      <input type="hidden" name="employee" value={employee} />
      <label className="field half">Type
        <select name="kind" defaultValue="EARNING">
          <option value="EARNING">Add to pay (overtime, holiday, bonus)</option>
          <option value="DEDUCTION">Deduct (cash advance, loan)</option>
        </select>
      </label>
      <label className="field half">Amount (₱)<input name="amount" inputMode="decimal" placeholder="e.g. 500" required /></label>
      <label className="field">What it&apos;s for<input name="label" maxLength={60} required placeholder='e.g. Overtime 3 hrs, or SSS loan (2nd deduction)' /></label>
      <label className="field check"><input type="checkbox" name="nontax" /> Not taxable (e.g. de minimis allowance)</label>
      <div className="field row-buttons"><button className="small" disabled={pending}>{pending ? "Adding…" : "Add line"}</button><Msg st={st} /></div>
    </form>
  );
}

export function HolidayForm() {
  const [st, action, pending] = useActionState(saveHoliday, undefined);
  return (
    <form action={action} className="pay-rate" key={st?.ok ? st.n : "hol"}>
      <input type="date" name="date" required aria-label="Date" />
      <input name="name" required maxLength={80} placeholder="Holiday name" aria-label="Holiday name" />
      <select name="kind" defaultValue="REGULAR" aria-label="Kind">
        <option value="REGULAR">Regular holiday</option>
        <option value="SPECIAL">Special non-working day</option>
      </select>
      <button className="small" disabled={pending}>{pending ? "Saving…" : "Add"}</button>
      <Msg st={st} />
    </form>
  );
}

export function RulesForm({ statutory, special }: { statutory: string; special: boolean }) {
  const [st, action, pending] = useActionState(savePayrollRules, undefined);
  return (
    <form action={action} className="pay-rate">
      <label className="check">SSS, PhilHealth, Pag-IBIG deducted
        <select name="statutory" defaultValue={statutory}>
          <option value="FIRST">in full on the 1st–15th cutoff</option>
          <option value="SECOND">in full on the 16th–end cutoff</option>
          <option value="SPLIT">half on each cutoff</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" name="special" defaultChecked={special} /> +30% for working a special day</label>
      <button className="small" disabled={pending}>{pending ? "Saving…" : "Save rules"}</button>
      <Msg st={st} />
    </form>
  );
}

/** COLA (a month's amount, paid on the 1st-15th cutoff). Owners save it; the GM's change goes to the owners to approve. */
export function ColaForm({ employee, cola, owner, waiting }: { employee: string; cola: number; owner: boolean; waiting: number | null }) {
  const [st, action, pending] = useActionState(requestCola, undefined);
  return (
    <form action={action} className="pay-rate">
      <input type="hidden" name="employee" value={employee} />
      <span className="small">COLA ₱/month</span>
      <input name="cola" defaultValue={php(cola)} inputMode="decimal" placeholder="0" aria-label="COLA per month" />
      <button className="small secondary" disabled={pending}>{pending ? "Saving…" : owner ? "Save COLA" : "Ask owner to approve"}</button>
      {waiting != null && <span className="small muted">Waiting for an owner: ₱{(waiting / 100).toLocaleString("en-PH")}</span>}
      <Msg st={st} />
    </form>
  );
}
