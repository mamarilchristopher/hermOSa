"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { centsToPhp } from "@/lib/csv";
import { readMoney } from "@/lib/tracker";
import { saveGrid } from "./actions";
import { ShareDay } from "./ShareDay";

export type GridBranch = { id: string; name: string; can_enter: boolean };
/** [recorded cents | null, mark | null, waiting sign-off, approved service log cents | null, correction pending,
 *   service log cents still waiting sign-off | null, auto-fill from the service log applies (Nov 25 on)] */
export type GridCell = [number | null, string | null, boolean, number | null, boolean, (number | null)?, boolean?];
/** CHRIS Nov 28 (v0.99.3): an untyped day shows its approved Service log total (even over a Zero sales / Closed mark). */
const autoOf = (c: GridCell | undefined): number | null => (c && c[0] === null && c[6] && (c[3] ?? 0) > 0 ? c[3] : null);

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const label = (d: string) => `${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${Number(d.slice(8))}`;
const php = (c: number) => centsToPhp(c).replace(/\.00$/, "");
type Mark = "CLOSED" | "NO_SALES";
const MARK_LABEL: Record<Mark, string> = { NO_SALES: "Zero sales", CLOSED: "Closed" };
/** Typing 0 means zero sales and "closed" (or just "c") means closed, as shortcuts for the menu. */
const typedMark = (v: string): Mark | null => {
  const t = v.trim().toLowerCase().replace(/[₱,\s]/g, "");
  if (/^0+(\.0+)?$/.test(t) || t === "zero" || t === "nosales") return "NO_SALES";
  if (t === "c" || t === "closed") return "CLOSED";
  return null;
};

/** The Sales Source Tracker, inside the OS: one row per day, one column per branch, type and save. */
export function MonthGrid({ dates, branches, cells, today, changed = [], highlight = [] }: {
  dates: string[]; branches: GridBranch[]; cells: Record<string, GridCell>; today: string;
  /** "branch|date" cells to highlight and scroll to (opened from a notice). */
  highlight?: string[];
  /** "branch|date" keys already changed once: a further change needs two people. */
  changed?: string[];
}) {
  const changedSet = useMemo(() => new Set(changed), [changed]);
  const hl = useMemo(() => new Set(highlight), [highlight]);
  useEffect(() => {
    if (!highlight.length) return;
    document.querySelector(`[data-cell="${highlight[0]}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; failed?: string[] } | null>(null);

  const key = (b: string, d: string) => `${b}|${d}`;
  const parsed = useMemo(() => {
    const entries: { branch: string; date: string; cents: number }[] = [];
    const fixes: { branch: string; date: string; cents: number }[] = [];
    const zero: { branch: string; date: string; status: Mark }[] = [];
    const bad = new Set<string>();
    for (const [k, m] of Object.entries(marks)) {
      const [branch, date] = k.split("|");
      zero.push({ branch, date, status: m });
    }
    for (const [k, v] of Object.entries(typed)) {
      if (!v.trim() || marks[k]) continue;
      const [branch, date] = k.split("|");
      const tm = typedMark(v);
      const rec0 = cells[k]?.[0] ?? null;
      if (tm && rec0 === null) { zero.push({ branch, date, status: tm }); continue; }
      // A recorded day changed to zero sales is a change like any other (₱0).
      if (tm === "NO_SALES" && rec0 !== null) { fixes.push({ branch, date, cents: 0 }); continue; }
      const c = readMoney(v);
      if (c === null || Number.isNaN(c) || c <= 0) { bad.add(k); continue; }
      const cur = cells[k]?.[0] ?? null;
      if (cur === null) entries.push({ branch, date, cents: c });
      else if (cur !== c) fixes.push({ branch, date, cents: c });
    }
    return { entries, fixes, zero, bad };
  }, [typed, marks, cells]);

  // Running totals use what is recorded plus what is typed but not saved yet (shown in italics).
  const valueOf = (b: string, d: string) => {
    const t = typed[key(b, d)];
    if (t?.trim() && typedMark(t)) return { cents: 0, draft: true };
    const c = t?.trim() ? readMoney(t) : null;
    if (c !== null && !Number.isNaN(c) && c > 0) return { cents: c, draft: true };
    const c0 = cells[key(b, d)];
    return { cents: c0?.[0] ?? autoOf(c0) ?? 0, draft: false };
  };
  let running = 0;
  const rows = dates.map((d) => {
    const vals = branches.map((b) => valueOf(b.id, d));
    const day = vals.reduce((s, v) => s + v.cents, 0);
    running += day;
    return { d, vals, day, running, draft: vals.some((v) => v.draft) };
  });
  const colTotals = branches.map((b) => dates.reduce((s, d) => s + valueOf(b.id, d).cents, 0));
  // Daily average: days with sales plus Zero sales days (as ₱0). Closed days and empty days are left out.
  const counts = (b: string, d: string) => {
    const k = key(b, d);
    if (valueOf(b, d).cents > 0) return true;
    const m = marks[k] ?? cells[k]?.[1] ?? (typed[k] ? typedMark(typed[k]) : null);
    return m === "NO_SALES";
  };
  const colDays = branches.map((b) => dates.filter((d) => counts(b.id, d)).length);
  const allDays = dates.filter((d) => branches.some((b) => counts(b.id, d))).length;
  const grand = colTotals.reduce((s, x) => s + x, 0);
  const avg = (total: number, n: number) => (n ? php(Math.round(total / n / 100) * 100) : "–");
  const pending = parsed.entries.length + parsed.fixes.length + parsed.zero.length;

  function trySave() {
    if (parsed.bad.size) { setMsg({ ok: false, text: "Some cells aren't amounts. They're outlined in red." }); return; }
    if (parsed.fixes.length > 0 && reason.trim().length < 8) {
      setMsg({ ok: false, text: "Write why you're changing recorded days (at least 8 characters)." }); return;
    }
    // Every save asks first: it notifies the other management members (owner request).
    setMsg(null); setConfirming(true);
  }

  async function save() {
    setConfirming(false);
    if (parsed.bad.size) { setMsg({ ok: false, text: "Some cells aren't amounts. They're outlined in red." }); return; }
    setBusy(true); setMsg(null);
    const r = await saveGrid({ entries: parsed.entries, fixes: parsed.fixes, marks: parsed.zero, reason });
    setBusy(false);
    const names = Object.fromEntries(branches.map((b) => [b.id, b.name]));
    const failedKeys = new Set(r.failed.map((f) => key(f.branch, f.date)));
    setTyped((t) => Object.fromEntries(Object.entries(t).filter(([k]) => failedKeys.has(k))));
    setMarks((m) => Object.fromEntries(Object.entries(m).filter(([k]) => failedKeys.has(k))) as Record<string, Mark>);
    if (r.failed.length === 0) { setReason(""); setEditing(false); }
    setMsg({
      ok: r.ok,
      text: [r.saved && `${r.saved} saved`, r.waiting && `${r.waiting} waiting for sign-off`].filter(Boolean).join(", ") || (r.ok ? "Nothing to save" : "Not saved"),
      failed: r.failed.map((f) => (f.date ? `${names[f.branch] ?? ""} ${f.date}: ${f.error}` : f.error)),
    });
    router.refresh();
  }

  return (
    <div className="month-grid">
      <div className="grid-tools">
        <label className="check-inline"><input type="checkbox" checked={editing} onChange={(e) => setEditing(e.target.checked)} /> Change recorded days</label>
        {msg && <span className={msg.ok ? "saved-tick" : "field-error"}>{msg.text}</span>}
        <ShareDay dates={dates} branches={branches} today={today}
          cellOf={(b, d) => { const c = cells[key(b, d)]; return c ? { cents: c[0] ?? autoOf(c), mark: autoOf(c) !== null ? null : c[1], staged: c[2] } : undefined; }} />
      </div>
      <div className="table-wrap">
        <table className="tracker">
          <thead>
            <tr><th>Date</th>{branches.map((b) => <th key={b.id} className="num">{b.name.replace(/ \(.*\)$/, "")}</th>)}<th className="num">Day total</th><th className="num">Running total</th></tr>
          </thead>
          <tbody>
            {rows.map(({ d, day, running: run, draft }) => (
              <tr key={d} className={d === today ? "today" : undefined}>
                <th scope="row">{label(d)}{d === today && <span className="small muted"> today</span>}</th>
                {branches.map((b) => {
                  const k = key(b.id, d);
                  const c = cells[k];
                  const rec = c?.[0] ?? null, mark = c?.[1] ?? null, staged = c?.[2] ?? false, service = c?.[3] ?? null, fixing = c?.[4] ?? false;
                  const auto = autoOf(c), pend = c?.[5] ?? null;
                  const flag = rec !== null && service !== null && rec !== service;
                  const canType = b.can_enter && !mark && !staged && !fixing && ((rec === null && auto === null) || editing);
                  const pendNote = pend ? <span className="cell-pend" title="Logged in the Service log, waiting for sign-off">+{php(pend)} waiting</span> : null;
                  if (canType && rec === null && marks[k]) {
                    return (
                      <td key={k} data-cell={k} className={`num cell-input ${hl.has(k) ? "hl" : ""}`}>
                        <span className="cell-mark draft">{MARK_LABEL[marks[k]]}
                          <button type="button" className="cell-undo" aria-label={`Undo ${MARK_LABEL[marks[k]]} for ${b.name} ${d}`}
                            onClick={() => setMarks((m) => { const n = { ...m }; delete n[k]; return n; })}>×</button>
                        </span>
                      </td>
                    );
                  }
                  if (canType) {
                    return (
                      <td key={k} data-cell={k} className={`num cell-input ${parsed.bad.has(k) ? "bad" : ""} ${rec !== null ? "editing" : ""} ${hl.has(k) ? "hl" : ""}`}>
                        <span className="cell-entry">
                          <input inputMode="decimal" aria-label={`${b.name} ${d}`} placeholder={rec !== null ? php(rec) : auto !== null ? php(auto) : ""}
                            value={typed[k] ?? ""} onChange={(e) => setTyped((t) => ({ ...t, [k]: e.target.value }))}
                            onBlur={(e) => {
                              const tm = rec === null ? typedMark(e.target.value) : null;
                              if (tm) { setMarks((m) => ({ ...m, [k]: tm })); setTyped((t) => { const n = { ...t }; delete n[k]; return n; }); }
                            }}
                            onKeyDown={(e) => { if (e.key === "Enter" && pending) { e.preventDefault(); trySave(); } }} />
                          {rec !== null && (
                            <select className="cell-kind" aria-label={`${b.name} ${d}: change to zero sales`} value=""
                              onChange={(e) => { if (e.target.value === "NO_SALES") setTyped((t) => ({ ...t, [k]: "0" })); }}>
                              <option value="" disabled hidden>▾</option>
                              <option value="NO_SALES">Change to Zero sales</option>
                            </select>
                          )}
                          {rec === null && (
                            <select className="cell-kind" aria-label={`${b.name} ${d}: zero sales, closed or enter sales`} value=""
                              onChange={(e) => {
                                const v = e.target.value as Mark | "AMOUNT";
                                if (v === "AMOUNT") { (e.target.previousElementSibling as HTMLInputElement | null)?.focus(); return; }
                                setMarks((m) => ({ ...m, [k]: v }));
                                setTyped((t) => { const n = { ...t }; delete n[k]; return n; });
                              }}>
                              <option value="" disabled hidden>▾</option>
                              <option value="NO_SALES">Zero sales</option>
                              <option value="CLOSED">Closed</option>
                              <option value="AMOUNT">Enter sales</option>
                            </select>
                          )}
                        </span>
                        {pendNote}
                      </td>
                    );
                  }
                  return (
                    <td key={k} data-cell={k} className={`num ${rec === null && auto === null && !mark && !staged && d < today ? "gap" : ""} ${hl.has(k) ? "hl" : ""}`}
                      title={flag ? `Approved service log: ${php(service!)}` : auto !== null ? `From approved Service log entries${mark ? ` (was marked ${mark === "CLOSED" ? "Closed" : "Zero sales"})` : ""}` : fixing ? "Correction waiting for sign-off" : undefined}>
                      {rec !== null ? php(rec) : auto !== null ? <span className="cell-auto">{php(auto)}</span> : mark ? <span className="cell-mark">{mark === "CLOSED" ? "Closed" : "Zero sales"}</span> : staged ? "Waiting" : "–"}
                      {pendNote}
                      {flag && <span className="flag" aria-label="differs from the service log"> •</span>}
                      {fixing && <span className="flag"> ✎</span>}
                      {changedSet.has(k) && !fixing && <span className="changed-mark" title="Changed before"> ↺</span>}
                    </td>
                  );
                })}
                <td className={`num ${draft ? "draft" : ""}`}>{day ? php(day) : "–"}</td>
                <td className={`num strong ${draft ? "draft" : ""}`}>{php(run)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th scope="row">Month total</th>{colTotals.map((t, i) => <td key={branches[i].id} className="num">{php(t)}</td>)}<td className="num" /><td className="num strong">{php(grand)}</td></tr>
            <tr className="avg-row"><th scope="row" title="Days with sales plus Zero sales days (as ₱0). Closed days and empty days are left out.">Daily average</th>
              {colTotals.map((t, i) => <td key={branches[i].id} className="num" title={`${colDays[i]} day${colDays[i] === 1 ? "" : "s"} counted`}>{avg(t, colDays[i])}</td>)}
              <td className="num" title={`${allDays} day${allDays === 1 ? "" : "s"} counted`}>{avg(grand, allDays)}</td><td className="num" /></tr>
          </tfoot>
        </table>
      </div>

      <div className={`save-bar ${pending ? "on" : ""}`}>
        {parsed.fixes.length > 0 && (
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
            placeholder={`Why change ${parsed.fixes.length} recorded day${parsed.fixes.length === 1 ? "" : "s"}? (required)`} />
        )}
        <button type="button" onClick={trySave} disabled={busy || pending === 0}>
          {busy ? "Saving…" : pending ? `Save ${pending} day${pending === 1 ? "" : "s"}` : "Type totals to save"}
        </button>
        {pending > 0 && <button type="button" className="secondary" onClick={() => { setTyped({}); setMarks({}); setMsg(null); }} disabled={busy}>Clear</button>}
        {msg && <span className={msg.ok ? "saved-tick" : "field-error"} role="status">{msg.text}</span>}
      </div>
      {confirming && (
        <div className="modal-back" role="presentation" onClick={() => setConfirming(false)}>
          <div className="modal card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="confirm-title">Are you sure?</h2>
            <p>This change will notify all other management members and will need confirmation from two people to change again.</p>
            {parsed.fixes.length > 0 && <p className="small">Changes to days already saved wait until a second person (an owner or the general manager) confirms them.</p>}
            <ul className="plain-list small">
              {parsed.entries.map((e) => (
                <li key={key(e.branch, e.date)}><span><strong>{branches.find((b) => b.id === e.branch)?.name ?? ""}</strong>, {label(e.date)}: <strong>{php(e.cents)}</strong></span></li>
              ))}
              {parsed.zero.map((z) => (
                <li key={key(z.branch, z.date)}><span><strong>{branches.find((b) => b.id === z.branch)?.name ?? ""}</strong>, {label(z.date)}: <strong>{MARK_LABEL[z.status]}</strong></span></li>
              ))}
              {parsed.fixes.map((f) => {
                const name = branches.find((b) => b.id === f.branch)?.name ?? "";
                const old = cells[key(f.branch, f.date)]?.[0] ?? 0;
                return (
                  <li key={key(f.branch, f.date)}><span><strong>{name}</strong>, {label(f.date)}: {php(old)} → <strong>{f.cents === 0 ? "Zero sales (₱0)" : php(f.cents)}</strong>
                    <span className="muted"> · waits for a second person</span></span></li>
                );
              })}
            </ul>
            {parsed.fixes.length > 0 && <p className="small muted">Reason: {reason.trim()}</p>}
            <div className="row-buttons">
              <button type="button" onClick={save} autoFocus>Yes, save {pending === 1 ? "it" : `all ${pending}`}</button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {msg?.failed && msg.failed.length > 0 && <div className="notice error"><ul className="plain">{msg.failed.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
    </div>
  );
}
