"use client";
import { pick } from "@/lib/decision";
import { useActionState, useEffect, useRef, useState } from "react";
import { saveRules, suggestWeekAction } from "./actions";
import type { Rules } from "@/lib/scheduleAuto";
import { cancelRequest, copyLastWeek, decideRequest, respondSwap, generateWeek, publishWeek, requestChange, saveDay, saveShift, savePattern, type ActionState } from "./actions";
import { DOW, LEAVE_TEXT, shortDate, shortNames, timeLabel } from "@/lib/schedule";
import type { Person, Shift } from "./page";

type B = { id: string; name: string };
const wd = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

function Msg({ s }: { s: ActionState }) {
  if (s?.error) return <div className="notice error">{s.error}</div>;
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return null;
}

/** Hours from 7 AM to 10 PM on the half hour, for the shift pickers. */
const HOURS = Array.from({ length: 31 }, (_, i) => { const m = 7 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
function HourSelect({ name, value, onChange }: { name: string; value: string; onChange: (v: string) => void }) {
  return <select name={name} value={value} onChange={(e) => onChange(e.target.value)}>{HOURS.map((h) => <option key={h} value={h}>{timeLabel(h)}</option>)}</select>;
}

export function WeekButtons({ monday, drafts, empty }: { monday: string; drafts: number; empty: boolean }) {
  const [g, gen, genBusy] = useActionState(generateWeek, undefined);
  const [p, pub, pubBusy] = useActionState(publishWeek, undefined);
  const [c, copy, copyBusy] = useActionState(copyLastWeek, undefined);
  const [sg, sug, sugBusy] = useActionState(suggestWeekAction, undefined);
  const last = [g, p, c, sg].filter((x) => x?.at).sort((a, b) => b!.at! - a!.at!)[0];
  return (
    <div className="sched-foot">
      <Msg s={last} />
      <div className="sched-actions">
        <form action={sug} onSubmit={(e) => { if (drafts > 0 && !confirm("Suggest a new plan? Unpublished days will be replaced. Published days and leave are kept.")) e.preventDefault(); }}>
          <input type="hidden" name="monday" value={monday} />
          <input type="hidden" name="seed" value={sg?.at ?? ""} />
          <button className="suggest" disabled={sugBusy}>{sugBusy ? "Planning…" : sg?.ok ? "Suggest again" : "Suggest a week"}</button></form>
        <span className="small muted">{empty ? "or start from:" : "or fill empty days from:"}</span>
        <form action={copy}><input type="hidden" name="monday" value={monday} />
          <button className="secondary small" disabled={copyBusy}>{copyBusy ? "Copying…" : "Copy last week"}</button></form>
        <form action={gen}><input type="hidden" name="monday" value={monday} />
          <button className="secondary small" disabled={genBusy}>{genBusy ? "Filling…" : "Use usual schedules"}</button></form>
        {drafts > 0 && (
          <form action={pub} className="publish" onSubmit={(e) => { if (!confirm("Publish this week? Staff will see it and get a notice.")) e.preventDefault(); }}>
            <input type="hidden" name="monday" value={monday} />
            <button disabled={pubBusy}>{pubBusy ? "Publishing…" : `Publish week`}</button></form>
        )}
      </div>
    </div>
  );
}

/** The week: one row per person, one column per day. Schedulers tap a day to change it. */
export function WeekGrid({ dates, today, people, shifts, branches, me }: { dates: string[]; today: string; people: Person[]; shifts: Shift[]; branches: B[]; me: string | null }) {
  const [edit, setEdit] = useState<{ p: Person; d: string } | null>(null);
  const at = new Map(shifts.map((s) => [`${s.employee_id}|${s.date}`, s]));
  const bname = (id: string | null) => branches.find((b) => b.id === id)?.name ?? "";
  // Group by home branch in the owner's branch order; people without one go last.
  const groups = [...branches.map((b) => ({ id: b.id, name: b.name, list: people.filter((p) => p.branch_id === b.id) })),
    { id: "", name: "Other", list: people.filter((p) => !branches.some((b) => b.id === p.branch_id)) }].filter((g) => g.list.length);
  const count = (d: string, b: string) => shifts.filter((s) => s.date === d && !s.off && s.branch_id === b).length;
  return (
    <>
      <div className="table-wrap week-grid">
        <table>
          <thead>
            <tr><th>Staff</th>{dates.map((d) => <th key={d} className={d === today ? "today" : ""}>{DOW[wd(d)]}<span className="small muted"> {Number(d.slice(8))}</span></th>)}</tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <FragmentRows key={g.id || "other"}>
                <tr className="group-row"><td>{g.name}</td>{dates.map((d) => <td key={d} className="small muted">{g.id ? `${count(d, g.id)} on duty` : ""}</td>)}</tr>
                {g.list.map((p) => (
                  <tr key={p.id} className={p.id === me ? "me-row" : ""}>
                    <th scope="row"><span className="who">{p.name}</span>{p.position && <span className="small muted">{p.position}</span>}</th>
                    {dates.map((d) => {
                      const s = at.get(`${p.id}|${d}`);
                      const away = s && !s.off && s.branch_id !== p.branch_id;
                      const body = !s ? <span className="muted">–</span> : s.off ? <span className="off">{s.leave ? LEAVE_TEXT[s.leave] : "Off"}</span> : (
                        <><span className={away ? "away" : ""}>{bname(s.branch_id)}</span><span className="small muted">{timeLabel(s.start)}–{timeLabel(s.end)}</span></>
                      );
                      return (
                        <td key={d} className={`${s?.state === "DRAFT" ? "draft" : ""} ${d === today ? "today" : ""}`} title={s?.note ?? undefined}>
                          {p.can_edit ? <button type="button" className="cell-btn" onClick={() => setEdit({ p, d })}>{body}{s?.note && <span className="dot" />}</button> : <div className="cell">{body}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </FragmentRows>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted legend"><span className="key draft" /> not published yet · <span className="away">Branch</span> = working away from home branch{people.some((p) => p.can_edit) && " · tap a day to change it"}</p>
      {edit && <ShiftEditor key={`${edit.p.id}|${edit.d}`} person={edit.p} date={edit.d} shift={at.get(`${edit.p.id}|${edit.d}`)} branches={branches} onClose={() => setEdit(null)} />}
    </>
  );
}
function FragmentRows({ children }: { children: React.ReactNode }) { return <>{children}</>; }

function ShiftEditor({ person, date, shift, branches, onClose }: { person: Person; date: string; shift?: Shift; branches: B[]; onClose: () => void }) {
  const [state, action, pending] = useActionState(saveShift, undefined);
  const ref = useRef<HTMLDialogElement>(null);
  const [off, setOff] = useState(shift?.off ?? false);
  const [branch, setBranch] = useState(shift?.branch_id ?? person.pattern?.branch_id ?? person.branch_id ?? "");
  const [start, setStart] = useState(shift?.start ?? person.pattern?.start ?? "10:00");
  const [end, setEnd] = useState(shift?.end ?? person.pattern?.end ?? "19:00");
  const [note, setNote] = useState(shift?.note ?? "");
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => { if (state?.ok) onClose(); }, [state, onClose]);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose}>
      <form action={action} className="field-grid">
        <h2 className="field">{person.name} · {DOW[wd(date)]}, {shortDate(date)}</h2>
        {shift?.state === "PUBLISHED" && <p className="field small muted" style={{ margin: 0 }}>This day is published. {person.name.split(" ")[0]} gets a notice when you save.</p>}
        <Msg s={state} />
        <input type="hidden" name="employee" value={person.id} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="off" value={off ? "1" : "0"} />
        <div className="field">
          <div className="segmented choice" role="radiogroup">
            <button type="button" className={!off ? "on" : ""} onClick={() => setOff(false)}>Working</button>
            <button type="button" className={off ? "on" : ""} onClick={() => setOff(true)}>Day off</button>
          </div>
        </div>
        {!off && (
          <>
            <label className="field">Branch
              <select name="branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">Choose…</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="field half">From <HourSelect name="start" value={start} onChange={setStart} /></label>
            <label className="field half">To <HourSelect name="end" value={end} onChange={setEnd} /></label>
          </>
        )}
        <label className="field">Note (optional)<input name="note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Cover for Marikina" /></label>
        <div className="field row-buttons">
          <button disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

export function PatternForm({ employee, pattern, homeBranch, branches }: { employee: string; pattern: Person["pattern"]; homeBranch: string | null; branches: B[] }) {
  const [state, action, pending] = useActionState(savePattern, undefined);
  const [branch, setBranch] = useState(pattern?.branch_id ?? homeBranch ?? "");
  const [days, setDays] = useState<number[]>(pattern?.days_off ?? []);
  const [start, setStart] = useState(pattern?.start ?? "10:00");
  const [end, setEnd] = useState(pattern?.end ?? "19:00");
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <form action={action} className="pattern-form">
      <input type="hidden" name="employee" value={employee} />
      {days.map((d) => <input key={d} type="hidden" name="off" value={d} />)}
      <select name="branch" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Home branch">
        <option value="">Branch…</option>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <div className="days-off" role="group" aria-label="Days off">
        {order.map((d) => (
          <button type="button" key={d} className={days.includes(d) ? "on" : ""} aria-pressed={days.includes(d)}
            onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>{DOW[d].slice(0, 2)}</button>
        ))}
      </div>
      <span className="hours"><HourSelect name="start" value={start} onChange={setStart} /> – <HourSelect name="end" value={end} onChange={setEnd} /></span>
      <button className="secondary small" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      {state?.error ? <span className="field-error">{state.error}</span> : state?.ok ? <span className="small ok-text">Saved</span> : null}
    </form>
  );
}

type Day = { date: string; label: string };
export function RequestForm({ workDays, offDays, others }: { workDays: Day[]; offDays: Day[]; others: { id: string; name: string; days: Record<string, string> }[] }) {
  const [state, action, pending] = useActionState(requestChange, undefined);
  const [kind, setKind] = useState<"SWAP" | "TRADE" | "DAY_OFF">(offDays.length && workDays.length ? "TRADE" : workDays.length ? "SWAP" : "DAY_OFF");
  const [date, setDate] = useState("");
  const [other, setOther] = useState("");
  const [otherDate, setOtherDate] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => { if (state?.ok) { setDate(""); setOther(""); setOtherDate(""); setReason(""); } }, [state]);
  const pick = (k: typeof kind) => { setKind(k); setDate(""); setOther(""); setOtherDate(""); };
  const working = (o: { days: Record<string, string> }, d: string) => !!o.days[d] && o.days[d] !== "Off";
  const coworker = others.find((o) => o.id === other);
  return (
    <form action={action} className="field-grid">
      <Msg s={state} />
      <input type="hidden" name="kind" value={kind} />
      <div className="field">
        <div className="segmented choice" role="radiogroup" aria-label="What do you need?">
          <button type="button" className={kind === "TRADE" ? "on" : ""} onClick={() => pick("TRADE")}>Trade days off with someone</button>
          <button type="button" className={kind === "SWAP" ? "on" : ""} onClick={() => pick("SWAP")}>Swap one day with someone</button>
          <button type="button" className={kind === "DAY_OFF" ? "on" : ""} onClick={() => pick("DAY_OFF")}>Move my day off</button>
        </div>
      </div>
      {kind === "TRADE" ? (
        <>
          <label className="field half">My day off (I&apos;ll work it)
            <select name="date" value={date} onChange={(e) => { setDate(e.target.value); setOther(""); setOtherDate(""); }}>
              <option value="">Choose…</option>
              {offDays.map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}
            </select>
          </label>
          <label className="field half">Trade with
            <select name="other" value={other} onChange={(e) => { setOther(e.target.value); setOtherDate(""); }}>
              <option value="">Choose…</option>
              {others.filter((o) => !date || working(o, date)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="field">Their day off (I&apos;ll take it)
            <select name="other_date" value={otherDate} onChange={(e) => setOtherDate(e.target.value)}>
              <option value="">Choose…</option>
              {workDays.filter((d) => !coworker || coworker.days[d.date] === "Off").map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}
            </select>
          </label>
          <p className="field small muted" style={{ margin: 0 }}>Your coworker accepts first, then an owner or the General Manager approves. Both schedules change by themselves.</p>
        </>
      ) : kind === "SWAP" ? (
        <>
          <label className="field half">My day
            <select name="date" value={date} onChange={(e) => setDate(e.target.value)}>
              <option value="">Choose…</option>
              {[...workDays, ...offDays].sort((a, b) => a.date.localeCompare(b.date)).map((d) => <option key={d.date} value={d.date}>{d.label}{offDays.some((o) => o.date === d.date) ? " (day off)" : ""}</option>)}
            </select>
          </label>
          <label className="field half">Swap with
            <select name="other" value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">Choose…</option>
              {others.filter((o) => !date || o.days[date]).map((o) => <option key={o.id} value={o.id}>{o.name}{date && o.days[date] ? ` (${o.days[date]})` : ""}</option>)}
            </select>
          </label>
          <p className="field small muted" style={{ margin: 0 }}>Your coworker accepts first, then an owner or the General Manager approves.</p>
        </>
      ) : (
        <>
          <label className="field half">Work on my day off
            <select name="date" value={date} onChange={(e) => setDate(e.target.value)}>
              <option value="">Choose…</option>
              {offDays.map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}
            </select>
          </label>
          <label className="field half">Take this day off instead
            <select name="other_date" value={otherDate} onChange={(e) => setOtherDate(e.target.value)}>
              <option value="">Choose…</option>
              {workDays.map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}
            </select>
          </label>
        </>
      )}
      <label className="field">Reason (optional)<input name="reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="field"><button disabled={pending}>{pending ? "Sending…" : kind === "DAY_OFF" ? "Send to manager" : "Send to my coworker"}</button></div>
    </form>
  );
}

export function RespondSwapForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(respondSwap, undefined);
  const [no, setNo] = useState(false);
  if (state?.ok) return <span className="small muted">{state.ok}</span>;
  return (
    <form action={action} className="row-buttons">
      <input type="hidden" name="id" value={id} />
      {no ? (
        <>
          <input name="note" placeholder="Why not? (optional)" maxLength={300} />
          <button onClick={pick("decline")} className="danger small" disabled={pending}>Decline</button>
          <button type="button" className="secondary small" onClick={() => setNo(false)}>Back</button>
        </>
      ) : (
        <>
          <button onClick={pick("accept")} className="small" disabled={pending}>Accept</button>
          <button type="button" className="secondary small" onClick={() => setNo(true)}>Decline</button>
        </>
      )}
      {state?.error && <span className="field-error">{state.error}</span>}
    </form>
  );
}

export function DecideForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(decideRequest, undefined);
  const [no, setNo] = useState(false);
  return (
    <form action={action} className="row-buttons">
      <input type="hidden" name="id" value={id} />
      {no ? (
        <>
          <input name="note" placeholder="Why not?" required minLength={3} maxLength={300} />
          <button onClick={pick("reject")} className="danger small" disabled={pending}>Don&apos;t approve</button>
          <button type="button" className="secondary small" onClick={() => setNo(false)}>Back</button>
        </>
      ) : (
        <>
          <button onClick={pick("approve")} className="small" disabled={pending}>Approve</button>
          <button type="button" className="secondary small" onClick={() => setNo(true)}>Don&apos;t approve</button>
        </>
      )}
      {state?.error && <span className="field-error">{state.error}</span>}
    </form>
  );
}

export function CancelForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(cancelRequest, undefined);
  return (
    <form action={action} className="row-buttons">
      <input type="hidden" name="id" value={id} />
      <button className="secondary small" disabled={pending}>Cancel request</button>
      {state?.error && <span className="field-error">{state.error}</span>}
    </form>
  );
}

const STATUSES = [{ v: "OFF", label: "Off" }, { v: "VL", label: "VL" }, { v: "SL", label: "SL" }, { v: "ABSENT", label: "Absent" }];

/** The week like the clinic's sheet: days down the side; each branch, Off and Leave across; names in the cells. */
export function BranchWeek({ dates, today, people, shifts, branches, me }: { dates: string[]; today: string; people: Person[]; shifts: Shift[]; branches: B[]; me: string | null }) {
  const [edit, setEdit] = useState<string | null>(null);
  const short = shortNames(people);
  const canEdit = people.some((p) => p.can_edit);
  const on = (d: string) => shifts.filter((s) => s.date === d);
  const byName = (a: Shift, b: Shift) => (short[a.employee_id] ?? "").localeCompare(short[b.employee_id] ?? "");
  const Names = ({ list, leave }: { list: Shift[]; leave?: boolean }) => list.length === 0 ? <span className="none">–</span> : (
    <ul className="names">
      {list.sort(byName).map((s) => {
        const odd = !s.off && s.start && (s.start !== "10:00" || s.end !== "19:00");
        return (
          <li key={s.employee_id} className={`${s.state === "DRAFT" ? "draft" : ""} ${s.employee_id === me ? "me" : ""}`} title={s.note ?? undefined}>
            {short[s.employee_id] ?? "?"}
            {leave && s.leave && <span className="leave-tag">{LEAVE_TEXT[s.leave]}</span>}
            {odd && <span className="hrs">{timeLabel(s.start)}–{timeLabel(s.end)}</span>}
          </li>
        );
      })}
    </ul>
  );
  return (
    <>
      <div className="sheet-wrap">
        <table className="sheet">
          <colgroup><col className="c-day" />{branches.map((b) => <col key={b.id} />)}<col className="c-off" /><col className="c-off" /></colgroup>
          <thead><tr><th>Day</th>{branches.map((b, i) => <th key={b.id} className={`b${i % 4}`}>{b.name}</th>)}<th className="muted-col">Off</th><th className="muted-col">Leave</th></tr></thead>
          <tbody>
            {dates.map((d) => {
              const day = on(d);
              return (
                <tr key={d} className={`${d === today ? "today" : ""} ${canEdit ? "editable" : ""}`} onClick={canEdit ? () => setEdit(d) : undefined}
                  tabIndex={canEdit ? 0 : undefined} onKeyDown={canEdit ? (e) => { if (e.key === "Enter") setEdit(d); } : undefined}>
                  <th scope="row"><span className="dow">{DOW[wd(d)]}</span><span className="dnum">{shortDate(d)}</span>{canEdit && <span className="edit-hint">Edit</span>}</th>
                  {branches.map((b) => <td key={b.id}><Names list={day.filter((s) => !s.off && s.branch_id === b.id)} /></td>)}
                  <td className="muted-col"><Names list={day.filter((s) => s.off && !s.leave)} /></td>
                  <td className="muted-col leave"><Names list={day.filter((s) => s.off && s.leave)} leave /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sheet-days">
        {dates.map((d) => {
          const day = on(d);
          const cols = [...branches.map((b, i) => ({ k: b.id, label: b.name, cls: `b${i % 4}`, list: day.filter((s) => !s.off && s.branch_id === b.id), leave: false })),
            { k: "off", label: "Off", cls: "muted-col", list: day.filter((s) => s.off && !s.leave), leave: false },
            { k: "leave", label: "Leave", cls: "muted-col", list: day.filter((s) => s.off && s.leave), leave: true }].filter((c) => c.list.length);
          return (
            <div key={d} className={`sheet-day ${d === today ? "today" : ""}`}>
              <div className="sheet-day-head"><strong>{DOW[wd(d)]}, {shortDate(d)}</strong>{canEdit && <button type="button" className="secondary small" onClick={() => setEdit(d)}>Edit</button>}</div>
              {cols.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing planned.</p> : (
                <dl>{cols.map((c) => <div key={c.k} className={c.cls}><dt>{c.label}</dt><dd><Names list={c.list} leave={c.leave} /></dd></div>)}</dl>
              )}
            </div>
          );
        })}
      </div>
      <p className="small muted legend">{canEdit && <>Tap a day to change it. </>}<span className="key draft" /> = not published yet. Hours show only when not 10 AM–7 PM.</p>
      {edit && <DayEditor key={edit} date={edit} people={people.filter((p) => p.can_edit)} shifts={on(edit)} branches={branches} short={short} onClose={() => setEdit(null)} />}
    </>
  );
}

function DayEditor({ date, people, shifts, branches, short, onClose }: { date: string; people: Person[]; shifts: Shift[]; branches: B[]; short: Record<string, string>; onClose: () => void }) {
  const [state, action, pending] = useActionState(saveDay, undefined);
  const ref = useRef<HTMLDialogElement>(null);
  const init = Object.fromEntries(people.map((p) => {
    const s = shifts.find((x) => x.employee_id === p.id);
    return [p.id, { status: !s ? "" : s.off ? (s.leave ?? "OFF") : s.branch_id ?? "", start: s?.start ?? "10:00", end: s?.end ?? "19:00" }];
  }));
  const [rows, setRows] = useState(init);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => { if (state?.ok) onClose(); }, [state, onClose]);
  const set = (id: string, patch: Partial<{ status: string; start: string; end: string }>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const payload = people.filter((p) => rows[p.id].status).map((p) => ({ employee: p.id, status: rows[p.id].status,
    ...(STATUSES.some((s) => s.v === rows[p.id].status) ? {} : { start: rows[p.id].start, end: rows[p.id].end }) }));
  return (
    <dialog ref={ref} className="sheet wide" onClose={onClose}>
      <form action={action}>
        <h2>{DOW[wd(date)]}, {shortDate(date)}</h2>
        <p className="small muted" style={{ margin: "4px 0 10px" }}>Pick where each person is. Published days notify the person when they change.</p>
        <Msg s={state} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="rows" value={JSON.stringify(payload)} />
        <ul className="plain-list day-edit">
          {people.map((p) => {
            const r = rows[p.id];
            const working = r.status && !STATUSES.some((s) => s.v === r.status);
            return (
              <li key={p.id}>
                <strong className="who">{short[p.id]}</strong>
                <div className="status-pick" role="radiogroup" aria-label={`${p.name} on ${shortDate(date)}`}>
                  {branches.map((b) => <button type="button" key={b.id} className={r.status === b.id ? "on" : ""} onClick={() => set(p.id, { status: b.id })}>{b.name}</button>)}
                  {STATUSES.map((s) => <button type="button" key={s.v} className={`${r.status === s.v ? "on" : ""} st-${s.v}`} onClick={() => set(p.id, { status: s.v })}>{s.label}</button>)}
                </div>
                {working && <span className="hours"><HourSelect name={`s-${p.id}`} value={r.start} onChange={(v) => set(p.id, { start: v })} /> – <HourSelect name={`e-${p.id}`} value={r.end} onChange={(v) => set(p.id, { end: v })} /></span>}
              </li>
            );
          })}
        </ul>
        <div className="row-buttons" style={{ marginTop: 12 }}>
          <button disabled={pending}>{pending ? "Saving…" : "Save day"}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function RulesForm({ rules, branches }: { rules: Rules; branches: B[] }) {
  const [state, action, pending] = useActionState(saveRules, undefined);
  const [r, setR] = useState(rules);
  const setMin = (b: string, d: number, v: number) => setR((x) => ({ ...x, min: { ...x.min, [b]: x.min[b].map((n, i) => (i === d ? v : n)) } }));
  return (
    <form action={action} className="rules-form">
      <input type="hidden" name="rules" value={JSON.stringify(r)} />
      <div className="table-wrap">
        <table className="rules-table">
          <thead><tr><th>Fewest people</th>{DAYS.map((d) => <th key={d}>{d}</th>)}</tr></thead>
          <tbody>
            {branches.map((b) => (
              <tr key={b.id}><th scope="row">{b.name}</th>
                {DAYS.map((d, i) => <td key={d}><input type="number" min={0} max={9} value={r.min[b.id]?.[i] ?? 1} aria-label={`${b.name} ${d}`}
                  onChange={(e) => setMin(b.id, i, Math.max(0, Math.min(9, Number(e.target.value) || 0)))} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row-buttons" style={{ marginTop: 10 }}>
        <label className="small">Days off per person each week
          <select value={r.days_off} onChange={(e) => setR({ ...r, days_off: Number(e.target.value) })} style={{ marginLeft: 8 }}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select></label>
        <button className="secondary small" disabled={pending}>{pending ? "Saving…" : "Save rules"}</button>
        {state?.error && <span className="field-error">{state.error}</span>}
        {state?.ok && <span className="small ok-text">{state.ok}</span>}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>Suggest a week also uses each person&apos;s usual branch and usual day off (below), keeps published days and approved leave, and spreads days off so no branch runs short.</p>
    </form>
  );
}
