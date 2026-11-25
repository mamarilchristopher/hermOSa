import { Avatar } from "./Avatar";
import type { DutyRow } from "./OnDuty";

export type DutyFace = { short: string; photo: string | null };
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const lateText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

/** On duty, the neat Home view (CHRIS Nov 25): per branch, a face per person with one short status line. Details live on Time clock. */
export function OnDutyFaces({ rows, faces, branches, nowHm }: {
  rows: DutyRow[]; faces: Record<string, DutyFace>; branches: { id: string; name: string }[]; nowHm: string;
}) {
  const working = rows.filter((r) => !r.off);
  if (!working.length) return <p className="muted" style={{ margin: 0 }}>Nobody is on the published schedule for today yet.</p>;
  const name = (r: DutyRow) => faces[r.employee_id]?.short ?? r.name.split(" ")[0];
  const groups = branches.map((b) => ({ ...b, list: working.filter((r) => r.branch_id === b.id) })).filter((g) => g.list.length);
  const off = rows.filter((r) => r.off && !r.leave), leave = rows.filter((r) => r.off && r.leave);
  return (
    <>
      <div className="faces-branches">
        {groups.map((g) => (
          <div key={g.id} className="faces-branch">
            <div className="faces-head"><strong>{g.name}</strong><span className="small muted">{g.list.filter((r) => r.time_in).length}/{g.list.length} in</span></div>
            <div className="faces-row">
              {g.list.map((r) => {
                const late = !r.irregular && r.late_min ? r.late_min : 0;
                const state = r.time_out ? "out" : r.time_in ? (late ? "late" : "in") : r.start && r.start.slice(0, 5) <= nowHm ? "missing" : "waiting";
                return (
                  <div key={r.employee_id} className={`face is-${state}`} title={r.name}>
                    <Avatar name={r.name} url={faces[r.employee_id]?.photo} size={52} />
                    <span className="face-name">{name(r)}</span>
                    <span className="face-status">
                      {state === "missing" ? "Not in" : state === "waiting" ? "Not in yet"
                        : state === "out" ? `Out ${clock(r.time_out!)}` : `In ${clock(r.time_in!)}`}
                    </span>
                    {late > 0 && <span className="face-late">{lateText(late)} late</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {(off.length > 0 || leave.length > 0) && (
        <p className="small muted" style={{ margin: "10px 0 0" }}>
          {off.length > 0 && <>Day off: {off.map(name).join(", ")}</>}
          {off.length > 0 && leave.length > 0 && " · "}
          {leave.length > 0 && <>On leave: {leave.map((r) => `${name(r)} (${r.leave === "ABSENT" ? "Absent" : r.leave})`).join(", ")}</>}
        </p>
      )}
    </>
  );
}
