// Client photo folders (update-0053), shared by the Client archive and Social media tabs. Server component.
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { dayLabel } from "@/lib/homeGlance";
import { branchShort } from "@/lib/schedule";
import { ShareToggle } from "./ShareToggle";

type Photo = { id: string; kind: "WAIVER" | "BEFORE" | "AFTER"; path: string; thumb: string | null };
type Visit = { id: string; date: string; client: string; service: string | null; branch_id: string; branch: string | null; lead: string | null;
  assist: string | null; type: string; kind: string; share_ok: boolean; state: string; photos: Photo[] };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shiftMonth = (m: string, by: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const KIND_TEXT = { BEFORE: "Before", AFTER: "After", WAIVER: "Waiver" } as const;

export async function PhotoFolders({ social, searchParams }: { social: boolean; searchParams: Promise<{ month?: string; branch?: string; q?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const owner = can(access, ["OWNER"], null), gm = can(access, ["MANAGER"], null);
  const allowed = social
    ? owner || gm || access.grants.some((g) => g.role === "MARKETING" || g.role === "CSR")
    : access.grants.some((g) => ["OWNER", "MANAGER", "CLINICIAN", "CASHIER"].includes(g.role));
  if (!allowed) redirect("/");
  const sp = await searchParams;
  const thisMonth = manilaToday().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  const clinics = branches.filter((b) => b.kind === "CLINIC").filter((b) => social || owner || gm || can(access, ["MANAGER", "CLINICIAN", "CASHIER"], b.id));
  const branch = clinics.find((b) => b.id === sp.branch)?.id ?? null;
  const q = (sp.q ?? "").trim().toLowerCase().slice(0, 60);

  const { data, error } = await supabase.rpc("client_photo_folders", { p_month: `${month}-01`, p_branch: branch, p_social: social });
  const all = (Array.isArray(data) ? data : []) as Visit[];
  const visits = q ? all.filter((v) => `${v.client} ${v.service ?? ""}`.toLowerCase().includes(q)) : all;

  // Signed links: the small preview for the grid, the untouched original to open, and a download copy.
  const files = visits.flatMap((v) => v.photos.flatMap((p) => [p.path, p.thumb].filter((x): x is string => !!x)));
  const originals = visits.flatMap((v) => v.photos.map((p) => p.path));
  const sign = async (paths: string[], download: boolean) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < paths.length; i += 200) {
      const { data: s } = await supabase.storage.from("client-photos").createSignedUrls(paths.slice(i, i + 200), 3600, download ? { download: true } : undefined);
      for (const x of s ?? []) if (x.path && x.signedUrl) out[x.path] = x.signedUrl;
    }
    return out;
  };
  const [view, save] = files.length ? await Promise.all([sign(files, false), sign(originals, true)]) : [{}, {}];

  const days = [...new Set(visits.map((v) => v.date))];
  const base = social ? "/clinic/social" : "/clinic/archive";
  const link = (m: string) => `${base}?month=${m}${branch ? `&branch=${branch}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const canShare = owner || gm;
  const label = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>{social ? "Social media" : "Client archive"}</h1>
        <p className="muted small">
          {social
            ? "Before and after photos of clients who allowed sharing. Tap a photo to open the full-quality original. Waivers are never shown here."
            : "Every client's waiver and before/after photos from the service log, by month and day. Tap a photo to open the full-quality original."}
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

        {error ? <div className="notice error">{error.code === "PGRST202" ? "The owner needs to run update-0053 in Supabase first." : "Could not load the photos. Try again."}</div>
          : visits.length === 0 ? <p className="muted">{social ? "No shared client photos" : "No client photos"} in {label}{q ? " for that search" : ""}.</p> : (
          <>
            <p className="small muted">{visits.length} client folder{visits.length === 1 ? "" : "s"} in {label}.</p>
            {days.map((d) => (
              <section key={d} className="folder-day">
                <h2>{dayLabel(d)}</h2>
                <div className="client-folders">
                  {visits.filter((v) => v.date === d).map((v) => {
                    const groups = ([["Before and after", ["BEFORE", "AFTER"]], ["Waiver", ["WAIVER"]]] as const)
                      .map(([t, ks]) => [t, v.photos.filter((p) => (ks as readonly string[]).includes(p.kind))] as const).filter(([, l]) => l.length);
                    return (
                      <details key={v.id} className="client-folder" id={v.id}>
                        <summary>
                          <span className="folder-icon" aria-hidden>📁</span>
                          <span className="folder-main">
                            <strong>{v.client}</strong>
                            <span className="small muted">{[v.service, branchShort(v.branch ?? "")].filter(Boolean).join(" · ")}</span>
                            <span className="small muted">{v.lead ? `Lead ${v.lead}` : ""}{v.assist ? ` · Assist ${v.assist}` : ""}</span>
                          </span>
                          <span className="folder-side small muted">{v.photos.length} photo{v.photos.length === 1 ? "" : "s"}
                            {!social && v.share_ok && <span className="pill PUBLISHED">Sharing OK</span>}</span>
                        </summary>
                        {groups.map(([k, list]) => (
                          <div key={k} className="folder-group">
                            <span className="field-label">{k}</span>
                            <ul className="plain-list folder-photos">
                              {list.map((p) => {
                                const src = p.thumb ? view[p.thumb] : /\.hei[cf]$/i.test(p.path) ? undefined : view[p.path];
                                return (
                                  <li key={p.id}>
                                    <a href={view[p.path]} target="_blank" rel="noreferrer" className="folder-photo">
                                      {src ? <img src={src} alt={`${KIND_TEXT[p.kind]} photo of ${v.client}`} loading="lazy" />
                                        : <span className="folder-nothumb">Open photo</span>}
                                    </a>
                                    <span className="small"><span className="muted">{KIND_TEXT[p.kind]}</span>{save[p.path] && <> · <a href={save[p.path]}>Download</a></>}</span>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ))}
                        {canShare && (
                          <div className="folder-foot">
                            <ShareToggle id={v.id} on={v.share_ok} />
                            <Link className="small" href={`/services?date=${v.date}`}>Service log</Link>
                          </div>
                        )}
                      </details>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}
