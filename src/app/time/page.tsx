import Link from "next/link";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { OnDutyList, type DutyRow } from "@/components/OnDuty";
import { manilaToday } from "@/lib/dates";
import { cutoffEnd, dayLabel } from "@/lib/homeGlance";
import { branchShort, timeLabel } from "@/lib/schedule";
import { BranchLocation, TimeClock } from "./Clock";

type Punch = { kind: "IN" | "OUT"; punched_at: string; branch_id: string };
type Att = { employee_id: string; name: string; scheduled: number; present: number; absent: number; late_days: number; late_min: number };
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const nowHm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Manila" });

export default async function TimePage() {
  const { supabase, access, branches } = await requireAccess();
  const today = manilaToday();
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const short = clinics.map((b) => ({ id: b.id, name: branchShort(b.name) }));
  const manager = can(access, ["OWNER", "MANAGER"], null) || access.grants.some((g) => g.role === "MANAGER");
  const cutStart = Number(today.slice(8)) <= 15 ? `${today.slice(0, 7)}-01` : `${today.slice(0, 7)}-16`;

  const { data: me } = await supabase.from("employees").select("id, branch_id").eq("app_user_id", access.user_id).eq("active", true).order("created_at").limit(1).maybeSingle();
  const [{ data: shift }, { data: punches, error: punchErr }, duty, att, { data: locs }] = await Promise.all([
    me ? supabase.from("shifts").select("is_off, branch_id, start_time, end_time").eq("employee_id", me.id).eq("work_date", today).eq("state", "PUBLISHED").maybeSingle() : Promise.resolve({ data: null }),
    me ? supabase.from("time_punches").select("kind, punched_at, branch_id").eq("employee_id", me.id).eq("work_date", today).order("punched_at") : Promise.resolve({ data: [], error: null }),
    manager ? supabase.rpc("on_duty", { p_date: today }) : Promise.resolve({ data: [] }),
    manager ? supabase.rpc("attendance", { p_start: cutStart, p_end: cutoffEnd(today) }) : Promise.resolve({ data: [] }),
    manager ? supabase.from("branches").select("id, lat").eq("kind", "CLINIC") : Promise.resolve({ data: [] }),
  ]);
  if (punchErr) {
    return (<><TopBar access={access} /><main><h1>Time clock</h1><div className="notice info">The owner needs to run update-0022 in Supabase first.</div></main></>);
  }
  const mine = (punches ?? []) as Punch[];
  const isIn = mine.at(-1)?.kind === "IN";
  const firstIn = mine.find((p) => p.kind === "IN");
  const defaultBranch = isIn ? mine.at(-1)!.branch_id : shift?.branch_id ?? me?.branch_id ?? clinics[0]?.id ?? "";
  const start = shift?.start_time?.slice(0, 5);
  const status = !me ? "" : isIn ? `You're in since ${clock(mine.filter((p) => p.kind === "IN").at(-1)!.punched_at)}.`
    : firstIn ? "You're timed out." : shift?.is_off ? "You're on a day off today." : start ? `Today: ${branchShort(clinics.find((b) => b.id === shift?.branch_id)?.name ?? "")}, ${timeLabel(start)} – ${timeLabel(shift?.end_time)}.`
    : "You're not on today's published schedule.";

  const rows = (Array.isArray(duty.data) ? duty.data : []) as DutyRow[];
  const paths = rows.map((r) => r.in_photo).filter((p): p is string => !!p);
  const { data: signed } = paths.length ? await supabase.storage.from("timeclock").createSignedUrls(paths, 3600) : { data: [] };
  const photos: Record<string, string> = Object.fromEntries((signed ?? []).filter((s) => s.signedUrl && s.path).map((s) => [s.path!, s.signedUrl as string]));
  const attendance = (Array.isArray(att.data) ? att.data : []) as Att[];
  const locSet = new Set(((locs ?? []) as { id: string; lat: number | null }[]).filter((b) => b.lat != null).map((b) => b.id));
  const myBranches = short.filter((b) => can(access, ["OWNER", "MANAGER"], b.id)).map((b) => ({ ...b, set: locSet.has(b.id) }));

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Time clock</h1>
        <p className="muted small">Time in when you arrive and time out when you leave by taking a photo of the clinic clock. No more posting it in the group chat.</p>

        {me ? (
          <TimeClock userId={access.user_id} isIn={isIn} branches={short} defaultBranch={defaultBranch} status={status} />
        ) : (
          <div className="notice info">Your login isn&apos;t linked to an employee record yet, so you can&apos;t time in. Ask the owner to link it on the Employees page.</div>
        )}

        {mine.length > 0 && (
          <div className="card">
            <h2>Today</h2>
            <ul className="plain-list punch-list">
              {mine.map((p) => <li key={p.punched_at}><span>{p.kind === "IN" ? "Time in" : "Time out"} · {short.find((b) => b.id === p.branch_id)?.name}</span><strong>{clock(p.punched_at)}</strong></li>)}
            </ul>
            {firstIn && start && (() => {
              const late = Math.max(0, Math.floor((Date.parse(firstIn.punched_at) - Date.parse(`${today}T${start}:00+08:00`)) / 60000));
              return <p className="small" style={{ margin: 0 }}>{late > 0 ? <span className="late">{late} min after your {timeLabel(start)} start</span> : <span className="on-time">On time for your {timeLabel(start)} start</span>}</p>;
            })()}
          </div>
        )}

        {manager && (
          <>
            <div className="card">
              <div className="card-head"><h2>On duty today, {dayLabel(today)}</h2><Link className="small" href="/schedule">Schedule →</Link></div>
              <OnDutyList rows={rows} branches={short} photos={photos} nowHm={nowHm()} />
            </div>

            <div className="card">
              <h2>Lateness this cutoff</h2>
              <p className="small muted">{dayLabel(cutStart)} to {dayLabel(cutoffEnd(today))}, from the published schedule and time-ins.</p>
              {attendance.length === 0 ? <p className="muted" style={{ margin: 0 }}>No published schedule in this cutoff yet.</p> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Staff</th><th>Scheduled</th><th>Timed in</th><th>No time-in</th><th>Late days</th><th>Late total</th></tr></thead>
                    <tbody>
                      {attendance.map((a) => (
                        <tr key={a.employee_id}>
                          <td>{a.name}</td><td>{a.scheduled}</td><td>{a.present}</td>
                          <td className={a.absent ? "late" : ""}>{a.absent}</td>
                          <td className={a.late_days ? "late" : ""}>{a.late_days}</td>
                          <td>{a.late_min ? `${a.late_min} min` : "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {myBranches.length > 0 && (
              <div className="card">
                <h2>Branch locations</h2>
                <p className="small muted">Save each clinic&apos;s location once. Time-ins more than 300 m away get flagged on On Duty.</p>
                <BranchLocation branches={myBranches} />
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
