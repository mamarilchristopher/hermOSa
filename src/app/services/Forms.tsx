"use client";
import { pick } from "@/lib/decision";
import { useActionState, useEffect, useRef, useState } from "react";
import { addService, approveMany, changeDate, decideLog, logService, type ActionState } from "./actions";
import { previewCommission, type CommissionType } from "@/lib/commission";
import { centsToPhp } from "@/lib/csv";
import { PhotoGroup, usePhotoSlots } from "./PhotoSlots";
import { ProofGroup, useProofSlots } from "./PaymentProof";

type Opt = { id: string; name: string; eligible?: boolean; here?: boolean; price?: number | null; commission?: number | null; sessions?: number[] | null };

/** A bundle session's label in the Session No. list: "1 · ₱6,800", "8 · paid already", "11 · free". */
function sessionLabel(i: number, list: number[], name: string): string {
  const free = Number(/\+(\d+)/.exec(name)?.[1] ?? 0);
  const c = list[i];
  return `${i + 1} · ${c > 0 ? centsToPhp(c) : i >= list.length - free ? "free" : "paid already"}`;
}


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

/** Meds dropdown (CHRIS Nov 26, update-0069): None, the package free, the package, Clindamycin only, Mupirocin only. */
export type MedsOpt = { id: string; name: string; price: number };
function medsChoices(meds: MedsOpt[]): { v: string; label: string }[] {
  const find = (re: RegExp) => meds.find((m) => re.test(m.name));
  const find1 = (re: RegExp) => meds.find((m) => re.test(m.name) && !/package/i.test(m.name));
  const pack = find(/package/i), clinda = find1(/clinda/i), mupi = find1(/mupi/i);
  const out = [{ v: "", label: "None" }];
  if (pack) out.push({ v: `free:${pack.id}`, label: "Meds Package Free" }, { v: pack.id, label: `Meds Package ${centsToPhp(pack.price)}` });
  if (clinda) out.push({ v: clinda.id, label: `Clindamycin only ${centsToPhp(clinda.price)}` });
  if (mupi) out.push({ v: mupi.id, label: `Mupirocin only ${centsToPhp(mupi.price)}` });
  return out;
}

export function EntryForm({ branch, date, today, services, employees, noCommission = false, photosOptional = false, meds = [] }: { branch: string; date: string; today?: string; services: Opt[]; employees: Opt[]; noCommission?: boolean; photosOptional?: boolean; meds?: MedsOpt[] }) {
  // CHRIS Nov 26: owners and the GM pick the service date (default today) to batch-log older days; it stays set between saves.
  const [day, setDay] = useState(today ?? date);
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
  const [session, setSession] = useState("1");
  const [med, setMed] = useState("");
  const photos = usePhotoSlots(branch);
  const proofs = useProofSlots(branch); // update-0075: optional proof of payment
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      form.current?.querySelector('input[name="confirm"]')?.remove();
      setAmount("");
      setKind("PAID");
      setWho("");
      setService(""); setPartner(""); setClient(""); setPriceNote(""); setShare(false); setNote(""); setSession("1"); setMed("");
      photos.reset();
      proofs.reset();
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
  // A bundle session's amount comes from its schedule (update-0068); anything else from the list price.
  const scheduled = svc?.sessions?.length ? svc.sessions[Number(session) - 1] ?? null : null;
  const listPrice = scheduled ?? svc?.price ?? null;
  const priceDiffers = paid && listPrice != null && (scheduled != null ? amount.trim() !== "" && cents !== scheduled : listPrice > 0 && cents > 0 && cents !== listPrice);
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
      {!photosOptional && <input type="hidden" name="date" value={date} />}
      <input type="hidden" name="type" value={effType} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="folder" value={photos.folder} />
      <input type="hidden" name="photos" value={photos.json} />
      <input type="hidden" name="proofs" value={proofs.json} />
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
        {photosOptional && (
          <label className="span2">Date of service
            <input type="date" name="date" required value={day} max={today ?? date} onChange={(e) => setDay(e.target.value)} />
            {today && day !== today && <span className="small" style={{ color: "var(--bad)" }}>Logging for an earlier day ({new Date(`${day}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}).</span>}
          </label>
        )}
        <label className="span2">Client name
          <input name="client" required minLength={2} maxLength={120} autoComplete="off" placeholder="Full name, as on the waiver" value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        {/* CHRIS Nov 26: Session No. – Service – Amount paid on one row. Most services are session 1; packages (e.g. Gluta) go up to 15. */}
        <div className={`span2 service-row ${paid ? "" : "unpaid"} ${svc?.sessions?.length ? "bundle" : ""}`}>
        <label className="session-field">Session No.
          <select name="session" value={session} onChange={(e) => {
            setSession(e.target.value);
            // Bundles (update-0068): each session has its own amount (₱0 once it's paid for, and the free ones).
            const c = svc?.sessions?.[Number(e.target.value) - 1];
            if (c != null) setAmount(String(c / 100));
          }} aria-label="Session number">
            {svc?.sessions?.length
              ? svc.sessions.map((_, i) => <option key={i + 1} value={i + 1}>{sessionLabel(i, svc.sessions!, svc.name)}</option>)
              : Array.from({ length: 15 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
        </label>
        <label>Service
          <select name="service" required value={service} onChange={(e) => {
            setService(e.target.value);
            const next = services.find((x) => x.id === e.target.value);
            // A bundle: keep the session if it exists in the bundle, else session 1, and fill in that session's amount.
            if (next?.sessions?.length) {
              const n = Number(session) <= next.sessions.length ? Number(session) : 1;
              setSession(String(n));
              setAmount(String(next.sessions[n - 1] / 100));
              return;
            }
            // Fill in the list price (it can still be changed, e.g. for a discount).
            const pr = next?.price;
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
        </div>
        {meds.length > 0 && (
          <label className="span2"><span>Meds{!noCommission && <span className="muted"> (no commission)</span>}</span>
            <select name="meds" value={med} onChange={(e) => setMed(e.target.value)}>
              {medsChoices(meds).map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
            </select>
          </label>
        )}
        {priceDiffers && (
          <label className="span2"><span>Reason for the different price <span className="muted">({scheduled != null ? `session ${session} of this bundle is ${centsToPhp(scheduled)}` : `list price ${centsToPhp(listPrice!)}`})</span></span>
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
      <ProofGroup api={proofs} />
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
        <button type="submit" disabled={pending || photos.uploading || proofs.uploading || !!missing} title={missing ?? undefined}>
          {pending ? "Saving…" : photos.uploading || proofs.uploading ? "Uploading photos…" : "Add to today's log"}
        </button>
      </div>
      {missing && !photos.uploading && (!!service || !!client || photos.slots.length > 0) && <p className="small muted entry-missing">{missing}</p>}
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

/** Owners and the GM (update-0060): approve the ticked entries, or every waiting entry of the day, in one go. */
export function BatchApprove({ ids }: { ids: string[] }) {
  const [state, action, pending] = useActionState(approveMany, undefined);
  return (
    <form id="batch-approve" action={action} className="batch-approve">
      {ids.map((id) => <input key={id} type="hidden" name="all" value={id} />)}
      <span className="small muted">{ids.length} waiting. Tick entries below, or approve them all.</span>
      <button type="submit" className="secondary small" disabled={pending} onClick={pick("selected")}>Approve ticked</button>
      <button type="submit" className="small" disabled={pending} onClick={(e) => { if (!confirm(`Approve all ${ids.length} waiting entries?`)) { e.preventDefault(); return; } pick("all")(e); }}>Approve all {ids.length}</button>
      {state?.ok && <span className="small" style={{ color: "var(--good)" }}>{state.ok}</span>}
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

/** CHRIS Nov 26 (update-0073): owners and the GM fix an entry's date when it was logged on the wrong day. */
export function ChangeDateForm({ id, date, max }: { id: string; date: string; max: string }) {
  const [s, action, pending] = useActionState(changeDate, undefined);
  const [open, setOpen] = useState(false);
  if (s?.ok) return <div className="small ok-text">{s.ok}</div>;
  if (!open) return <button type="button" className="link-button small" onClick={() => setOpen(true)}>Change date</button>;
  return (
    <form action={action} className="change-date">
      <input type="hidden" name="id" value={id} />
      <input type="date" name="date" defaultValue={date} max={max} required aria-label="Correct date" />
      <button className="small" disabled={pending}>Save</button>
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
      {s?.error && <span className="field-error">{s.error}</span>}
    </form>
  );
}
