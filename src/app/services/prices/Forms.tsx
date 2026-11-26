"use client";
import { useActionState, useState } from "react";
import { saveService, setAddon } from "./actions";

const php = (c: number | null) => (c == null ? "" : String(c / 100));

export function ServiceRow({ s, edit }: { s: { id: string; name: string; price_cents: number | null; commission_cents: number | null; active: boolean; is_addon?: boolean; is_meds?: boolean }; edit: boolean }) {
  const [st, action, pending] = useActionState(saveService, undefined);
  const [ad, addonAction, addonPending] = useActionState(setAddon, undefined);
  const [open, setOpen] = useState(false);
  const peso = (c: number | null) => (c == null ? "—" : `₱${(c / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`);
  if (!open) {
    return (
      <tr className={s.active ? "" : "muted"}>
        <td>{s.name}{!s.active && <span className="small"> (hidden)</span>}{s.is_addon && <span className="tag" style={{ marginLeft: 6 }}>Add-on</span>}{st?.ok && <span className="small" style={{ color: "var(--good)" }}> {st.ok}</span>}{ad?.error && <span className="small" style={{ color: "var(--bad)" }}> {ad.error}</span>}</td>
        <td className="num">{peso(s.price_cents)}</td>
        <td className="num">{s.commission_cents == null ? <span className="small muted">5% of paid</span> : peso(s.commission_cents)}</td>
        <td className="num">{s.commission_cents == null ? "" : `${peso(Math.round(s.commission_cents * 0.6))} / ${peso(s.commission_cents - Math.round(s.commission_cents * 0.6))}`}</td>
        <td>{edit && (
          <span className="row-buttons">
            <button type="button" className="secondary small" onClick={() => setOpen(true)}>Edit</button>
            {s.is_addon !== undefined && !s.is_meds && (
              <form action={addonAction} style={{ display: "inline" }}>
                <input type="hidden" name="id" value={s.id} />
                <input type="hidden" name="on" value={s.is_addon ? "0" : "1"} />
                <button className="secondary small" disabled={addonPending} title="Add-ons can be added to any service on the log, at 5% commission">{s.is_addon ? "Not an add-on" : "Make add-on"}</button>
              </form>
            )}
          </span>
        )}</td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={5}>
        <form action={action} className="price-edit">
          <input type="hidden" name="id" value={s.id} />
          <input name="name" defaultValue={s.name} required maxLength={120} aria-label="Service name" />
          <input name="price" defaultValue={php(s.price_cents)} inputMode="decimal" placeholder="Price ₱" aria-label="Price" />
          <input name="commission" defaultValue={php(s.commission_cents)} inputMode="decimal" placeholder="Commission ₱ (empty = 5%)" aria-label="Commission" />
          <select name="active" defaultValue={s.active ? "on" : "off"} aria-label="Shown"><option value="on">Shown</option><option value="off">Hidden</option></select>
          <button className="small" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          <button type="button" className="secondary small" onClick={() => setOpen(false)}>Close</button>
          {st?.error && <span className="small" style={{ color: "var(--bad)" }}>{st.error}</span>}
          {st?.ok && <span className="small" style={{ color: "var(--good)" }}>{st.ok}</span>}
        </form>
      </td>
    </tr>
  );
}

export function AddServiceForm() {
  const [st, action, pending] = useActionState(saveService, undefined);
  return (
    <form action={action} className="field-grid" key={st?.ok ? st.n : "add"}>
      {st?.error && <div className="notice error field">{st.error}</div>}
      {st?.ok && <div className="notice ok field">{st.ok}</div>}
      <label className="field">Service name<input name="name" required maxLength={120} placeholder="e.g. Hiko Deluxe" /></label>
      <label className="field half">Price (₱)<input name="price" inputMode="decimal" placeholder="e.g. 8999" /></label>
      <label className="field half">Commission, solo (₱)<input name="commission" inputMode="decimal" placeholder="Empty = 5% of amount paid" /></label>
      <p className="field small muted" style={{ margin: 0 }}>Lead and assist split the commission 60/40, like now. Leave commission empty to keep 5% of the amount paid.</p>
      <div className="field row-buttons"><button disabled={pending}>{pending ? "Saving…" : "Add service"}</button></div>
    </form>
  );
}
