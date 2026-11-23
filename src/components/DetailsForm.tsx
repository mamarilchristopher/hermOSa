"use client";
import { useActionState, useState } from "react";
import { SECTIONS, visible, type Details, type Field } from "@/lib/employeeDetails";

export type DetailsState = { ok?: string; error?: string; errors?: Record<string, string>; values?: Details; n?: number } | undefined;
type Action = (prev: DetailsState, fd: FormData) => Promise<DetailsState>;

const WATCH = new Set(["permanent_same", "prev_employer_this_year", "payout_method"]);

function Input({ f, value, error }: { f: Field; value: string; error?: string }) {
  const id = `f-${f.key}`;
  const common = { id, name: f.key, "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}-err` : undefined };
  let control;
  if (f.type === "checkbox") {
    return (
      <label className={`check ${error ? "has-error" : ""}`}>
        <input type="checkbox" {...common} defaultChecked={value === "yes"} />
        <span>{f.label}{f.required && " *"}</span>
        {error && <span className="field-error" id={`${id}-err`}>{error}</span>}
      </label>
    );
  }
  if (f.type === "select") {
    control = (
      <select {...common} defaultValue={value} required={f.required}>
        <option value="">{f.required ? "Choose…" : "None"}</option>
        {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (f.type === "textarea") {
    control = <textarea {...common} defaultValue={value} rows={2} maxLength={f.max} required={f.required} />;
  } else {
    control = (
      <input {...common} type={f.type === "tel" ? "tel" : f.type} defaultValue={value} maxLength={f.max} required={f.required}
        inputMode={f.digits ? "numeric" : undefined} autoComplete="off" placeholder={f.hint && f.type !== "date" ? f.hint : undefined} />
    );
  }
  return (
    <label className={`field ${f.half ? "half" : ""} ${error ? "has-error" : ""}`}>
      <span>{f.label}{f.required && " *"}{f.sensitive && <span className="lock" title="Only you and the owners see this"> 🔒</span>}</span>
      {control}
      {f.hint && f.type === "date" && <span className="small muted">{f.hint}</span>}
      {error && <span className="field-error" id={`${id}-err`}>{error}</span>}
    </label>
  );
}

/** The employee details form, shared by staff (fill in) and the owner (review and correct). */
export function DetailsForm({ action, initial, submitLabel, children, extra }: {
  action: Action; initial: Details; submitLabel: string; children?: React.ReactNode; extra?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const values = state?.values ?? initial;
  const [watch, setWatch] = useState<Details>(() => Object.fromEntries([...WATCH].map((k) => [k, values[k] ?? ""])));
  const onChange = (e: React.FormEvent<HTMLFormElement>) => {
    const t = e.target as HTMLInputElement;
    if (!WATCH.has(t.name)) return;
    setWatch((w) => ({ ...w, [t.name]: t.type === "checkbox" ? (t.checked ? "yes" : "") : t.value }));
  };
  const errs = state?.errors ?? {};
  const shown = { ...values, ...watch };
  return (
    <form action={formAction} onChange={onChange} className="details-form" key={state?.n ?? 0} noValidate>
      {children}
      {state?.error && <div className="notice error">{state.error}</div>}
      {Object.keys(errs).length > 0 && <div className="notice error">Some answers need fixing. They're marked in red below.</div>}
      {SECTIONS.map((s) => (
        <fieldset key={s.id} className="card">
          <legend>{s.title}</legend>
          {s.note && <p className="small muted">{s.note}</p>}
          <div className="field-grid">
            {s.fields.filter((f) => visible(f, shown)).map((f) => <Input key={f.key} f={f} value={values[f.key] ?? ""} error={errs[f.key]} />)}
          </div>
        </fieldset>
      ))}
      {extra}
      {state?.ok && <div className="notice ok">{state.ok}</div>}
      <div className="form-actions">
        <button type="submit" name="intent" value="approve" disabled={pending}>{pending ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  );
}
