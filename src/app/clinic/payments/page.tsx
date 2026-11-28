// Proof of payment (update-0075, CHRIS Nov 26): its own folder, by service date, then client name.
// Owners and the GM see every proof; staff see the entries they logged, did, assisted on or attached a proof to.
import Link from "next/link";
import { ControlBar, PeriodNav, Tabs } from "@/components/Controls";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { dayLabel } from "@/lib/homeGlance";
import { branchShort } from "@/lib/schedule";
import { paidToLabel } from "@/lib/paidTo";
import { centsToPhp } from "@/lib/csv";
import { RemoveProof } from "./RemoveProof";
import { ConfirmPayment, FocusFolder } from "./ConfirmPayment";

type Proof = { id: string; path: string; thumb: string | null; by: string | null; by_short?: string | null; at: string };
type Check = { state: "PENDING" | "RECEIVED" | "NOT_RECEIVED"; note: string | null; by: string | null; at: string | null };
type Folder = { id: string; date: string; client: string | null; service: string | null; branch_id: string; branch: string | null; amount_cents: number; kind: string; state: string; staff?: string | null; log_no?: string | null; check?: Check | null; proofs: Proof[] };
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
  const folders = all.filter((f) => (!q || `${f.client ?? ""} ${f.service ?? ""} ${f.staff ?? ""} ${f.log_no ?? ""}`.toLowerCase().includes(q)) && (!waitOnly || f.check?.state === "PENDING"));
  const waiting = all.filter((f) => f.check?.state === "PENDING").length;
  const files = folders.flatMap((f) => f.proofs.flatMap((p) => [p.path, p.thumb].filter((x): x is string => !!x)));
  const view: Record<string, string> = {};
  for (let i = 0; i < files.length; i += 200) {
    const { data: s } = await supabase.storage.from("payment-proofs").createSignedUrls(files.slice(i, i + 200), 3600);
    for (const x of s ?? []) if (x.path && x.signedUrl) view[x.path] = x.signedUrl;
  }
  // update-0103: the account each payment went to, so management checks the right account.
  const paidTo = new Map<string, string>();
  for (let i = 0; i < folders.length; i += 150) {
    const { data: pt } = await supabase.from("service_logs").select("id, paid_to").in("id", folders.slice(i, i + 150).map((f) => f.id));
    for (const r of (pt ?? []) as { id: string; paid_to?: string | null }[]) { const l = paidToLabel(r.paid_to); if (l) paidTo.set(r.id, l); }
  }
  const days = [...new Set(folders.map((f) => f.date))];
  const link = (m: string) => `/clinic/payments?month=${m}${branch ? `&branch=${branch}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const monthLink = (m: string, b: string | null) => `/clinic/payments?month=${m}${b ? `&branch=${b}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
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
        {/* v0.98.1: branch tabs + month nav in one bar (the Service log pattern); search under it. */}
        <ControlBar>
          <Tabs tabs={[{ href: monthLink(month, null), label: "All branches", on: !branch }, ...clinics.map((b) => ({ href: monthLink(month, b.id), label: b.name, on: branch === b.id }))]} />
          <PeriodNav prev={link(shiftMonth(month, -1))} next={month < thisMonth ? link(shiftMonth(month, 1)) : null} label={label}
            reset={month === thisMonth ? null : { href: link(thisMonth), label: "This month" }} prevLabel="Previous month" nextLabel="Next month" />
        </ControlBar>
        <form className="row-buttons log-search" method="get">
          <input type="hidden" name="month" value={month} />
          {branch && <input type="hidden" name="branch" value={branch} />}
          <input name="q" defaultValue={sp.q ?? ""} placeholder="🔍 Search a client or service" aria-label="Client or service" maxLength={60} />
          <button className="secondary small" type="submit">Search</button>
        </form>

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
                          <strong>{f.client ?? "No client name"}{f.staff && <span className="folder-staff"> – {f.staff}</span>}</strong>{f.log_no && <span className="small muted">{f.log_no}</span>}
                          <span className="small muted">{[f.service, branchShort(f.branch ?? ""), centsToPhp(f.amount_cents), paidTo.has(f.id) ? `to ${paidTo.get(f.id)}` : null].filter(Boolean).join(" · ")}</span>
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
                              <span className="small muted">{p.by_short || p.by ? `${p.by_short ?? p.by!.split(" ")[0]} · ` : ""}{at(p.at)}</span>
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
