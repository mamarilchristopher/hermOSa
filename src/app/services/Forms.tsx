"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { addService, decideLog, logService, type ActionState } from "./actions";
import { previewCommission, type CommissionType } from "@/lib/commission";
import { centsToPhp } from "@/lib/csv";

type Opt = { id: string; name: string; eligible?: boolean; here?: boolean };

const TYPES: { v: CommissionType; label: string; hint: string }[] = [
  { v: "LEAD", label: "Lead", hint: "You led, someone assisted (60/40)" },
  { v: "ASSIST", label: "Assist", hint: "You assisted someone (40%)" },
  { v: "SOLO", label: "Solo", hint: "Done alone (100% of 5%)" },
  { v: "NONCOMMI", label: "No commission", hint: "Not commission-based" },
];

const KINDS = [
  { v: "PAID", label: "Paid" },
  { v: "BACKJOB", label: "Backjob" },
  { v: "CHECKUP", label: "Check-up" },
  { v: "NO_CHARGE", label: "No charge" },
] as const;
type Kind = (typeof KINDS)[number]["v"];

function Msg({ s }: { s: ActionState }) {
  if (s?.error) return <div className="notice error">{s.error}</div>;
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return null;
}

export function EntryForm({ branch, date, services, employees }: { branch: string; date: string; services: Opt[]; employees: Opt[] }) {
  const [state, action, pending] = useActionState(logService, undefined);
  const [type, setType] = useState<CommissionType>("LEAD");
  const [kind, setKind] = useState<Kind>("PAID");
  const paid = kind === "PAID";
  const [amount, setAmount] = useState("");
  const [who, setWho] = useState("");
  // Controlled so the fields survive a "log it anyway?" round trip (React resets uncontrolled fields after an action).
  const [service, setService] = useState("");
  const [partner, setPartner] = useState("");
  const [receipt, setReceipt] = useState("");
  const [note, setNote] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      setAmount("");
      setType("LEAD");
      setKind("PAID");
      setWho("");
      setService(""); setPartner(""); setReceipt(""); setNote("");
    }
  }, [state]);
  const person = employees.find((e) => e.id === who);
  useEffect(() => {
    if (person && person.eligible === false) setType("NONCOMMI");
  }, [person]);
  const cents = Math.round(Number(amount.replace(/[,₱\s]/g, "")) * 100) || 0;
  const p = previewCommission(paid ? cents : 0, paid ? type : "NONCOMMI");
  const needsPartner = paid && (type === "LEAD" || type === "ASSIST");
  const people = (
    <>
      <option value="">Choose…</option>
      {employees.filter((e) => e.here).map((e) => <option key={e.id} value={e.id}>{e.name}{e.eligible === false ? " (no commission)" : ""}</option>)}
      {employees.some((e) => !e.here) && (
        <optgroup label="Other branches">
          {employees.filter((e) => !e.here).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </optgroup>
      )}
    </>
  );
  return (
    <form ref={form} action={action} className="entry-form">
      <Msg s={state} />
      <input type="hidden" name="branch" value={branch} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="kind" value={kind} />
      <div className="field">
        <span className="field-label">Did the client pay?</span>
        <div className="segmented choice" role="radiogroup" aria-label="Did the client pay?">
          {KINDS.map((k) => (
            <button type="button" key={k.v} role="radio" aria-checked={kind === k.v} className={kind === k.v ? "on" : ""} onClick={() => setKind(k.v)}>{k.label}</button>
          ))}
        </div>
        {!paid && <span className="small muted">Logged at ₱0 with no commission, so you can see every client handled.</span>}
      </div>
      <div className="entry-grid">
        <label className="span2">Service
          <select name="service" required value={service} onChange={(e) => setService(e.target.value)}>
            <option value="" disabled>Choose a service…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {paid && (
          <label>Amount paid (₱)
            <input name="amount" inputMode="decimal" placeholder="e.g. 2500" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        )}
        <label className={paid ? "" : "span2"}><span>Waiver / OR no. <span className="muted">(stops double logging)</span></span>
          <input name="receipt" maxLength={40} value={receipt} onChange={(e) => setReceipt(e.target.value)} />
        </label>
      </div>
      {paid && <div className="field">
        <span className="field-label">Commission type</span>
        <div className="segmented choice" role="radiogroup" aria-label="Commission type">
          {TYPES.map((t) => (
            <button type="button" key={t.v} role="radio" aria-checked={type === t.v} className={type === t.v ? "on" : ""} onClick={() => setType(t.v)} title={t.hint}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="small muted">{TYPES.find((t) => t.v === type)?.hint}</span>
      </div>}
      <div className="entry-grid">
        <label className={needsPartner ? "" : "span2"}>{!paid ? "Handled by" : type === "ASSIST" ? "Assisted by (you)" : type === "LEAD" ? "Lead (done by)" : "Done by"}
          <select name="employee" required value={who} onChange={(e) => setWho(e.target.value)}>{people}</select>
        </label>
        {needsPartner && (
          <label>{type === "ASSIST" ? "Lead (who led it)" : "Assisted by"}
            <select name="partner" required value={partner} onChange={(e) => setPartner(e.target.value)}>{people}</select>
          </label>
        )}
        <label className="span2"><span>Note <span className="muted">(optional, no client names)</span></span>
          <input name="note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="entry-foot">
        <div className="preview">
          {p.total > 0 ? (
            <>
              <span>Commission {centsToPhp(p.total)}</span>
              {type === "SOLO" && <span className="muted">all to the performer</span>}
              {needsPartner && <span className="muted">lead {centsToPhp(p.lead)} · assist {centsToPhp(p.assist)}</span>}
            </>
          ) : (
            <span className="muted">{!paid ? "Unpaid visit: no commission" : type === "NONCOMMI" ? "No commission for this service" : "Enter the amount paid to see the commission"}</span>
          )}
        </div>
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Add to today's log"}</button>
      </div>
      {state?.duplicate && (
        <div className="notice warn dup-check">
          <span><strong>Already logged?</strong> {state.duplicate}</span>
          <button type="submit" name="confirm" value="1" className="small" disabled={pending}>Yes, different client. Log it</button>
        </div>
      )}
    </form>
  );
}

export function DecideButtons({ id }: { id: string }) {
  const [state, action, pending] = useActionState(decideLog, undefined);
  const [rejecting, setRejecting] = useState(false);
  if (state?.ok) return <span className={`pill ${state.ok === "Approved" ? "PUBLISHED" : "REVERSED"}`}>{state.ok}</span>;
  return (
    <form action={action} className="fill-row">
      <input type="hidden" name="log" value={id} />
      {rejecting ? (
        <>
          <input name="note" placeholder="Reason" required minLength={3} maxLength={300} autoFocus />
          <button type="submit" name="decision" value="reject" className="danger small" disabled={pending}>Reject</button>
          <button type="button" className="secondary small" onClick={() => setRejecting(false)}>Cancel</button>
        </>
      ) : (
        <>
          <button type="submit" name="decision" value="approve" className="small" disabled={pending}>Approve</button>
          <button type="button" className="secondary small" onClick={() => setRejecting(true)}>Reject</button>
        </>
      )}
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}

export function AddServiceForm() {
  const [state, action, pending] = useActionState(addService, undefined);
  return (
    <form action={action} className="fill-row">
      <input name="name" placeholder="New service name" required minLength={2} maxLength={120} style={{ width: 220 }} />
      <button type="submit" className="secondary small" disabled={pending}>Add service</button>
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
      {state?.ok && <span className="small" style={{ color: "var(--good)" }}>{state.ok}</span>}
    </form>
  );
}
