import { Avatar } from "./Avatar";
import type { DutyRow } from "./OnDuty";
import { IrregularTagForm, IrregularUndo, irregularLabel } from "./IrregularForms";

export type DutyFace = { short: string; photo: string | null };
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const lateText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

/** On duty, the neat view (CHRIS Nov 25): per branch, a face per person with a short status.
 *  On the Time clock page it also links each time-in photo and, for owners and the GM (tagDate), marks irregular days. */
export function OnDutyFaces({ rows, faces, branches, nowHm, photos, tagDate }: {
  rows: DutyRow[]; faces: Record<string, DutyFace>; branches: { id: string; name: string }[]; nowHm: string;
  photos?: Record<string, string>; tagDate?: string;
}) {
  const wholeDay = rows.find((r) => r.irregular?.whole_day)?.irregular ?? null;
  const working = rows.filter((r) => !r.off);
  if (!working.length) return <p className="muted" style={{ margin: 0 }}>Nobody is on the published schedule for today yet.</p>;
  const name = (r: DutyRow) => faces[r.employee_id]?.short ?? r.name.split(" ")[0];
  const groups = branches.map((b) => ({ ...b, list: working.filter((r) => r.branch_id === b.id) })).filter((g) => g.list.length);
  const off = rows.filter((r) => r.off && !r.leave), leave = rows.filter((r) => r.off && r.leave);
  return (
    <>
      {wholeDay ? (
        <div className="notice info small irregular-day">Whole day marked irregular: <strong>{irregularLabel(wholeDay)}</strong>. Lateness today is ignored.
          {tagDate && <> <IrregularUndo id={wholeDay.id} /></>}</div>
      ) : tagDate && <div className="irregular-day"><IrregularTagForm date={tagDate} label="Mark the whole day irregular (everyone)" /></div>}
      <div className="faces-branches">
        {groups.map((g) => (
          <div key={g.id} className="faces-branch">
            <div className="faces-head"><strong>{g.name}</strong><span className="small muted">{g.list.filter((r) => r.time_in && !r.time_out).length} on duty{g.list.some((r) => r.time_out) ? ` · ${g.list.filter((r) => r.time_out).length} done` : ""}</span></div>
            <div className="faces-row">
              {g.list.map((r) => {
                const late = !r.irregular && r.late_min ? r.late_min : 0;
                const state = r.time_out ? "out" : r.time_in ? (late ? "late" : "in") : r.start && r.start.slice(0, 5) <= nowHm ? "missing" : "waiting";
                return (
                  <div key={r.employee_id} className={`face is-${state}`} title={r.name}>
                    <Avatar name={r.name} url={faces[r.employee_id]?.photo} size={52} />
                    <span className="face-name">{name(r)}</span>
                    {/* CHRIS Nov 25: show whether the shift is still going or over. */}
                    <span className={`face-shift ${state === "out" ? "over" : r.time_in ? "going" : ""}`}>
                      {state === "missing" ? "Not in" : state === "waiting" ? "Not in yet" : state === "out" ? "Duty over" : "On duty"}
                    </span>
                    {r.time_in && <span className="face-status">{state === "out" ? `${clock(r.time_in)} – ${clock(r.time_out!)}` : `Since ${clock(r.time_in)}`}</span>}
                    {late > 0 && <span className="face-late">{lateText(late)} late</span>}
                    {r.irregular && !r.irregular.whole_day && <span className="face-status">Irregular: {irregularLabel(r.irregular)}{tagDate && <> <IrregularUndo id={r.irregular.id} /></>}</span>}
                    {r.in_distance_m != null && r.in_distance_m > 300 && photos && <span className="face-late">{r.in_distance_m >= 1000 ? `${(r.in_distance_m / 1000).toFixed(1)} km` : `${r.in_distance_m} m`} away</span>}
                    {photos && r.in_photo && photos[r.in_photo] && <a className="face-link" href={photos[r.in_photo]} target="_blank" rel="noreferrer">Time-in photo</a>}
                    {tagDate && !r.irregular && r.time_in && r.start && late > 0 && <IrregularTagForm date={tagDate} employee={r.employee_id} label="Ignore late" />}
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
