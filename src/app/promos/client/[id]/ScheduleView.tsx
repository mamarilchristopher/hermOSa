"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { planVisits, scheduleText, tinyName, type PlanStep } from "@/lib/promoRules";
import { replan, type Log, type PromoPart } from "@/lib/promoTrack";
import { drawSchedule } from "@/lib/promoImage";
import { COPY_FAIL, copyCanvas, fontsOf, saveCanvas } from "@/lib/canvasShare";
import { updatePromoClient } from "../../actions";

type Step = PlanStep & { doneOn: string | null };
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(",", "");
const monthOf = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });

/** The client's schedule (update-0087): send it as a photo or text, see what's done, move the rest, extend or cancel. */
export function ScheduleView(p: {
  id: string; title: string; client: string; ends: string; start: string; today: string; plan: Step[]; names: Record<string, string>;
  totals: Record<string, number>; parts: PromoPart[]; logs: Log[]; manage: boolean; active: boolean; cancelled: boolean; serif: string; serifClass: string;
}) {
  const [note, setNote] = useState<{ ok?: string; error?: string } | null>(null);
  const [from, setFrom] = useState(p.today > p.start ? p.today : p.start);
  const [pending, start] = useTransition();
  const router = useRouter();
  const visits = planVisits(p.plan).map((v) => ({ d: v.d, steps: v.steps as Step[] }));
  const art = () => ({
    title: p.title, client: p.client, ends: p.ends,
    visits: visits.map((v) => ({ d: v.d, items: v.steps.map((s) => ({ name: tinyName(p.names[s.s] ?? "Session"), n: s.n, of: p.totals[s.s] ?? s.n, done: !!s.doneOn })) })),
  });
  const draw = () => fontsOf(p.serif).then((f) => drawSchedule(art(), f));
  const file = `${p.title.replace(/[^A-Za-z0-9]+/g, "-")}-schedule-${p.client.split(/\s+/)[0]?.replace(/[^A-Za-z0-9]/g, "") || "client"}.png`;
  const text = scheduleText({ title: p.title, client: p.client, ends: p.ends, plan: p.plan.filter((s) => !s.doneOn), names: p.names, totals: p.totals });
  function run(f: () => Promise<{ ok?: string; error?: string }>) {
    start(async () => { const r = await f(); setNote(r); if (r.ok) router.refresh(); });
  }
  function rebuild() {
    // Done sessions keep the day they were done; the rest are spread again from the chosen day at the usual pace.
    const kept = p.plan.filter((s) => s.doneOn).map((s) => ({ d: s.doneOn!, s: s.s, n: s.n }));
    const rest = replan(p.parts, p.logs, from, p.ends);
    if (!rest.length) { setNote({ ok: "Every session is already done." }); return; }
    run(() => updatePromoClient(p.id, "SCHEDULE", { schedule: [...kept, ...rest] }));
  }
  return (
    <>
      <span className={p.serifClass} aria-hidden style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}>Aa</span>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Send the client their schedule</h2>
        <p className="small muted">A photo with every visit (done ones ticked), or the text of the visits left, for Messenger.</p>
        <div className="row-buttons">
          <button type="button" className="secondary small" onClick={() => saveCanvas(draw(), file).catch(() => setNote({ error: "Could not make the photo. Try again." }))}>Save as photo</button>
          <button type="button" className="secondary small" onClick={async () => setNote((await copyCanvas(draw())) ? { ok: "Schedule copied. Paste it in the client's chat." } : { error: COPY_FAIL })}>Copy as photo</button>
          <button type="button" className="secondary small" onClick={async () => { try { await navigator.clipboard.writeText(text); setNote({ ok: "Schedule text copied." }); } catch { setNote({ error: "Could not copy. Try again." }); } }}>Copy as text</button>
        </div>
        {note?.ok && <div className="notice ok small">{note.ok}</div>}
        {note?.error && <div className="notice error small">{note.error}</div>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Schedule</h2>
        {visits.length === 0 && <p className="small muted">No schedule yet. Use &quot;Plan the rest&quot; below.</p>}
        {(() => {
          // The next visits first; the whole year (done ones ticked) folds away so the page stays short on phones.
          const firstOpen = visits.findIndex((v) => !v.steps.every((s) => s.doneOn));
          const soon = firstOpen < 0 ? [] : visits.slice(firstOpen, firstOpen + 6);
          const rows = (list: typeof visits) => {
            let lastMonth = "";
            return list.flatMap((v) => {
              const m = monthOf(v.d);
              const head = m !== lastMonth ? (lastMonth = m) : null;
              const allDone = v.steps.every((s) => s.doneOn);
              const late = !allDone && v.d < p.today;
              return [
                head && <tr key={`${v.d}-m`} className="month"><th colSpan={3}>{head}</th></tr>,
                <tr key={v.d} className={allDone ? "done" : late ? "late" : ""}>
                  <td className="nowrap">{day(v.d)}</td>
                  <td>{v.steps.map((s) => `${p.names[s.s] ?? "Session"} ${s.n}/${p.totals[s.s] ?? s.n}`).join(" + ")}</td>
                  <td className="small nowrap">{allDone ? `✓${v.steps[0].doneOn !== v.d ? ` ${day(v.steps[0].doneOn!)}` : ""}` : late ? "Late" : v.d === p.today ? "Today" : ""}</td>
                </tr>,
              ];
            });
          };
          return (
            <>
              {soon.length > 0 && (
                <>
                  <h3 className="small">Next visits</h3>
                  <div className="table-wrap"><table className="promo-plan"><tbody>{rows(soon)}</tbody></table></div>
                </>
              )}
              <details className="promo-all">
                <summary className="small">All {visits.length} visits ({visits.filter((v) => v.steps.every((s) => s.doneOn)).length} done)</summary>
                <div className="table-wrap"><table className="promo-plan"><tbody>{rows(visits)}</tbody></table></div>
              </details>
            </>
          );
        })()}
        {p.active && (
          <div className="promo-row" style={{ marginTop: 12 }}>
            <label>Plan the rest from
              <input type="date" value={from} min={p.start} max={p.ends} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <button type="button" className="secondary" disabled={pending} onClick={rebuild}>Plan the rest at the usual pace</button>
          </div>
        )}
        <p className="small muted">The plan follows each service&apos;s usual pace (drips weekly, facials monthly, face HIFU about every 6 months), never closer than each service's safe gap. Sessions count when they are logged in the Service log for this client, whatever the day.</p>
      </div>

      {p.manage && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Owners and the GM</h2>
          <div className="row-buttons">
            <button type="button" className="secondary small" disabled={pending} onClick={() => run(() => updatePromoClient(p.id, "EXTEND", { months: 1 }))}>Extend 1 month</button>
            <button type="button" className="secondary small" disabled={pending} onClick={() => run(() => updatePromoClient(p.id, "EXTEND", { months: 3 }))}>Extend 3 months</button>
            {p.active && <button type="button" className="secondary small" disabled={pending} onClick={() => confirm(`Cancel ${p.client}'s ${p.title}? Their remaining sessions can't be logged any more.`) && run(() => updatePromoClient(p.id, "CANCEL"))}>Cancel this client&apos;s promo</button>}
            {p.cancelled && <button type="button" className="secondary small" disabled={pending} onClick={() => run(() => updatePromoClient(p.id, "REOPEN"))}>Reopen</button>}
          </div>
        </div>
      )}
    </>
  );
}
