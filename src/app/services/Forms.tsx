"use client";
import { pick } from "@/lib/decision";
import { useActionState, useEffect, useRef, useState } from "react";
import { addService, decideLog, logService, type ActionState } from "./actions";
import { previewCommission, type CommissionType } from "@/lib/commission";
import { centsToPhp } from "@/lib/csv";
import { PhotoGroup, usePhotoSlots } from "./PhotoSlots";

type Opt = { id: string; name: string; eligible?: boolean; here?: boolean; price?: number | null; commission?: number | null };


const KINDS = [
  { v: "PAID", label: "Paid" },
  { v: "BACKJOB", label: "Backjob" },
  { v: "CHECKUP", label: "Check-up" },
  { v: "NO_CHARGE", label: "No charge" },
] as const;
type Kind = (typeof KINDS)[number]["v"];

/** Staff phone test (CHRIS Nov 26): the result pops up so nobody misses it. */
function TestPopup({ s }: { s: ActionState }) {
  const [closedAt, setClosedAt] = useState<number | undefined>(undefined);
  const pass = !!s?.ok?.startsWith("✅");
  const fail = !!s?.ok?.startsWith("Test saved, but");
  if ((!pass && !fail) || closedAt === s?.at) return null;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" onClick={() => setClosedAt(s?.at)}>
      <div className={`card modal test-popup ${pass ? "pass" : "fail"}`} onClick={(e) => e.stopPropagation()}>
        <div className="test-popup-icon" aria-hidden>{pass ? "✅" : "⚠️"}</div>
        <h2>{pass ? "Your service logging feature is working correctly." : "Almost there"}</h2>
        {!pass && <p>{s!.ok!.replace("Test saved, but it isn't complete yet: ", "Your test was saved, but: ")}</p>}
        <button type="button" onClick={() => setClosedAt(s?.at)}>OK</button>
      </div>
    </div>
  );
}

function Msg({ s }: { s: ActionState }) {
  if (s?.error) return <div className="notice error">{s.error}</div>;
  if (s?.ok?.startsWith("Test saved, but")) return <><TestPopup s={s} /><div className="notice warn">{s.ok}</div></>;
  if (s?.ok?.startsWith("✅")) return <><TestPopup s={s} /><div className="notice ok test-pass"><strong>{s.ok}</strong></div></>;
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return null;
}

export function EntryForm({ branch, date, services, employees, noCommission = false, photosOptional = false }: { branch: string; date: string; services: Opt[]; employees: Opt[]; noCommission?: boolean; photosOptional?: boolean }) {
  const [state, action, pending] = useActionState(logService, undefined);
  // CHRIS Nov 26: no Lead/Assist/Solo choice. "Done by" is the lead; a commission-based lead may add an assistant (default None).
  const [kind, setKind] = useState<Kind>("PAID");
  const paid = kind === "PAID";
  const [amount, setAmount] = useState("");
  const [who, setWho] = useState("");
  // Controlled so the fields survive a "log it anyway?" round trip (React resets uncontrolled fields after an action).
  const [service, setService] = useState("");
  const [partner, setPartner] = useState("");
  const [client, setClient] = useState("");
  const [priceNote, setPriceNote] = useState("");
  const [share, setShare] = useState(false);
  const [note, setNote] = useState("");
  const photos = usePhotoSlots(branch);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      form.current?.querySelector('input[name="confirm"]')?.remove();
      setAmount("");
      setKind("PAID");
      setWho("");
      setService(""); setPartner(""); setClient(""); setPriceNote(""); setShare(false); setNote("");
      photos.reset();
    }
  }, [state]);
  const person = employees.find((e) => e.id === who);
  const partnerEmp = employees.find((e) => e.id === partner);
  const cents = Math.round(Number(amount.replace(/[,₱\s]/g, "")) * 100) || 0;
  const svc = services.find((x) => x.id === service);
  // Lead with "Assisted by: None" is saved as Solo; the 60/40 split applies only once an assistant is chosen (CHRIS Nov 26).
  const effType: CommissionType = person?.eligible === false ? "NONCOMMI" : partner ? "LEAD" : "SOLO";
  const raw = previewCommission(paid ? cents : 0, paid ? effType : "NONCOMMI", svc?.commission, svc?.price);
  // Only commission-based people get a share; someone not on commission is never mentioned (CHRIS Nov 26).
  const leadEmp = person, assistEmp = partnerEmp;
  const shown = {
    lead: leadEmp?.eligible === false ? 0 : raw.lead,
    assist: assistEmp?.eligible === false ? 0 : raw.assist,
    solo: person?.eligible === false ? 0 : raw.solo,
  };
  const p = { ...raw, total: shown.lead + shown.assist + shown.solo };
  const listPrice = svc?.price ?? null;
  const priceDiffers = paid && listPrice != null && listPrice > 0 && cents > 0 && cents !== listPrice;
  const needsPhotos = kind === "PAID" || kind === "BACKJOB";
  const missingPhotos = !needsPhotos ? null
    : photos.count("BEFORE") < 1 || photos.count("AFTER") < 1 ? "Add at least one before and one after photo."
    : photos.count("WAIVER") < 2 ? "Add both pages of the signed waiver." : null;
  // update-0054: owners and the GM may save without photos; the lead and assist are then asked to add them.
  const missing = photosOptional ? null : missingPhotos;
  const needsPartner = paid && !!person && person.eligible !== false;
  const people = (
    <>
      <option value="">Choose…</option>
      {employees.filter((e) => e.here).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
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
      <input type="hidden" name="type" value={effType} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="folder" value={photos.folder} />
      <input type="hidden" name="photos" value={photos.json} />
      <div className="field">
        <span className="field-label">Did the client pay?</span>
        <div className="segmented choice" role="radiogroup" aria-label="Did the client pay?">
          {KINDS.map((k) => (
            <button type="button" key={k.v} role="radio" aria-checked={kind === k.v} className={kind === k.v ? "on" : ""} onClick={() => setKind(k.v)}>{k.label}</button>
          ))}
        </div>
        {!paid && <span className="small muted">{noCommission ? "Logged at ₱0, so you can see every client handled." : "Logged at ₱0 with no commission, so you can see every client handled."}</span>}
      </div>
      <div className="entry-grid">
        <label className="span2">Client name
          <input name="client" required minLength={2} maxLength={120} autoComplete="off" placeholder="Full name, as on the waiver" value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        <label className={paid ? "" : "span2"}>Service
          <select name="service" required value={service} onChange={(e) => {
            setService(e.target.value);
            // Fill in the list price (it can still be changed, e.g. for a discount).
            const pr = services.find((x) => x.id === e.target.value)?.price;
            if (pr != null) setAmount(pr > 0 ? String(pr / 100) : "");
          }}>
            <option value="" disabled>Choose a service…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {paid && (
          <label>Amount paid (₱)
            <input name="amount" inputMode="decimal" placeholder="e.g. 2500" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        )}
        {priceDiffers && (
          <label className="span2"><span>Reason for the different price <span className="muted">(list price {centsToPhp(listPrice!)})</span></span>
            <input name="price_note" required minLength={3} maxLength={300} placeholder="e.g. 10% promo, loyalty discount" value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
          </label>
        )}
      </div>
      <PhotoGroup api={photos} title="Before and after photos" hint={needsPhotos ? "Pick them all at once (at least one before and one after). Tap a photo's label to switch Before / After." : "Optional for this visit. Tap a photo's label to switch Before / After."}
        kinds={[{ kind: "AUTO", label: "Add before & after photos" }]} />
      <label className="check-row">
        <input type="checkbox" name="share" value="1" checked={share} onChange={(e) => setShare(e.target.checked)} />
        <span>Did the client allow sharing of their photos? <span className="muted">(adds them to Social media)</span></span>
      </label>
      <PhotoGroup api={photos} title="Waiver (2 pages)" hint={needsPhotos ? "A clear photo of each page of the signed waiver." : "Optional for this visit."}
        kinds={[{ kind: "WAIVER", label: "Add waiver page" }]} />
      <div className="entry-grid">
        <label className={needsPartner ? "" : "span2"}>{!paid ? "Handled by" : "Done by"}
          <select name="employee" required value={who} onChange={(e) => { setWho(e.target.value); if (e.target.value === partner || employees.find((x) => x.id === e.target.value)?.eligible === false) setPartner(""); }}>{people}</select>
        </label>
        {needsPartner && (
          <label><span>Assisted by <span className="muted">(optional)</span></span>
              <select name="partner" value={partner} onChange={(e) => setPartner(e.target.value)}>
                <option value="">None</option>
                {employees.filter((e) => e.here && e.id !== who).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                {employees.some((e) => !e.here && e.id !== who) && (
                  <optgroup label="Other branches">{employees.filter((e) => !e.here && e.id !== who).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</optgroup>
                )}
              </select>
          </label>
        )}
        <label className="span2"><span>Note <span className="muted">(optional)</span></span>
          <input name="note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="entry-foot">
        <div className="preview">
          {noCommission ? null : p.total > 0 ? (
            <>
              <span>Commission {centsToPhp(p.total)}</span>
              {effType === "SOLO" && <span className="muted">all to the performer (no assistant)</span>}
              {needsPartner && effType !== "SOLO" && shown.lead > 0 && shown.assist === 0 && <span className="muted">lead {centsToPhp(shown.lead)}</span>}
              {needsPartner && effType !== "SOLO" && shown.lead === 0 && shown.assist > 0 && <span className="muted">assist {centsToPhp(shown.assist)}</span>}
              {needsPartner && effType !== "SOLO" && shown.lead > 0 && shown.assist > 0 && <span className="muted">lead {centsToPhp(p.lead)} · assist {centsToPhp(p.assist)}</span>}
            </>
          ) : (
            <span className="muted">{!paid ? "Unpaid visit: no commission" : effType === "NONCOMMI" ? "" : cents > 0 ? "" : "Enter the amount paid to see the commission"}</span>
          )}
        </div>
        <button type="submit" disabled={pending || photos.uploading || !!missing} title={missing ?? undefined}>
          {pending ? "Saving…" : photos.uploading ? "Uploading photos…" : "Add to today's log"}
        </button>
      </div>
      {missing && !photos.uploading && <p className="small muted entry-missing">{missing}</p>}
      {photosOptional && missingPhotos && !photos.uploading && (
        <p className="small entry-missing" style={{ color: "var(--bad)" }}><strong>Still missing: {missingPhotos}</strong> You can save without them, but the entry will show "Photos missing": the lead and assist get an urgent notice to add them, and their commission for this entry is held until they do.</p>
      )}
      {state?.duplicate && (
        <div className="notice warn dup-check">
          <span><strong>Already logged?</strong> {state.duplicate}</span>
          <button type="submit" className="small" disabled={pending} onClick={(e) => {
            // A button's own name/value doesn't always reach a server action (see pick()), so write it into a hidden field.
            const f = e.currentTarget.form; if (!f) return;
            let i = f.querySelector<HTMLInputElement>('input[name="confirm"]');
            if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = "confirm"; f.appendChild(i); }
            i.value = "1";
          }}>Yes, separate visit. Log it</button>
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
          <button type="submit" onClick={pick("reject")} className="danger small" disabled={pending}>Reject</button>
          <button type="button" className="secondary small" onClick={() => setRejecting(false)}>Cancel</button>
        </>
      ) : (
        <>
          <button type="submit" onClick={pick("approve")} className="small" disabled={pending}>Approve</button>
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
