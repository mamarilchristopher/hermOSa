// Proof of payment (update-0075, CHRIS Nov 26): its own folder, by service date, then client name.
// Owners and the GM see every proof; staff see the entries they logged, did, assisted on or attached a proof to.
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { dayLabel } from "@/lib/homeGlance";
import { branchShort } from "@/lib/schedule";
import { centsToPhp } from "@/lib/csv";
import { RemoveProof } from "./RemoveProof";
import { ConfirmPayment, FocusFolder } from "./ConfirmPayment";

type Proof = { id: string; path: string; thumb: string | null; by: string | null; at: string };
type Check = { state: "PENDING" | "RECEIVED" | "NOT_RECEIVED"; note: string | null; by: string | null; at: string | null };
type Folder = { id: string; date: string; client: string | null; service: string | null; branch_id: string; branch: string | null; amount_cents: number; kind: string; state: string; check?: Check | null; proofs: Proof[] };
const CHECK_TEXT = { PENDING: "Waiting for confirmation", RECEIVED: "Payment received", NOT_RECEIVED: "Not received" } as const;
const CHECK_PILL = { PENDING: "STAGED", RECEIVED: "PUBLISHED", NOT_RECEIVED: "REVERSED" } as const;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shiftMonth = (m: string, by: number) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1)).toISOString().slice(0, 7);
const at = (iso: string) => new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function PaymentProofs({ searchParams }: { searchParams: Promise<{ month?: string; branch?: string; q?: string; entry?: string; wait?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.length) redirect("/");
  const mgmt = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const sp = await searchParams;
  const thisMonth = manilaToday().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const branch = clinics.find((b) => b.id === sp.branch)?.id ?? null;
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 60);

  const { data, error } = await supabase.rpc("payment_proof_folders", { p_month: `${month}-01`, p_branch: branch });
  const all = (Array.isArray(data) ? data : []) as Folder[];
  const waitOnly = sp.wait === "1";
  const folders = all.filter((f) => (!q || `${f.client ?? ""} ${f.service ?? ""}`.toLowerCase().includes(q)) && (!waitOnly || f.check?.state === "PENDING"));
  const waiting = all.filter((f) => f.check?.state === "PENDING").length;
  const files = folders.flatMap((f) => f.proofs.flatMap((p) => [p.path, p.thumb].filter((x): x is string => !!x)));
  const view: Record<string, string> = {};
  for (let i = 0; i < files.length; i += 200) {
    const { data: s } = await supabase.storage.from("payment-proofs").createSignedUrls(files.slice(i, i + 200), 3600);
    for (const x of s ?? []) if (x.path && x.signedUrl) view[x.path] = x.signedUrl;
  }
  const days = [...new Set(folders.map((f) => f.date))];
  const link = (m: string) => `/clinic/payments?month=${m}${branch ? `&branch=${branch}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const label = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Proof of payment</h1>
        <p className="muted small">
          Payment screenshots and receipts attached to service log entries, by service date, then client name. Tap a proof to open it.
          {mgmt ? "" : " You see the entries you logged, did, assisted on or attached a proof to."}
        </p>
        <div className="card">
          <div className="sched-nav">
            <Link className="nav-arrow" href={link(shiftMonth(month, -1))} aria-label="Previous month">‹</Link>
            <div className="week-title"><strong>{label}</strong>
              <span className="small muted">{month === thisMonth ? "This month" : <Link href={link(thisMonth)}>Go to this month</Link>}</span></div>
            {month < thisMonth ? <Link className="nav-arrow" href={link(shiftMonth(month, 1))} aria-label="Next month">›</Link> : <span className="nav-arrow" aria-hidden />}
          </div>
          <form className="field-grid" method="get" style={{ marginTop: 12 }}>
            <input type="hidden" name="month" value={month} />
            {clinics.length > 1 && (
              <label className="field half">Branch
                <select name="branch" defaultValue={branch ?? ""}>
                  <option value="">All branches</option>
                  {clinics.map((b) => <option key={b.id} value={b.id}>{branchShort(b.name)}</option>)}
                </select></label>
            )}
            <label className="field half">Client or service
              <input name="q" defaultValue={sp.q ?? ""} placeholder="Search names" maxLength={60} /></label>
            <div className="field row-buttons"><button className="small" type="submit">Show</button></div>
          </form>
        </div>

        {error ? <div className="notice error">{error.code === "PGRST202" ? "The owner needs to run update-0075 in Supabase first." : "Could not load the proofs. Try again."}</div>
          : folders.length === 0 ? <p className="muted">No proof of payment in {label}{q ? " for that search" : ""}. Attach one from an entry in the Service log.</p> : (
          <>
            <p className="small muted">{folders.length} client folder{folders.length === 1 ? "" : "s"} in {label}.
              {waiting > 0 && <> <strong className="warn-text">{waiting} waiting for confirmation.</strong> {waitOnly ? <Link href={link(month)}>Show all</Link> : <Link href={`${link(month)}&wait=1`}>Show only these</Link>}</>}</p>
            {sp.entry && <FocusFolder id={sp.entry} />}
            {days.map((d) => (
              <section key={d} className="folder-day">
                <h2>{dayLabel(d)}</h2>
                <div className="client-folders">
                  {folders.filter((f) => f.date === d).map((f) => (
                    <details key={f.id} className="client-folder" id={f.id} open={f.id === sp.entry || undefined}>
                      <summary>
                        <span className="folder-icon" aria-hidden>💳</span>
                        <span className="folder-main">
                          <strong>{f.client ?? "No client name"}</strong>
                          <span className="small muted">{[f.service, branchShort(f.branch ?? ""), centsToPhp(f.amount_cents)].filter(Boolean).join(" · ")}</span>
                        </span>
                        <span className="folder-side small muted">{f.proofs.length} proof{f.proofs.length === 1 ? "" : "s"}
                          {f.check && <span className={`pill ${CHECK_PILL[f.check.state]}`}>{CHECK_TEXT[f.check.state]}</span>}
                          {f.state === "REJECTED" && <span className="pill REVERSED">Rejected entry</span>}</span>
                      </summary>
                      <ul className="plain-list folder-photos">
                        {f.proofs.map((p) => {
                          const src = p.thumb ? view[p.thumb] : /\.hei[cf]$/i.test(p.path) ? undefined : view[p.path];
                          return (
                            <li key={p.id}>
                              <a href={view[p.path]} target="_blank" rel="noreferrer" className="folder-photo">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {src ? <img src={src} alt={`Proof of payment, ${f.client ?? "client"}`} loading="lazy" /> : <span className="folder-nothumb">Open proof</span>}
                              </a>
                              <span className="small muted">{p.by ? `${p.by.split(" ")[0]} · ` : ""}{at(p.at)}</span>
                              {(mgmt || p.by === access.display_name) && <RemoveProof id={p.id} />}
                            </li>
                          );
                        })}
                      </ul>
                      {f.check && (
                        <div className="pay-check">
                          <span className={`pill ${CHECK_PILL[f.check.state]}`}>{CHECK_TEXT[f.check.state]}</span>
                          {f.check.state !== "PENDING" && <span className="small muted">{f.check.by ? `by ${f.check.by.split(" ")[0]}` : ""}{f.check.at ? ` · ${at(f.check.at)}` : ""}{f.check.note ? ` · ${f.check.note}` : ""}</span>}
                          {mgmt && <ConfirmPayment log={f.id} state={f.check.state} />}
                        </div>
                      )}
                      <div className="folder-foot"><Link className="small" href={`/services?date=${f.date}&branch=${branches.find((b) => b.id === f.branch_id)?.code ?? ""}&entry=${f.id}#entry-${f.id}`}>Open the entry</Link></div>
                    </details>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}
