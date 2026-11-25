import { Uid } from "./Uid";
import { timeLabel } from "@/lib/schedule";
import { IrregularTagForm, IrregularUndo, irregularLabel, type IrregularTag } from "./IrregularForms";

export type DutyRow = {
  employee_id: string; name: string; uid?: string; position: string | null; branch_id: string | null; off: boolean; leave?: string | null;
  start: string | null; end: string | null; note: string | null;
  time_in: string | null; time_out: string | null; in_photo: string | null; in_distance_m: number | null; late_min: number | null;
  irregular?: IrregularTag | null; // update-0044
};
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`);

/** Who's on duty, per branch: scheduled hours, time in (with photo), late minutes, time out.
 *  tagDate: owners and the GM can mark that day irregular, per person or for everyone, so lateness is ignored (update-0044). */
export function OnDutyList({ rows, branches, photos, nowHm, compact, tagDate }: {
  rows: DutyRow[]; branches: { id: string; name: string }[]; photos?: Record<string, string>; nowHm: string; compact?: boolean; tagDate?: string;
}) {
  const wholeDay = rows.find((r) => r.irregular?.whole_day)?.irregular ?? null;
  const working = rows.filter((r) => !r.off);
  const off = rows.filter((r) => r.off);
  const groups = branches.map((b) => ({ ...b, list: working.filter((r) => r.branch_id === b.id) })).filter((g) => g.list.length);
  if (!working.length) return <p className="muted" style={{ margin: 0 }}>Nobody is on the published schedule for today yet.</p>;
  return (
    <>
      {wholeDay ? (
        <div className="notice info small irregular-day">Whole day marked irregular: <strong>{irregularLabel(wholeDay)}</strong>. Lateness today is ignored.
          {tagDate && <> <IrregularUndo id={wholeDay.id} /></>}</div>
      ) : tagDate && <IrregularTagForm date={tagDate} label="Mark the whole day irregular (everyone)" />}
      {groups.map((g) => {
        const inCount = g.list.filter((r) => r.time_in).length;
        return (
          <div key={g.id} className="duty-branch">
            <h3>{g.name}<span className="small muted">{inCount} of {g.list.length} in</span></h3>
            <ul className="plain-list duty-list">
              {g.list.map((r) => {
                const due = r.start && r.start.slice(0, 5) <= nowHm;
                const photo = r.in_photo && photos?.[r.in_photo];
                return (
                  <li key={r.employee_id}>
                    {photo ? <a href={photo} target="_blank" rel="noreferrer"><img className="duty-photo" src={photo} alt={`${r.name} time-in photo`} /></a>
                      : <span className="duty-photo none">{r.time_in ? "" : "–"}</span>}
                    <span><strong>{r.name}</strong><Uid v={r.uid} />
                      <span className="small muted"> · {r.start ? `${timeLabel(r.start)}–${timeLabel(r.end)}` : r.note}</span>
                      {!compact && r.in_distance_m != null && r.in_distance_m > 300 && <span className="small late"> · {r.in_distance_m >= 1000 ? `${(r.in_distance_m / 1000).toFixed(1)} km` : `${r.in_distance_m} m`} from branch</span>}
                    </span>
                    <span className="small" style={{ textAlign: "right" }}>
                      {r.time_in ? <>In {clock(r.time_in)}{r.irregular ? null : r.late_min ? <span className="late"> · {mins(r.late_min)} late</span> : r.start ? <span className="on-time"> · on time</span> : null}</>
                        : due ? <span className="late">Not in yet</span> : <span className="muted">Not in yet</span>}
                      {r.irregular && !r.irregular.whole_day && <><br /><span className="muted">Irregular: {irregularLabel(r.irregular)}</span>{tagDate && <> <IrregularUndo id={r.irregular.id} /></>}</>}
                      {tagDate && !r.irregular && r.time_in && r.start && <IrregularTagForm date={tagDate} employee={r.employee_id} label={r.late_min ? "Ignore this late (irregular)" : "Mark irregular"} />}
                      {r.time_out && <><br /><span className="muted">Out {clock(r.time_out)}</span></>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {off.some((r) => !r.leave) && <p className="small muted" style={{ margin: 0 }}>Day off: {off.filter((r) => !r.leave).map((r) => r.name).join(", ")}</p>}
      {off.some((r) => r.leave) && <p className="small" style={{ margin: "4px 0 0" }}><span className="late">On leave:</span> {off.filter((r) => r.leave).map((r) => `${r.name} (${r.leave === "ABSENT" ? "Absent" : r.leave})`).join(", ")}</p>}
    </>
  );
}
