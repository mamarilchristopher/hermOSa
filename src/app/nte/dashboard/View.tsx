import Link from "next/link";
import { ControlBar, PeriodNav, Stat, Stats, Tabs } from "@/components/Controls";
import { monthLabel } from "@/lib/insights";
import { dayLabel } from "@/lib/homeGlance";
import { IR_NTE_COUNT } from "@/lib/nte";
import type { Board, BoardRow, Kpis, StripDay } from "@/lib/tardiness";
import { Uid } from "@/components/Uid";

export const shiftMonth = (ym: string, n: number) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 1000) / 10}%`);
const hrs = (m: number) => (m >= 60 ? `${Math.round(m / 6) / 10} hrs` : `${m} min`);

/** On-time ring: green at 95%+, gold at 85%+, red below. */
function Ring({ v }: { v: number | null }) {
  const r = 18, c = 2 * Math.PI * r, p = v ?? 1;
  const tone = v === null ? "none" : v >= 0.95 ? "good" : v >= 0.85 ? "mid" : "bad";
  return (
    <span className={`tdy-ring ${tone}`} title={v === null ? "No working days yet" : `${pct(v)} of working days on time`}>
      <svg viewBox="0 0 44 44" aria-hidden><circle cx="22" cy="22" r={r} className="track" /><circle cx="22" cy="22" r={r} className="fill" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 22 22)" /></svg>
      <span className={v !== null && v >= 0.995 ? "full" : undefined}>{v === null ? "–" : `${Math.round(v * 100)}%`}</span>
    </span>
  );
}

const stripTitle = (d: StripDay) => {
  const day = dayLabel(d.date);
  switch (d.kind) {
    case "late": return `${day}: ${d.minutes} min late`;
    case "excused": return `${day}: ${d.minutes} min late, reason accepted`;
    case "ok": return `${day}: on time`;
    case "absent": return `${day}: scheduled, no time-in (leave or absent)`;
    case "future": return `${day}: scheduled`;
    default: return `${day}: no shift`;
  }
};
function Strip({ days }: { days: StripDay[] }) {
  return (
    <span className="tdy-strip" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
      {days.map((d) => <i key={d.date} className={`${d.kind}${d.kind === "late" && (d.minutes ?? 0) >= 30 ? " big" : ""}`} title={stripTitle(d)} />)}
    </span>
  );
}

/** Minutes counted toward an IR, against the monthly limit (the tick marks the limit). */
function MinBar({ m, limit }: { m: number; limit: number }) {
  const span = limit * 1.5;
  return (
    <span className="tdy-bar" title={`${m} of ${limit} minutes before an IR`}>
      <span className="tdy-bar-num"><strong>{m}</strong> min</span>
      <span className="tdy-bar-track"><span className={m > limit ? "over" : ""} style={{ width: `${Math.min(100, (m / span) * 100)}%` }} /><b style={{ left: `${(limit / span) * 100}%` }} /></span>
    </span>
  );
}

type B = { id: string; code: string; name: string };
/** The dashboard itself (server-safe, no data calls), so it can be previewed with demo data. */
export function TardinessView({ ym, thisMonth, pm, pUpTo, viewable, branch, board, before }: {
  ym: string; thisMonth: string; pm: string; pUpTo: string; viewable: B[]; branch: B | null; board: Board; before: Kpis;
}) {
  const limit = board.limit;
  const k = board.kpis;
  const pmName = MON[Number(pm.slice(5, 7)) - 1];
  const vsLabel = ym === thisMonth ? `${pmName} 1–${Number(pUpTo.slice(8))}` : pmName;
  const ptsDelta = k.onTime !== null && before.onTime !== null ? Math.round((k.onTime - before.onTime) * 1000) / 10 : null;
  const lateDelta = before.worked ? k.lates - before.lates : null;
  const q = (o: { month?: string; branch?: string | null }) => {
    const p = new URLSearchParams();
    const m = o.month ?? ym, b = o.branch === undefined ? branch?.code : o.branch;
    if (m !== thisMonth) p.set("month", m);
    if (b) p.set("branch", b);
    const s = p.toString();
    return `/nte/dashboard${s ? `?${s}` : ""}`;
  };
  const rowsShown = board.rows;
  const watch = rowsShown.filter((r) => r.status.key === "due" || r.status.key === "near");

  return (
      <main>
        <div className="title-row tdy-title">
          <h1>Tardiness</h1>
          <Link className="button secondary small" href={`/nte${ym === thisMonth ? "" : `?month=${ym}`}`}>All Late NTEs →</Link>
        </div>
        <p className="muted small">Everyone&apos;s punctuality for the month, worst first. Tap a person to open their Late NTEs. An IR is due at {IR_NTE_COUNT} counted Late NTEs or more than {limit} minutes late in a month.</p>

        <ControlBar>
          <Tabs tabs={[{ href: q({ branch: null }), label: "All branches", on: !branch }, ...viewable.map((b) => ({ href: q({ branch: b.code }), label: b.name, on: branch?.id === b.id }))]} />
          <PeriodNav prev={q({ month: pm })} next={ym < thisMonth ? q({ month: shiftMonth(ym, 1) }) : null} label={monthLabel(ym)}
            reset={ym === thisMonth ? null : { href: q({ month: thisMonth }), label: "This month" }} prevLabel="Previous month" nextLabel="Next month" />
        </ControlBar>

        <Stats>
          <Stat hero label="On time" value={pct(k.onTime)}
            note={ptsDelta !== null ? <><span className={`delta ${ptsDelta >= 0 ? "up" : "down"}`}>{ptsDelta >= 0 ? "▲" : "▼"} {Math.abs(ptsDelta)} pts</span> <span className="muted">vs {vsLabel}</span></> : <span className="muted">{k.worked} working days</span>} />
          <Stat label="Lates" value={k.lates}
            note={lateDelta !== null ? <><span className={`delta ${lateDelta <= 0 ? "up" : "down"}`}>{lateDelta > 0 ? "▲" : lateDelta < 0 ? "▼" : ""} {Math.abs(lateDelta)}</span> <span className="muted">vs {vsLabel}</span></> : undefined} />
          <Stat label="Minutes late" value={k.minutes} note={<span className="muted">{hrs(k.minutes)} of work time</span>} />
          <Stat label="IR due · close" value={<>{k.due}<span className="muted tdy-sub"> · {k.near}</span></>} tone={k.due ? "bad" : k.near ? "warn" : undefined}
            note={<span className="muted">{IR_NTE_COUNT} NTEs or &gt;{limit} min</span>} />
        </Stats>

        {watch.length > 0 && (
          <div className="tdy-watch">
            {watch.map((r) => (
              <Link key={r.id} href={`/nte/staff/${r.id}?month=${ym}`} className={`tdy-chip ${r.status.key}`}>
                <strong>{r.name}</strong> {r.status.text}
              </Link>
            ))}
          </div>
        )}

        <div className="card tdy-board">
          {rowsShown.length === 0 ? <p className="muted" style={{ margin: 0 }}>No one had a published shift {ym === thisMonth ? "this month" : `in ${monthLabel(ym)}`} yet.</p> : (
            <>
              <div className="tdy-row tdy-headrow" aria-hidden>
                <span>On time</span><span>Staff</span><span className="num">Lates</span><span>Minutes vs {limit}-min IR line</span><span>{monthLabel(ym)}</span><span>IR</span>
              </div>
              {rowsShown.map((r: BoardRow) => (
                <Link key={r.id} href={`/nte/staff/${r.id}?month=${ym}`} className={`tdy-row st-${r.status.key}`}>
                  <Ring v={r.onTime} />
                  <span className="tdy-who"><span className="tdy-name"><strong>{r.name}</strong><Uid v={r.uid ?? undefined} /></span><span className="small muted">{[r.branch, r.position].filter(Boolean).join(" · ")}</span></span>
                  <span className="num tdy-lates"><strong>{r.lates}</strong><span className="small muted nowrap"> of {r.worked} days</span></span>
                  <MinBar m={r.minutes} limit={limit} />
                  <Strip days={r.strip} />
                  <span className={`tdy-st ${r.status.key}`}>{r.status.text}</span>
                </Link>
              ))}
              <p className="tdy-legend small muted">
                <span><i className="ok" /> On time</span><span><i className="late" /> Late</span><span><i className="late big" /> 30+ min</span>
                <span><i className="excused" /> Reason accepted</span><span><i className="absent" /> No time-in</span><span><i className="off" /> No shift</span>
              </p>
            </>
          )}
        </div>
      </main>
  );
}
