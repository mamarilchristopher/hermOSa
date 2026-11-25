import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { addDays } from "@/lib/insights";
import { dayLabel } from "@/lib/homeGlance";
import { branchShort } from "@/lib/schedule";
import { photoGapMinutes } from "@/lib/exif";
import { Uid } from "@/components/Uid";

type Row = { id: string; kind: "IN" | "OUT"; punched_at: string; photo_taken_at: string | null; photo_path: string | null; distance_m: number | null;
  branch_id: string; employee_id: string; employees: { full_name: string; uid: string } | null };
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const when = (ts: string, day: string) => {
  const d = new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  return d === day ? clock(ts) : `${dayLabel(d)}, ${clock(ts)}`;
};
const OLD_MIN = 5;

/** Owners and managers: every time-in / out photo for a day, with the server time, the photo's own time and flags. */
export default async function TimePhotosPage({ searchParams }: { searchParams: Promise<{ date?: string; branch?: string; who?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const manager = can(access, ["OWNER", "MANAGER"], null) || access.grants.some((g) => g.role === "MANAGER");
  if (!manager) redirect("/time");
  const sp = await searchParams;
  const today = manilaToday();
  const day = isIsoDate(sp.date) && sp.date <= today ? sp.date : today;
  const clinics = branches.filter((b) => b.kind === "CLINIC" || b.kind === "WFH").map((b) => ({ id: b.id, name: branchShort(b.name) }));
  const branch = clinics.some((b) => b.id === sp.branch) ? sp.branch! : "";

  let q = supabase.from("time_punches").select("id, kind, punched_at, photo_taken_at, photo_path, distance_m, branch_id, employee_id, employees(full_name, uid)")
    .eq("work_date", day).order("punched_at");
  if (branch) q = q.eq("branch_id", branch);
  const { data, error } = await q;
  const all = ((data ?? []) as unknown as Row[]);
  const people = [...new Map(all.map((r) => [r.employee_id, r.employees?.full_name ?? "Staff"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const rows = sp.who ? all.filter((r) => r.employee_id === sp.who) : all;
  const paths = rows.map((r) => r.photo_path).filter((p): p is string => !!p);
  const [{ data: view }, { data: save }] = paths.length
    ? await Promise.all([supabase.storage.from("timeclock").createSignedUrls(paths, 3600), supabase.storage.from("timeclock").createSignedUrls(paths, 3600, { download: true })])
    : [{ data: [] }, { data: [] }];
  const url = (list: typeof view) => Object.fromEntries((list ?? []).filter((s) => s.signedUrl && s.path).map((s) => [s.path!, s.signedUrl as string]));
  const views = url(view), saves = url(save);
  const link = (d: string, b = branch, w = sp.who ?? "") => `/time/photos?date=${d}${b ? `&branch=${b}` : ""}${w ? `&who=${w}` : ""}`;
  const flagged = rows.filter((r) => { const g = photoGapMinutes(r.punched_at, r.photo_taken_at); return (g != null && g > OLD_MIN) || (r.distance_m ?? 0) > 300; }).length;

  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="small"><Link href="/time">← Time clock</Link></p>
        <h1>Time-in photos</h1>
        <p className="muted small">The server time is the official time. &ldquo;Photo taken&rdquo; is the time saved inside the photo by the staff member&apos;s phone; more than {OLD_MIN} minutes apart is flagged as an old photo.</p>

        <div className="card">
          <div className="sched-nav">
            <Link className="nav-arrow" href={link(addDays(day, -1))} aria-label="Previous day">‹</Link>
            <div className="week-title"><strong>{dayLabel(day)}</strong>
              <span className="small muted">{day === today ? "Today" : <Link href={link(today)}>Go to today</Link>}</span></div>
            {day < today ? <Link className="nav-arrow" href={link(addDays(day, 1))} aria-label="Next day">›</Link> : <span className="nav-arrow" aria-hidden />}
          </div>
          <form className="field-grid" method="get" style={{ marginTop: 12 }}>
            <input type="hidden" name="date" value={day} />
            <label className="field half">Branch
              <select name="branch" defaultValue={branch}>
                <option value="">All branches</option>
                {clinics.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></label>
            <label className="field half">Person
              <select name="who" defaultValue={sp.who ?? ""}>
                <option value="">Everyone</option>
                {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
            <div className="field row-buttons"><button className="small" type="submit">Show</button></div>
          </form>
        </div>

        {error ? <div className="notice error">Could not load the photos. Try again.</div>
          : rows.length === 0 ? <p className="muted">No time-ins on this day.</p> : (
          <>
            <p className="small muted">{rows.length} photo{rows.length === 1 ? "" : "s"}{flagged ? `, ${flagged} flagged` : ""}.</p>
            <ul className="plain-list photo-grid">
              {rows.map((r) => {
                const gap = photoGapMinutes(r.punched_at, r.photo_taken_at);
                const far = (r.distance_m ?? 0) > 300;
                const src = r.photo_path ? views[r.photo_path] : undefined;
                return (
                  <li key={r.id} className="photo-card">
                    {src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={`${r.employees?.full_name ?? "Staff"} ${r.kind === "IN" ? "time-in" : "time-out"} photo`} /></a>
                      : <div className="photo-missing small muted">No photo</div>}
                    <div className="photo-meta">
                      <strong>{r.employees?.full_name ?? "Staff"}</strong><Uid v={r.employees?.uid} />
                      <span className="small">{r.kind === "IN" ? "Time in" : "Time out"} · {clinics.find((b) => b.id === r.branch_id)?.name ?? ""}</span>
                      <span className="small">Server time <strong>{clock(r.punched_at)}</strong></span>
                      <span className="small muted">{r.photo_taken_at ? `Photo taken ${when(r.photo_taken_at, day)}` : "Photo has no time saved"}</span>
                      {gap != null && gap > OLD_MIN && <span className="pill STAGED">Old photo, {gap >= 120 ? `${Math.round(gap / 60)} h` : `${gap} min`} off</span>}
                      {far && <span className="pill STAGED">{r.distance_m! >= 1000 ? `${(r.distance_m! / 1000).toFixed(1)} km` : `${r.distance_m} m`} from branch</span>}
                      {r.photo_path && saves[r.photo_path] && <a className="small" href={saves[r.photo_path]}>Download photo</a>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
