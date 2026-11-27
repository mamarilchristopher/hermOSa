import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { branchShort } from "@/lib/schedule";
import { PhotoDecision } from "./PhotoDecision";

type Ph = { kind: "BEFORE" | "AFTER" | "WAIVER"; path: string; thumb: string | null };
type Change = { op: "ADD" | "REMOVE" | "REPLACE"; kind?: Ph["kind"]; path?: string; thumb?: string | null; old?: Ph | null };
type Req = { id: string; state: string; note: string; decision_note: string | null; at: string; decided_at: string | null; by: string | null; decider: string | null;
  mine: boolean; log: string; date: string; client: string | null; service: string | null; branch: string | null; changes: Change[] };
const KIND = { BEFORE: "Before", AFTER: "After", WAIVER: "Waiver" } as const;
const OP = { ADD: "Add", REMOVE: "Remove", REPLACE: "Replace" } as const;
const when = (ts: string) => new Date(ts).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" });

/** update-0093 (CHRIS Nov 27): photo changes on past Service log entries. Owners and the GM approve; staff see their own. */
export default async function PhotoChanges() {
  const { supabase, access } = await requireAccess();
  const approver = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const { data, error } = await supabase.rpc("photo_change_list");
  const list = (Array.isArray(data) ? data : []) as Req[];
  const paths = list.flatMap((r) => r.changes.flatMap((c) => [c.thumb ?? c.path, c.old?.thumb ?? c.old?.path, c.path, c.old?.path].filter((x): x is string => !!x)));
  const url: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 200) {
    const { data: s } = await supabase.storage.from("client-photos").createSignedUrls([...new Set(paths)].slice(i, i + 200), 3600);
    for (const x of s ?? []) if (x.path && x.signedUrl) url[x.path] = x.signedUrl;
  }
  const pic = (p: { path?: string; thumb?: string | null } | null | undefined, alt: string) => {
    if (!p?.path) return null;
    const src = (p.thumb && url[p.thumb]) || url[p.path];
    return (
      <a href={url[p.path]} className="folder-photo change-pic">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {src ? <img src={src} alt={alt} loading="lazy" /> : <span className="folder-nothumb">Open photo</span>}
      </a>
    );
  };
  const pending = list.filter((r) => r.state === "PENDING");
  const done = list.filter((r) => r.state !== "PENDING");
  const card = (r: Req) => (
    <div key={r.id} className="card photo-change">
      <div className="photo-change-head">
        <div><strong>{r.client ?? "No client name"}</strong> <span className="muted small">· {[r.service, branchShort(r.branch ?? ""), day(r.date)].filter(Boolean).join(" · ")}</span></div>
        <span className={`pill ${r.state === "APPROVED" ? "PUBLISHED" : r.state === "REJECTED" ? "REVERSED" : "STAGED"}`}>{r.state === "APPROVED" ? "Approved" : r.state === "REJECTED" ? "Not approved" : "Waiting"}</span>
      </div>
      <p className="small"><span className="muted">{r.mine ? "You" : r.by ?? "Staff"} · {when(r.at)}:</span> {r.note}</p>
      <ul className="plain-list change-list">
        {r.changes.map((c, i) => {
          const kind = KIND[(c.old?.kind ?? c.kind ?? "BEFORE") as Ph["kind"]];
          return (
            <li key={i}>
              <span className="small"><b>{OP[c.op]}</b> {kind.toLowerCase()} photo</span>
              <div className="change-pair">
                {c.op !== "ADD" && <figure>{pic(c.old, `Old ${kind} photo`)}<figcaption className="small muted">{c.op === "REMOVE" ? "Removed (goes to Old)" : "Old (goes to Old)"}</figcaption></figure>}
                {c.op !== "REMOVE" && <figure>{pic(c, `New ${kind} photo`)}<figcaption className="small muted">New</figcaption></figure>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="small"><Link href={`/services?date=${r.date}&entry=${r.log}`}>Open the entry</Link></div>
      {r.state === "PENDING" ? <PhotoDecision id={r.id} approver={approver} mine={r.mine} />
        : <p className="small muted">{r.state === "APPROVED" ? "Approved" : "Not approved"}{r.decider ? ` by ${r.decider}` : ""}{r.decided_at ? ` · ${when(r.decided_at)}` : ""}{r.decision_note ? `: ${r.decision_note}` : ""}</p>}
    </div>
  );
  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="small"><Link href="/services">‹ Service log</Link></p>
        <h1>Photo changes</h1>
        <p className="muted small">Changes to the photos of past Service log entries (waivers included). {approver ? "Each one saves only when you or another owner / the GM approves it." : "Yours save once an owner or the GM approves them."} Replaced and removed photos are kept in the client&apos;s folder under Old.</p>
        {error ? <div className="notice error">{error.code === "PGRST202" ? "The owner needs to run update-0093 in Supabase first." : "Could not load. Try again."}</div> : (
          <>
            <h2>Waiting {pending.length ? `(${pending.length})` : ""}</h2>
            {pending.length ? pending.map(card) : <p className="muted">Nothing waiting.</p>}
            {done.length > 0 && <><h2>Last 30 days</h2>{done.map(card)}</>}
          </>
        )}
      </main>
    </>
  );
}
