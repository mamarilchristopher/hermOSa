"use client";
import { pick } from "@/lib/decision";
import { BACKJOB_REASONS } from "@/lib/backjobs";
import { useActionState, useEffect, useRef, useState } from "react";
import { addService, approveMany, changeBranch, changeDate, renameClient, renumberMonth, decideLog, logService, toggleAfterDp, type ActionState } from "./actions";
import { previewCommission, type CommissionType } from "@/lib/commission";
import { centsToPhp } from "@/lib/csv";
import { PhotoGroup, usePhotoSlots } from "./PhotoSlots";
import { ProofGroup, useProofSlots } from "./PaymentProof";
import { promoItemLabel, promoOf, promoServiceIds, type PromoOptions } from "@/lib/promoTrack";
import { payStatus, planDues, sessionsUnlocked } from "@/lib/promoPay";
import { packageRecord, type PackageLine } from "@/lib/packages";

type Opt = { id: string; name: string; eligible?: boolean; here?: boolean; price?: number | null; commission?: number | null; sessions?: number[] | null };

/**
 * A bundle session's label in the Session No. list: "1", "2", … "11 · free".
 * CHRIS Nov 27: no preset prices per session (clients pay differently depending on the promo they availed),
 * so the list only says which sessions are the free ones; staff type what the client paid.
 */
function sessionLabel(i: number, list: number[], name: string): string {
  const free = Number(/\+(\d+)/.exec(name)?.[1] ?? 0);
  return `${i + 1}${free && i >= list.length - free ? " · free" : ""}`;
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

/** CHRIS Nov 26 (v0.80.1): on "All branches" the entry form asks which branch first. Photos upload into the branch's
 *  folder, so switching the branch starts the form over (the key). Staff at one branch never see the picker. */
export function BranchEntryForm({ branches, start, employees, ...rest }: Omit<Parameters<typeof EntryForm>[0], "branch" | "employees"> & {
  branches: { id: string; name: string }[]; start: string; employees: (Opt & { branch: string })[];
}) {
  const [picked, setB] = useState(start);
  // One branch to log for: always that one (the state can be stale after switching from All branches).
  const b = branches.length === 1 ? branches[0].id : branches.some((x) => x.id === picked) ? picked : "";
  const people = employees.map(({ branch, ...e }) => ({ ...e, here: branch === b }));
  return (
    <>
      {branches.length > 1 && (
        <div className="field">
          <span className="field-label">Branch</span>
          <div className="segmented choice" role="radiogroup" aria-label="Branch">
            {branches.map((x) => (
              <button type="button" key={x.id} role="radio" aria-checked={b === x.id} className={b === x.id ? "on" : ""} onClick={() => setB(x.id)}>{x.name.replace(/ \(.*\)$/, "")}</button>
            ))}
          </div>
          {!b && <span className="small muted">Pick the branch where the service was done.</span>}
        </div>
      )}
      {b && <EntryForm key={b} branch={b} employees={people} {...rest} />}
    </>
  );
}

/** Add-ons (CHRIS Nov 26, update-0080): extras sold with a service, e.g. L-Carnitine with a Lux Queen drip. */
export type AddonOpt = { id: string; name: string; price: number | null };
type AddonRow = { service: string; amount: string };
/** update-0093 (CHRIS Nov 27): another service the same client had in this visit, with the usual commission rules. */
type MoreRow = { service: string; amount: string; note: string };

/** update-0091 (CHRIS Nov 27): the booking this sale is logged from (tapped on Bookings), so the visit isn't recorded twice. */
export type FromBooking = { id: string; fbName: string; waiverName: string | null; serviceId: string | null };

export function EntryForm({ branch, date, today, services, employees, noCommission = false, photosOptional = false, meds = [], addons = [], promos = null, booking = null, packages = [] }: { branch: string; date: string; today?: string; services: Opt[]; employees: Opt[]; noCommission?: boolean; photosOptional?: boolean; meds?: MedsOpt[]; addons?: AddonOpt[]; promos?: PromoOptions | null; booking?: FromBooking | null; packages?: PackageLine[] }) {
  // CHRIS Nov 26: owners and the GM pick the service date (default today) to batch-log older days; it stays set between saves.
  const [day, setDay] = useState(today ?? date);
  const [state, action, pending] = useActionState(logService, undefined);
  // CHRIS Nov 26: no Lead/Assist/Solo choice. "Done by" is the lead; a commission-based lead may add an assistant (default None).
  const [kind, setKind] = useState<Kind>("PAID");
  const paid = kind === "PAID";
  const [bjReason, setBjReason] = useState("");
  const [bjStaff, setBjStaff] = useState("");
  const [amount, setAmount] = useState("");
  const [who, setWho] = useState("");
  // Controlled so the fields survive a "log it anyway?" round trip (React resets uncontrolled fields after an action).
  const [service, setService] = useState(booking?.serviceId ?? "");
  const [partner, setPartner] = useState("");
  const [client, setClient] = useState(booking ? booking.waiverName ?? booking.fbName : "");
  // "Same Facebook and waiver name?" (ticked by default). Unticked, the waiver name is typed and takes priority in all records.
  const [sameName, setSameName] = useState(!booking?.waiverName);
  const [priceNote, setPriceNote] = useState("");
  const [share, setShare] = useState(false);
  const [note, setNote] = useState("");
  const [session, setSession] = useState("1");
  const [med, setMed] = useState("");
  const [extras, setExtras] = useState<AddonRow[]>([]);
  const [more, setMore] = useState<MoreRow[]>([]);
  const [afterDp, setAfterDp] = useState(false); // update-0085: balance paid after a down payment
  // update-0087: the client's promo for a promo item ("" = not picked, "new" = starts the promo with this visit).
  const [promoClient, setPromoClient] = useState("");
  // update-0091: on an installment promo, the new client's plan (1 = full payment).
  const [payPlan, setPayPlan] = useState("1");
  // CHRIS Nov 27 (update-0091): "Service has before and after photo?" ticked by default; unticked, only the waiver is needed.
  const [hasBa, setHasBa] = useState(true);
  const [contact, setContact] = useState("");
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
      setService(""); setPartner(""); setClient(booking ? (sameName ? booking.fbName : client) : ""); setPriceNote(""); setShare(false); setNote(""); setSession("1"); setMed(""); setExtras([]); setMore([]); setAfterDp(false); setPromoClient(""); setContact(""); setPayPlan("1"); setHasBa(true);
      photos.reset();
      proofs.reset();
    }
  }, [state]);
  const person = employees.find((e) => e.id === who);
  const partnerEmp = employees.find((e) => e.id === partner);
  const cents = Math.round(Number(amount.replace(/[,₱\s]/g, "")) * 100) || 0;
  const svc = services.find((x) => x.id === service);
  // update-0087: a promo item (a session or the payment line) and the clients on that promo.
  const pm = svc ? promoOf(svc.id, promos) : null;
  const promoIds = promoServiceIds(promos);
  const pmClients = pm ? (promos?.clients ?? []).filter((c) => c.promo_id === pm.promo.id) : [];
  const pc = pmClients.find((c) => c.id === promoClient) ?? null;
  const pmUsed = pc && svc ? pc.used[svc.id] ?? 0 : 0;
  const pmBalance = pm ? (pc ? Math.max(0, pc.price_cents - pc.paid_cents) : pm.promo.price_cents) : 0;
  const pmDone = pm?.part ? pmUsed >= pm.part.sessions : false;
  const pmInstall = !!pm && pm.promo.pay_options === "INSTALLMENT" && (pm.promo.max_payments ?? 0) >= 2;
  const pmGated = !!pm && !!pm.promo.pay_options && !!pm.promo.pay_service_id;
  const pmUsedAll = pc ? Object.values(pc.used).reduce((a, b) => a + b, 0) : 0;
  const pmUnlocked = pc && pm ? sessionsUnlocked(pm.promo.sessions ?? pmUsedAll, pc.paid_cents, pc.price_cents) : 0;
  const pmPay = pc && pmInstall ? payStatus(pc.price_cents, pc.payments ?? 1, pc.start_on, pc.paid_cents, today ?? date) : null;
  /** Picking the client's promo fills in their name, their next session and its amount. */
  function pickPromoClient(v: string, sv = svc) {
    setPromoClient(v);
    const m = sv ? promoOf(sv.id, promos) : null;
    if (!m || !sv) return;
    const c = (promos?.clients ?? []).find((x) => x.id === v);
    if (c) setClient(c.client);
    const used = c ? c.used[sv.id] ?? 0 : 0;
    if (m.pay) {
      // update-0091: a client on installments pays their next payment; a new one their first (or the full price).
      const bal = c ? Math.max(0, c.price_cents - c.paid_cents) : m.promo.price_cents;
      const plan = c ? c.payments ?? 1 : Number(payPlan) || 1;
      const nextAmt = plan > 1 ? (c ? payStatus(c.price_cents, plan, c.start_on, c.paid_cents, c.start_on).next?.amount ?? bal : planDues(m.promo.price_cents, plan, "2000-01-01")[0].amount) : bal;
      setAmount(nextAmt > 0 ? String(nextAmt / 100) : ""); return;
    }
    if (sv.sessions?.length) { const n = Math.min(sv.sessions.length, used + 1); setSession(String(n)); setAmount(String((sv.sessions[n - 1] ?? 0) / 100)); return; }
    setSession("1"); setAmount("0");
  }
  // Lead with "Assisted by: None" is saved as Solo; the 60/40 split applies only once an assistant is chosen (CHRIS Nov 26).
  const effType: CommissionType = person?.eligible === false ? "NONCOMMI" : partner ? "LEAD" : "SOLO";
  // CHRIS Nov 27 (update-0085): a balance paid after a DP earns 5% of the whole package (list) price.
  const dpPossible = paid && !svc?.sessions?.length && !!svc?.price && svc.price > 0 && cents > 0 && cents < svc.price;
  const dpOn = afterDp && dpPossible;
  const raw = dpOn ? previewCommission(svc!.price!, effType, null, null)
    : previewCommission(paid ? cents : 0, paid ? effType : "NONCOMMI", svc?.commission, svc?.price);
  // Only commission-based people get a share; someone not on commission is never mentioned (CHRIS Nov 26).
  const leadEmp = person, assistEmp = partnerEmp;
  const shown = {
    lead: leadEmp?.eligible === false ? 0 : raw.lead,
    assist: assistEmp?.eligible === false ? 0 : raw.assist,
    solo: person?.eligible === false ? 0 : raw.solo,
  };
  // Add-ons pay 5% of what was paid for each, split like the main service (CHRIS Nov 26).
  const toCents = (t: string) => Math.round(Number(t.replace(/[,₱\s]/g, "")) * 100) || 0;
  const extraRows = paid ? extras.filter((x) => x.service) : [];
  const extra = extraRows.reduce((acc, x) => {
    const c = previewCommission(toCents(x.amount), effType, null, null);
    return { lead: acc.lead + (leadEmp?.eligible === false ? 0 : c.lead), assist: acc.assist + (assistEmp?.eligible === false ? 0 : c.assist), solo: acc.solo + (person?.eligible === false ? 0 : c.solo) };
  }, { lead: 0, assist: 0, solo: 0 });
  // update-0093: more services of the same visit, each with its own set commission or 5% (a discount earns 5% of what was paid).
  const moreChoices = services.filter((s) => (s.price ?? 0) > 0 && !s.sessions?.length);
  const moreRows = paid ? more.filter((x) => x.service) : [];
  for (const x of moreRows) {
    const s = moreChoices.find((o) => o.id === x.service);
    const c = previewCommission(toCents(x.amount), effType, s?.commission ?? null, s?.price ?? null);
    extra.lead += leadEmp?.eligible === false ? 0 : c.lead; extra.assist += assistEmp?.eligible === false ? 0 : c.assist; extra.solo += person?.eligible === false ? 0 : c.solo;
  }
  const moreJson = JSON.stringify(moreRows.map((x) => ({ service: x.service, amount: x.amount.trim(), note: x.note.trim() })));
  const mainTotal = shown.lead + shown.assist + shown.solo;
  const extraTotal = extra.lead + extra.assist + extra.solo;
  const p = { ...raw, lead: raw.lead + extra.lead, assist: raw.assist + extra.assist, total: mainTotal + extraTotal };
  shown.lead += extra.lead; shown.assist += extra.assist; shown.solo += extra.solo;
  const addonsJson = JSON.stringify(extraRows.map((x) => ({ service: x.service, amount: x.amount.trim() })));
  // CHRIS Nov 27: bundle sessions have no preset amount; anything else starts from the list price.
  const scheduled: number | null = null;
  const pkg = svc?.sessions?.length && !pm ? packageRecord(packages, client, svc.id) : null;
  const pkgRepeat = pkg && pkg.done.includes(Number(session)) ? pkg.lines.find((l) => l.session === Number(session)) : null;
  const listPrice = scheduled ?? svc?.price ?? null;
  const priceDiffers = paid && listPrice != null && (scheduled != null ? amount.trim() !== "" && cents !== scheduled : listPrice > 0 && cents > 0 && cents !== listPrice);
  const needsPhotos = kind === "PAID" || kind === "BACKJOB";
  const missingPhotos = !needsPhotos ? null
    : hasBa && (photos.count("BEFORE") < 1 || photos.count("AFTER") < 1) ? "Add at least one before and one after photo."
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
      {state?.link && <p className="small"><a className="button secondary small" href={state.link}>Open the client&apos;s schedule to send them</a></p>}
      <input type="hidden" name="branch" value={branch} />
      {!photosOptional && <input type="hidden" name="date" value={date} />}
      <input type="hidden" name="type" value={effType} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="folder" value={photos.folder} />
      <input type="hidden" name="photos" value={photos.json} />
      <input type="hidden" name="proofs" value={proofs.json} />
      <input type="hidden" name="addons" value={addonsJson} />
      <input type="hidden" name="more" value={moreJson} />
      {needsPhotos && !hasBa && <input type="hidden" name="no_ba" value="1" />}
      <div className="field">
        <span className="field-label">Did the client pay?</span>
        <div className="segmented choice" role="radiogroup" aria-label="Did the client pay?">
          {KINDS.map((k) => (
            <button type="button" key={k.v} role="radio" aria-checked={kind === k.v} className={kind === k.v ? "on" : ""} onClick={() => setKind(k.v)}>{k.label}</button>
          ))}
        </div>
        {!paid && <span className="small muted">{noCommission ? "Logged at ₱0, so you can see every client handled." : "Logged at ₱0 with no commission, so you can see every client handled."}</span>}
      </div>
      {/* update-0088 (CHRIS Nov 27): what the backjob fixes and who did the first treatment, for backjob tracking. */}
      {kind === "BACKJOB" && (
        <div className="backjob-box">
          <div className="field">
            <span className="field-label">What needs fixing?</span>
            <div className="chip-pick" role="radiogroup" aria-label="What needs fixing?">
              {BACKJOB_REASONS.map((r) => (
                <button type="button" key={r.v} role="radio" aria-checked={bjReason === r.v} className={bjReason === r.v ? "on" : ""} onClick={() => setBjReason(bjReason === r.v ? "" : r.v)}>{r.label}</button>
              ))}
            </div>
          </div>
          <label>First treatment done by
            <select name="bj_staff" value={bjStaff} onChange={(e) => setBjStaff(e.target.value)}>
              <option value="">Find it from the client&apos;s last visit</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span className="small muted">Leave it to find it automatically from the client&apos;s earlier entry of this service.</span>
          </label>
          <input type="hidden" name="bj_reason" value={bjReason} />
        </div>
      )}
      <div className="entry-grid">
        {photosOptional && (
          <label className="span2">Date of service
            <input type="date" name="date" required value={day} max={today ?? date} onChange={(e) => setDay(e.target.value)} />
            {today && day !== today && <span className="small" style={{ color: "var(--bad)" }}>Logging for an earlier day ({new Date(`${day}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}).</span>}
          </label>
        )}
        {booking ? (
          <div className="span2 booking-name">
            <input type="hidden" name="booking" value={booking.id} />
            <label className="check-row">
              <input type="checkbox" checked={sameName} onChange={(e) => { setSameName(e.target.checked); setClient(e.target.checked ? booking.fbName : booking.waiverName ?? ""); }} />
              <span>Same Facebook and waiver name? <span className="muted">(booked as {booking.fbName})</span></span>
            </label>
            {sameName ? (
              <label>Client name<input name="client" readOnly value={booking.fbName} /></label>
            ) : (
              <label><span>Waiver name <span className="muted">(used in all records; the booking keeps {booking.fbName} as the Facebook name)</span></span>
                <input name="client" required minLength={2} maxLength={120} autoComplete="off" placeholder="Full name, as on the waiver" value={client} onChange={(e) => setClient(e.target.value)} autoFocus={!client} />
              </label>
            )}
          </div>
        ) : (
          <label className="span2">Client name
            <input name="client" required minLength={2} maxLength={120} autoComplete="off" placeholder="Full name, as on the waiver" value={client} onChange={(e) => setClient(e.target.value)} />
          </label>
        )}
        {/* CHRIS Nov 26: Session No. – Service – Amount paid on one row. Most services are session 1; packages (e.g. Gluta) go up to 15. */}
        <div className={`span2 service-row ${paid ? "" : "unpaid"} ${svc?.sessions?.length ? "bundle" : ""}`}>
        {pm ? (
          <label className="session-field">Session No.
            <input type="hidden" name="session" value={pm.part && svc?.sessions?.length ? session : "1"} />
            <span className="promo-session">{pm.pay ? "Payment" : promoClient === "new" || pc ? `${pmUsed + 1} of ${pm.part!.sessions}` : "–"}</span>
          </label>
        ) : (
        <label className="session-field">Session No.
          <select name="session" value={session} onChange={(e) => setSession(e.target.value)} aria-label="Session number">
            {svc?.sessions?.length
              ? svc.sessions.map((_, i) => <option key={i + 1} value={i + 1}>{sessionLabel(i, svc.sessions!, svc.name)}</option>)
              : Array.from({ length: 15 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
        </label>
        )}
        <label>Service
          <select name="service" required value={service} onChange={(e) => {
            setService(e.target.value);
            const next = services.find((x) => x.id === e.target.value);
            // A promo item: the client's promo decides the session and amount (update-0087).
            setPromoClient("");
            const nm = next ? promoOf(next.id, promos) : null;
            if (nm) {
              const list = (promos?.clients ?? []).filter((c) => c.promo_id === nm.promo.id);
              if (list.length === 0 && nm.promo.state === "APPROVED") pickPromoClient("new", next);
              else { setAmount(nm.pay ? "" : nm.part && next?.sessions?.length ? "" : "0"); }
              return;
            }
            // A bundle: the client's next session if they already have a package record, else session 1.
            // CHRIS Nov 27: the amount is left empty: staff type what this client paid (it varies by promo).
            if (next?.sessions?.length) {
              const rec = packageRecord(packages, client, next.id);
              setSession(String(rec ? Math.min(next.sessions.length, rec.last + 1) : Number(session) <= next.sessions.length ? Number(session) : 1));
              setAmount("");
              return;
            }
            // Fill in the list price (it can still be changed, e.g. for a discount).
            const pr = next?.price;
            if (pr != null) setAmount(pr > 0 ? String(pr / 100) : "");
          }}>
            <option value="" disabled>Choose a service…</option>
            {services.filter((s) => !promoIds.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {services.some((s) => promoIds.has(s.id)) && (
              <optgroup label="Promos">
                {services.filter((s) => promoIds.has(s.id)).map((s) => <option key={s.id} value={s.id}>{promoItemLabel(s.id, promos) ?? s.name}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        {paid && (
          <label>Amount paid (₱)
            <input name="amount" inputMode="decimal" placeholder={svc?.sessions?.length && !pm ? "What the client paid (0 if none)" : "e.g. 2500"} required value={amount} readOnly={!!pm?.part && !!pm.promo.pay_service_id} onChange={(e) => setAmount(e.target.value)} />
          </label>
        )}
        </div>
        {svc?.sessions?.length && !pm ? (
          <div className="span2 pkg-record small">
            {pkg ? (
              <>
                <strong>{client.trim()}&apos;s {svc.name}:</strong> started in Hermosapp at session {pkg.start} ({new Date(`${pkg.startDate}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" })}).
                Sessions logged: {pkg.done.join(", ")} · paid so far {centsToPhp(pkg.paid)}.
                {pkg.last < svc.sessions.length ? <> Next: <strong>session {pkg.last + 1}</strong> of {svc.sessions.length}.</> : <> All {svc.sessions.length} sessions are logged.</>}
                {pkgRepeat && <span style={{ color: "var(--bad)", display: "block" }}>Session {session} is already logged for this client ({new Date(`${pkgRepeat.date}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}). Check the session number.</span>}
              </>
            ) : client.trim().length >= 2
              ? <>No sessions of {svc.name} logged yet for {client.trim()}. The session you pick now starts their record (e.g. pick 2 if they did session 1 before Hermosapp).</>
              : <>Type the client&apos;s name to see their sessions of this package.</>}
          </div>
        ) : null}
        {pm && (
          <div className="span2 promo-pick">
            <input type="hidden" name="promo_client" value={promoClient} />
            <input type="hidden" name="promo_contact" value={contact} />
            <input type="hidden" name="promo_payments" value={pmInstall && promoClient === "new" ? payPlan : "1"} />
            <label>Client&apos;s promo ({pm.promo.title})
              <select value={promoClient} required onChange={(e) => pickPromoClient(e.target.value)}>
                <option value="" disabled>Choose the client…</option>
                {pm.promo.state === "APPROVED" && <option value="new">New client: starts {pm.promo.title} today</option>}
                {pmClients.map((c) => {
                  const done = pm.part ? c.used[pm.part.service_id] ?? 0 : null;
                  return <option key={c.id} value={c.id}>{c.client}{done !== null ? ` · ${done} of ${pm.part!.sessions} done` : ` · ${centsToPhp(Math.max(0, c.price_cents - c.paid_cents))} left to pay`} · until {c.ends_on}</option>;
                })}
              </select>
            </label>
            {!paid && <span className="small" style={{ color: "var(--bad)" }}>Promo sessions are logged as Paid (₱0 when the client already paid). For a backjob or check-up, pick the usual service instead.</span>}
            {promoClient === "new" && (
              <>
                <label>Client&apos;s mobile number <span className="muted">(optional, for reminders)</span>
                  <input inputMode="tel" maxLength={40} value={contact} onChange={(e) => setContact(e.target.value)} placeholder="09xx xxx xxxx" />
                </label>
                {pmInstall && (
                  <label>How will they pay?
                    <select value={payPlan} onChange={(e) => { setPayPlan(e.target.value); if (pm.pay) { const n = Number(e.target.value); setAmount(String((n > 1 ? planDues(pm.promo.price_cents, n, "2000-01-01")[0].amount : pm.promo.price_cents) / 100)); } }}>
                      <option value="1">Full payment today: {centsToPhp(pm.promo.price_cents)}</option>
                      {Array.from({ length: (pm.promo.max_payments ?? 1) - 1 }, (_, i) => i + 2).map((n) => {
                        const d = planDues(pm.promo.price_cents, n, "2000-01-01");
                        return <option key={n} value={n}>{n} monthly payments: {centsToPhp(d[0].amount)} today, then {centsToPhp(d[1].amount)} a month</option>;
                      })}
                    </select>
                  </label>
                )}
                {pmGated && !pm.pay && <span className="small" style={{ color: "var(--bad)" }}>Log their payment first: pick &quot;{pm.promo.title}: payment&quot; and choose New client there. Sessions open as they pay.</span>}
                <span className="small muted">
                  Starts {pm.promo.title} for {client.trim() || "this client"} today: {pm.promo.parts.map((x) => `${x.sessions} ${x.name.replace(/\s*single session$/i, "")}`).join(", ")}, {centsToPhp(pm.promo.price_cents)}, valid {pm.promo.months} month{pm.promo.months === 1 ? "" : "s"}.
                  {" "}After saving you get their recommended schedule to send them.
                  {pm.promo.pay_service_id && !pm.pay ? " Log what they pay today on the payment line too." : ""}
                </span>
              </>
            )}
            {pc && pm.part && <span className="small muted">{pmDone ? <span style={{ color: "var(--bad)" }}>All {pm.part.sessions} sessions are used.</span> : `Session ${pmUsed + 1} of ${pm.part.sessions} for ${pc.client}.`}{pm.promo.pay_service_id ? " Already paid in the promo, so ₱0." : ""} {centsToPhp(Math.max(0, pc.price_cents - pc.paid_cents))} left to pay. <a href={`/promos/client/${pc.id}`}>Schedule</a></span>}
            {pc && pm.pay && <span className="small muted">{centsToPhp(pmBalance)} left to pay of {centsToPhp(pc.price_cents)}. <a href={`/promos/client/${pc.id}`}>Schedule</a></span>}
            {pc && pmPay && (pmPay.next ? <span className="small" style={{ color: pmPay.late ? "var(--bad)" : undefined }}>{pc.payments} monthly payments: next {centsToPhp(pmPay.next.amount)} due {pmPay.next.due}{pmPay.late ? ` (behind by ${centsToPhp(pmPay.behind)})` : ""}.</span> : <span className="small muted">Fully paid.</span>)}
            {pc && pm.part && pmGated && pmUsedAll >= pmUnlocked && pmUnlocked < (pm.promo.sessions ?? 0) && <span className="small" style={{ color: "var(--bad)" }}>Sessions follow payments: {pc.client} has used the {pmUnlocked} session{pmUnlocked === 1 ? "" : "s"} paid so far. Log their next payment first.</span>}
          </div>
        )}
        {meds.length > 0 && (
          <label className="span2"><span>Meds{!noCommission && <span className="muted"> (no commission)</span>}</span>
            <select name="meds" value={med} onChange={(e) => setMed(e.target.value)}>
              {medsChoices(meds).map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
            </select>
          </label>
        )}
        {paid && addons.length > 0 && (
          <div className="span2 addons">
            {extras.map((x, i) => (
              <div className="addon-row" key={i}>
                <label><span>Add-on{!noCommission && <span className="muted"> (5% commission)</span>}</span>
                  <select value={x.service} aria-label="Add-on" onChange={(e) => {
                    const a = addons.find((o) => o.id === e.target.value);
                    setExtras(extras.map((y, j) => j === i ? { service: e.target.value, amount: a?.price ? String(a.price / 100) : "" } : y));
                  }}>
                    <option value="" disabled>Choose an add-on…</option>
                    {addons.map((o) => <option key={o.id} value={o.id}>{o.name}{o.price ? ` ${centsToPhp(o.price)}` : ""}</option>)}
                  </select>
                </label>
                <label>Add-on paid (₱)
                  <input inputMode="decimal" placeholder="e.g. 500" value={x.amount} required={!!x.service} onChange={(e) => setExtras(extras.map((y, j) => j === i ? { ...y, amount: e.target.value } : y))} />
                </label>
                <button type="button" className="secondary small addon-remove" aria-label="Remove add-on" onClick={() => setExtras(extras.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="secondary small" onClick={() => setExtras([...extras, { service: addons.length === 1 ? addons[0].id : "", amount: addons.length === 1 && addons[0].price ? String(addons[0].price / 100) : "" }])}>+ Add-on{extras.length ? " (another)" : ""}</button>
          </div>
        )}
        {paid && (
          <div className="span2 addons more-services">
            {more.map((x, i) => {
              const s = moreChoices.find((o) => o.id === x.service);
              const differs = !!s && x.amount.trim() !== "" && toCents(x.amount) !== (s.price ?? 0);
              const set = (p: Partial<MoreRow>) => setMore(more.map((y, j) => (j === i ? { ...y, ...p } : y)));
              return (
                <div className="addon-row" key={i}>
                  <label><span>Another service</span>
                    <select value={x.service} aria-label="Another service" onChange={(e) => {
                      const o = moreChoices.find((m) => m.id === e.target.value);
                      set({ service: e.target.value, amount: o?.price ? String(o.price / 100) : "", note: "" });
                    }}>
                      <option value="" disabled>Choose a service…</option>
                      {moreChoices.map((o) => <option key={o.id} value={o.id}>{o.name} {centsToPhp(o.price ?? 0)}</option>)}
                    </select>
                  </label>
                  <label>Amount paid (₱)
                    <input inputMode="decimal" placeholder="e.g. 1500" value={x.amount} required={!!x.service} onChange={(e) => set({ amount: e.target.value })} />
                  </label>
                  <button type="button" className="secondary small addon-remove" aria-label="Remove service" onClick={() => setMore(more.filter((_, j) => j !== i))}>✕</button>
                  {differs && (
                    <label className="addon-note"><span>Reason for the different price <span className="muted">(list price {centsToPhp(s!.price ?? 0)})</span></span>
                      <input required minLength={3} maxLength={300} placeholder="e.g. 10% promo, loyalty discount" value={x.note} onChange={(e) => set({ note: e.target.value })} />
                    </label>
                  )}
                </div>
              );
            })}
            <button type="button" className="secondary small" onClick={() => setMore([...more, { service: "", amount: "", note: "" }])}>+ Another service{more.length ? " (one more)" : ""}</button>
            {more.length === 0 && <span className="small muted">Same client, more than one service? Add each one here: one entry, same photos, each with its own commission.</span>}
          </div>
        )}
        {dpPossible && (
          <label className="check-row span2">
            <input type="checkbox" name="after_dp" value="1" checked={afterDp} onChange={(e) => {
              setAfterDp(e.target.checked);
              if (e.target.checked && !priceNote.trim()) setPriceNote("Balance after DP");
              if (!e.target.checked && priceNote === "Balance after DP") setPriceNote("");
            }} />
            <span>This is the balance after a DP (down payment) <span className="muted">(commission is 5% of the full price {centsToPhp(svc!.price!)})</span></span>
          </label>
        )}
        {priceDiffers && (
          <label className="span2"><span>Reason for the different price <span className="muted">({scheduled != null ? `session ${session} of this bundle is ${centsToPhp(scheduled)}` : `list price ${centsToPhp(listPrice!)}`})</span></span>
            <input name="price_note" required minLength={3} maxLength={300} placeholder="e.g. 10% promo, loyalty discount" value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
          </label>
        )}
      </div>
      {needsPhotos && (
        <label className="check-row">
          <input type="checkbox" checked={hasBa} onChange={(e) => setHasBa(e.target.checked)} />
          <span>Service has before and after photo? <span className="muted">{hasBa ? "(Yes: add at least one before and one after)" : "(No: only the signed waiver is needed)"}</span></span>
        </label>
      )}
      <PhotoGroup api={photos} title="Before and after photos" hint={needsPhotos && hasBa ? "Pick them all at once (at least one before and one after). Tap a photo's label to switch Before / After." : "Optional for this visit. Tap a photo's label to switch Before / After."}
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
              {extraTotal > 0 && <span className="muted">{svc?.name ?? "service"} {centsToPhp(mainTotal)} + add-on{extraRows.length > 1 ? "s" : ""} {centsToPhp(extraTotal)}</span>}
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

/** update-0095 (Geraldine's list): fix a misspelled client name. Management may fix every entry with that name at once. */
export function RenameClientForm({ id, name, all }: { id: string; name: string; all: boolean }) {
  const [s, action, pending] = useActionState(renameClient, undefined);
  const [open, setOpen] = useState(false);
  if (s?.ok) return <div className="small ok-text">{s.ok}</div>;
  if (!open) return <button type="button" className="link-button small" onClick={() => setOpen(true)}>Fix name</button>;
  return (
    <form action={action} className="change-date">
      <input type="hidden" name="id" value={id} />
      <input name="name" defaultValue={name} required minLength={2} maxLength={120} aria-label="Correct client name" autoFocus />
      {all && <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" name="all" value="1" defaultChecked style={{ width: "auto" }} /> All entries named &ldquo;{name}&rdquo;</label>}
      <button className="small" disabled={pending}>Save</button>
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
      {s?.error && <span className="field-error">{s.error}</span>}
    </form>
  );
}

/** update-0095: owners and the GM move an entry to the branch where it was really done. */
export function ChangeBranchForm({ id, branch, branches }: { id: string; branch: string; branches: { id: string; name: string }[] }) {
  const [s, action, pending] = useActionState(changeBranch, undefined);
  const [open, setOpen] = useState(false);
  if (s?.ok) return <div className="small ok-text">{s.ok}</div>;
  if (!open) return <button type="button" className="link-button small" onClick={() => setOpen(true)}>Change branch</button>;
  return (
    <form action={action} className="change-date">
      <input type="hidden" name="id" value={id} />
      <select name="branch" defaultValue={branch} aria-label="Correct branch">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      <button className="small" disabled={pending}>Save</button>
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
      {s?.error && <span className="field-error">{s.error}</span>}
    </form>
  );
}

/** CHRIS Nov 27 (update-0085): owners and the GM mark an entry as the balance after a DP (commission = 5% of the full price). */
export function AfterDpForm({ id, on }: { id: string; on: boolean }) {
  const [s, action, pending] = useActionState(toggleAfterDp, undefined);
  return (
    <form action={action} className="inline-form" onSubmit={(e) => { if (on && !confirm("Unmark this entry? Its commission goes back to 5% of the amount paid.")) e.preventDefault(); }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="on" value={on ? "0" : "1"} />
      <button className="link-button small" disabled={pending}>{pending ? "Saving…" : on ? "Not a DP balance" : "Balance after DP"}</button>
      {s?.ok && <span className="small ok-text"> {s.ok}</span>}
      {s?.error && <span className="field-error"> {s.error}</span>}
    </form>
  );
}

/** Owners only: once a month's sales are final, number its entries in order (date, then branch, then time entered). */
export function RenumberForm({ month, label }: { month: string; label: string }) {
  const [s, action, pending] = useActionState(renumberMonth, undefined);
  return (
    <form action={action} className="renumber" onSubmit={(e) => { if (!confirm(`Re-number every ${label} entry in order? Their numbers will change.`)) e.preventDefault(); }}>
      <input type="hidden" name="month" value={month} />
      <span className="small muted">Entry numbers (SL-) run in the order entries were made. Once {label} sales are final, put them in order of service date, then branch:</span>
      <button className="secondary small" disabled={pending}>{pending ? "Re-numbering…" : `Re-number ${label}`}</button>
      {s?.ok && <span className="small ok-text">{s.ok}</span>}
      {s?.error && <span className="field-error">{s.error}</span>}
    </form>
  );
}
