import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { addDays, weekday } from "@/lib/insights";
import { DOW, LEAVE_TEXT, mondayOf, shortDate, timeLabel, weekDates, weekLabel, branchShort } from "@/lib/schedule";
import { BranchWeek, WeekGrid, WeekButtons, PatternForm, RequestForm, DecideForm, CancelForm } from "./Forms";

export type Person = { id: string; name: string; position: string | null; branch_id: string | null; can_edit: boolean;
  pattern: { branch_id: string; days_off: number[]; start: string; end: string } | null };
export type Shift = { employee_id: string; date: string; off: boolean; branch_id: string | null; start: string | null; end: string | null; state: "DRAFT" | "PUBLISHED"; note: string | null; leave: "VL" | "SL" | "ABSENT" | null };
type Req = { id: string; kind: "SWAP" | "DAY_OFF"; employee_id: string; name: string; date: string; other_employee_id: string | null; other_name: string | null;
  other_date: string | null; reason: string | null; mine: boolean; can_decide: boolean };
type Week = { me: string | null; people: Person[]; shifts: Shift[]; requests: Req[] };

const dayName = (d: string) => `${DOW[weekday(d)]}, ${shortDate(d)}`;

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ week?: string; view?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  const today = manilaToday();
  const monday = mondayOf(isIsoDate(sp.week) ? sp.week : today);
  const dates = weekDates(monday);
  const { data, error } = await supabase.rpc("week_schedule", { p_monday: monday });
  const clinics = branches.filter((b) => b.kind === "CLINIC").map((b) => ({ id: b.id, name: branchShort(b.name) }));

  if (error) {
    return (<><TopBar access={access} /><main><h1>Schedule</h1>
      <div className="notice info">{error.code === "PGRST202" ? "The owner needs to run update-0022 in Supabase first." : "Could not load the schedule. Try again."}</div></main></>);
  }
  const w = data as Week;
  const scheduler = w.people.some((p) => p.can_edit);
  const drafts = w.shifts.filter((s) => s.state === "DRAFT").length;
  const published = w.shifts.filter((s) => s.state === "PUBLISHED").length;
  const myDays = w.me ? w.shifts.filter((s) => s.employee_id === w.me && s.state === "PUBLISHED").sort((a, b) => a.date.localeCompare(b.date)) : [];
  const bname = (id: string | null) => clinics.find((b) => b.id === id)?.name ?? "";
  const byPerson = sp.view === "person";
  const link = (m: string, v = byPerson ? "person" : "") => `/schedule?week=${m}${v ? `&view=${v}` : ""}`;
  const thisMonday = mondayOf(today);

  // Request form options: my working days (to swap), my days off (to work instead), and who works each day.
  const future = (s: Shift) => s.date >= today;
  const workDays = myDays.filter((s) => !s.off && future(s)).map((s) => ({ date: s.date, label: dayName(s.date) }));
  const offDays = myDays.filter((s) => s.off && future(s)).map((s) => ({ date: s.date, label: dayName(s.date) }));
  const others = w.people.filter((p) => p.id !== w.me).map((p) => ({ id: p.id, name: p.name,
    days: Object.fromEntries(w.shifts.filter((s) => s.employee_id === p.id && s.state === "PUBLISHED").map((s) => [s.date, s.off ? "Off" : `${bname(s.branch_id)} ${timeLabel(s.start)}`])) }));

  const decide = w.requests.filter((r) => r.can_decide);
  const mine = w.requests.filter((r) => !r.can_decide);
  const reqText = (r: Req) => r.kind === "SWAP"
    ? `${r.name} wants to swap ${dayName(r.date)} with ${r.other_name}`
    : `${r.name} wants to work ${dayName(r.date)} and take ${r.other_date ? dayName(r.other_date) : ""} off instead`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Schedule</h1>
        <p className="muted small">{scheduler
          ? "Fill the week from everyone's usual schedule, adjust any day, then publish. Staff see the week once it's published."
          : "Your week and your branch's. Ask here to swap a day or move your day off; a manager approves it."}</p>

        <div className="card week-nav">
          <Link className="button secondary small" href={link(addDays(monday, -7))} aria-label="Previous week">‹</Link>
          <div className="week-title">
            <strong>{weekLabel(monday)}</strong>
            <span className="small muted">{monday === thisMonday ? "This week" : monday === addDays(thisMonday, 7) ? "Next week" : monday < thisMonday ? "Past week" : "Upcoming"}
              {scheduler && (drafts > 0 ? <> · <span className="pill STAGED">{drafts} day{drafts === 1 ? "" : "s"} not published</span></> : published > 0 ? <> · <span className="pill PUBLISHED">Published</span></> : " · Not planned yet")}</span>
          </div>
          <Link className="button secondary small" href={link(addDays(monday, 7))} aria-label="Next week">›</Link>
          {monday !== thisMonday && <Link className="small" href="/schedule">This week</Link>}
        </div>

        {decide.length > 0 && (
          <div className="card">
            <h2>Waiting for your approval</h2>
            <ul className="plain-list req-list">
              {decide.map((r) => (
                <li key={r.id}>
                  <div><strong>{reqText(r)}</strong>{r.reason && <div className="small muted">“{r.reason}”</div>}</div>
                  <DecideForm id={r.id} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {w.me && myDays.length > 0 && (
          <div className="card">
            <h2>My week</h2>
            <div className="my-week">
              {dates.map((d) => {
                const s = myDays.find((x) => x.date === d);
                return (
                  <div key={d} className={`my-day ${s?.off ? "off" : ""} ${d === today ? "today" : ""}`}>
                    <span className="small muted">{DOW[weekday(d)]} {Number(d.slice(8))}</span>
                    <strong>{!s ? "–" : s.leave ? LEAVE_TEXT[s.leave] : s.off ? "Day off" : bname(s.branch_id)}</strong>
                    {s && !s.off && <span className="small">{timeLabel(s.start)} – {timeLabel(s.end)}</span>}
                    {s?.note && <span className="small muted">{s.note}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {scheduler && <WeekButtons monday={monday} drafts={drafts} empty={w.shifts.length === 0} />}

        {w.people.length > 0 && (w.shifts.length > 0 || scheduler) ? (
          <>
            <div className="segmented view-toggle" aria-label="View">
              <Link className={!byPerson ? "on" : ""} href={link(monday, "")}>By branch</Link>
              <Link className={byPerson ? "on" : ""} href={link(monday, "person")}>By person</Link>
            </div>
            {byPerson ? <WeekGrid dates={dates} today={today} people={w.people} shifts={w.shifts} branches={clinics} me={w.me} />
              : <BranchWeek dates={dates} today={today} people={w.people} shifts={w.shifts} branches={clinics} me={w.me} />}
          </>
        ) : (
          <div className="card"><p className="muted" style={{ margin: 0 }}>The schedule for this week isn&apos;t published yet.</p></div>
        )}

        {w.me && (workDays.length > 0 || offDays.length > 0) && (
          <div className="card">
            <h2>Ask for a change</h2>
            <RequestForm workDays={workDays} offDays={offDays} others={others} />
          </div>
        )}

        {mine.length > 0 && (
          <div className="card">
            <h2>Waiting for a manager</h2>
            <ul className="plain-list req-list">
              {mine.map((r) => (
                <li key={r.id}>
                  <div><strong>{reqText(r)}</strong>{r.reason && <div className="small muted">“{r.reason}”</div>}</div>
                  {r.mine && <CancelForm id={r.id} />}
                </li>
              ))}
            </ul>
          </div>
        )}

        {scheduler && (
          <details className="card patterns">
            <summary><h2>Usual schedules</h2><span className="small muted">Home branch, days off and hours used to fill a new week</span></summary>
            <ul className="plain-list pattern-list">
              {w.people.filter((p) => p.can_edit).map((p) => (
                <li key={p.id}>
                  <div className="pattern-who"><strong>{p.name}</strong>{p.position && <span className="small muted"> · {p.position}</span>}
                    {!p.pattern && <span className="pill STAGED">Not set</span>}</div>
                  <PatternForm employee={p.id} pattern={p.pattern} homeBranch={p.branch_id} branches={clinics} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </>
  );
}
