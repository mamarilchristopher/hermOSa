"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { centsToPhp } from "@/lib/csv";
import { readMoney } from "@/lib/tracker";
import { saveGrid } from "./actions";

export type GridBranch = { id: string; name: string; can_enter: boolean };
/** [recorded cents | null, mark | null, waiting sign-off, service log cents | null, correction pending] */
export type GridCell = [number | null, string | null, boolean, number | null, boolean];

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const label = (d: string) => `${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${Number(d.slice(8))}`;
const php = (c: number) => centsToPhp(c).replace(/\.00$/, "");

/** The Sales Source Tracker, inside the OS: one row per day, one column per branch, type and save. */
export function MonthGrid({ dates, branches, cells, today }: {
  dates: string[]; branches: GridBranch[]; cells: Record<string, GridCell>; today: string;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; failed?: string[] } | null>(null);

  const key = (b: string, d: string) => `${b}|${d}`;
  const parsed = useMemo(() => {
    const entries: { branch: string; date: string; cents: number }[] = [];
    const fixes: { branch: string; date: string; cents: number }[] = [];
    const bad = new Set<string>();
    for (const [k, v] of Object.entries(typed)) {
      if (!v.trim()) continue;
      const [branch, date] = k.split("|");
      const c = readMoney(v);
      if (c === null || Number.isNaN(c) || c <= 0) { bad.add(k); continue; }
      const cur = cells[k]?.[0] ?? null;
      if (cur === null) entries.push({ branch, date, cents: c });
      else if (cur !== c) fixes.push({ branch, date, cents: c });
    }
    return { entries, fixes, bad };
  }, [typed, cells]);

  // Running totals use what is recorded plus what is typed but not saved yet (shown in italics).
  const valueOf = (b: string, d: string) => {
    const t = typed[key(b, d)];
    const c = t?.trim() ? readMoney(t) : null;
    if (c !== null && !Number.isNaN(c) && c > 0) return { cents: c, draft: true };
    return { cents: cells[key(b, d)]?.[0] ?? 0, draft: false };
  };
  let running = 0;
  const rows = dates.map((d) => {
    const vals = branches.map((b) => valueOf(b.id, d));
    const day = vals.reduce((s, v) => s + v.cents, 0);
    running += day;
    return { d, vals, day, running, draft: vals.some((v) => v.draft) };
  });
  const colTotals = branches.map((b) => dates.reduce((s, d) => s + valueOf(b.id, d).cents, 0));
  const pending = parsed.entries.length + parsed.fixes.length;

  async function save() {
    if (parsed.bad.size) { setMsg({ ok: false, text: "Some cells aren't amounts. They're outlined in red." }); return; }
    setBusy(true); setMsg(null);
    const r = await saveGrid({ entries: parsed.entries, fixes: parsed.fixes, reason });
    setBusy(false);
    const names = Object.fromEntries(branches.map((b) => [b.id, b.name]));
    const failedKeys = new Set(r.failed.map((f) => key(f.branch, f.date)));
    setTyped((t) => Object.fromEntries(Object.entries(t).filter(([k]) => failedKeys.has(k))));
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
                  const flag = rec !== null && service !== null && rec !== service;
                  const canType = b.can_enter && !mark && !staged && !fixing && (rec === null || editing);
                  if (canType) {
                    return (
                      <td key={k} className={`num cell-input ${parsed.bad.has(k) ? "bad" : ""} ${rec !== null ? "editing" : ""}`}>
                        <input inputMode="decimal" aria-label={`${b.name} ${d}`} placeholder={rec !== null ? php(rec) : ""}
                          value={typed[k] ?? ""} onChange={(e) => setTyped((t) => ({ ...t, [k]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter" && pending) { e.preventDefault(); save(); } }} />
                      </td>
                    );
                  }
                  return (
                    <td key={k} className={`num ${rec === null && !mark && !staged && d < today ? "gap" : ""}`}
                      title={flag ? `Service log: ${php(service!)}` : fixing ? "Correction waiting for sign-off" : undefined}>
                      {rec !== null ? php(rec) : mark ? (mark === "CLOSED" ? "Closed" : "No sales") : staged ? "Waiting" : "–"}
                      {flag && <span className="flag" aria-label="differs from the service log"> •</span>}
                      {fixing && <span className="flag"> ✎</span>}
                    </td>
                  );
                })}
                <td className={`num ${draft ? "draft" : ""}`}>{day ? php(day) : "–"}</td>
                <td className={`num strong ${draft ? "draft" : ""}`}>{php(run)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th scope="row">Month total</th>{colTotals.map((t, i) => <td key={branches[i].id} className="num">{php(t)}</td>)}<td className="num" /><td className="num strong">{php(colTotals.reduce((s, x) => s + x, 0))}</td></tr>
          </tfoot>
        </table>
      </div>

      <div className={`save-bar ${pending ? "on" : ""}`}>
        {parsed.fixes.length > 0 && (
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
            placeholder={`Why change ${parsed.fixes.length} recorded day${parsed.fixes.length === 1 ? "" : "s"}? (required)`} />
        )}
        <button type="button" onClick={save} disabled={busy || pending === 0}>
          {busy ? "Saving…" : pending ? `Save ${pending} day${pending === 1 ? "" : "s"}` : "Type totals to save"}
        </button>
        {pending > 0 && <button type="button" className="secondary" onClick={() => { setTyped({}); setMsg(null); }} disabled={busy}>Clear</button>}
      </div>
      {msg?.failed && msg.failed.length > 0 && <div className="notice error"><ul className="plain">{msg.failed.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
    </div>
  );
}
