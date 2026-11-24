"use client";
import { useState } from "react";
import { centsToPhp, csvRows } from "@/lib/csv";
import { compareWithOs, readSheet, readXlsx, type Check, type Existing, type TrackerSheet } from "@/lib/tracker";
import { addDays, daysBetween } from "@/lib/insights";
import { correctFromUpload, existingDays, loadDays } from "../daily/actions";

type Branch = { id: string; code: string; name: string; can_enter: boolean; self_publish: boolean };
type Result = { sheet: TrackerSheet; check: Check; branch: Branch | null };
const ERR: Record<string, string> = {
  ROWS_REJECTED: "Some days changed since the check. Check the file again.",
  FORBIDDEN: "You can't enter sales for this branch.",
  REASON_REQUIRED: "Give a reason of at least 8 characters.",
  CORRECTION_PENDING: "A correction is already waiting for that day.",
};
const sumOf = (rows: { cents: number }[]) => rows.reduce((s, r) => s + r.cents, 0);

export function TrackerUpload({ today }: { today: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");

  async function check(f: File) {
    setError(null); setResults(null); setLog([]); setPick(new Set()); setFile(f.name);
    setBusy("Reading the file…");
    try {
      let tabs: { name: string; grid: (string | number | null)[][] }[];
      if (/\.xlsx$/i.test(f.name)) tabs = readXlsx(new Uint8Array(await f.arrayBuffer()));
      else if (/\.csv$/i.test(f.name)) tabs = [{ name: f.name.replace(/\.csv$/i, ""), grid: csvRows(await f.text()) }];
      else throw new Error("Choose the .xlsx (or .csv) you downloaded from Google Sheets.");
      const sheets = tabs.map((t) => readSheet(t.name, t.grid));
      const usable = sheets.filter((s) => s.isBranchTab);
      setSkipped(sheets.filter((s) => !s.isBranchTab).map((s) => s.sheet));
      if (usable.length === 0) throw new Error("No branch tabs with DATE and Sales columns were found in this file.");
      const dates = usable.flatMap((s) => s.rows.map((r) => r.date)).sort();
      if (dates.length === 0) throw new Error("The branch tabs have no sales amounts.");
      setBusy("Comparing with what the OS already has…");
      // The OS answers at most ~800 days per question; ask in windows.
      const existing = new Map<string, Map<string, Existing>>();
      let branches: Branch[] = [];
      for (let s = dates[0]; s <= dates[dates.length - 1]; s = addDays(s, 700)) {
        const e = addDays(s, 699) < dates[dates.length - 1] ? addDays(s, 699) : dates[dates.length - 1];
        const r = await existingDays(s, e);
        if (!r.ok) throw new Error(r.error === "NOT_AUTHENTICATED" ? "Please sign in again." : "Daily sales isn't set up yet (update-0013).");
        branches = r.branches;
        for (const [b, d, cents, mark, staged] of r.days) {
          if (!existing.has(b)) existing.set(b, new Map());
          existing.get(b)!.set(d, { cents: cents === null ? null : Number(cents), mark, staged });
        }
        if (daysBetween(s, dates[dates.length - 1]) <= 700) break;
      }
      setResults(usable.map((sheet) => {
        const branch = branches.find((b) => b.code === sheet.branchCode) ?? null;
        return { sheet, branch, check: compareWithOs(sheet, existing.get(branch?.id ?? "") ?? new Map(), today) };
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setBusy(null);
    }
  }

  async function loadAll() {
    if (!results) return;
    const out: string[] = [];
    for (const r of results) {
      if (!r.branch?.can_enter || r.check.add.length === 0) continue;
      for (let i = 0; i < r.check.add.length; i += 400) {
        const part = r.check.add.slice(i, i + 400);
        setBusy(`Loading ${r.branch.name}…`);
        const res = await loadDays({ branch: r.branch.id, rows: part.map(({ date, cents }) => ({ date, cents })), file: file.slice(0, 120) });
        out.push(res.ok
          ? `${r.branch.name}: ${res.rows} day${res.rows === 1 ? "" : "s"} ${res.state === "PUBLISHED" ? "loaded" : "loaded, waiting for sign-off on Imports"}.`
          : `${r.branch.name}: not loaded. ${ERR[res.error] ?? res.error}${res.problems ? ` (${res.problems.slice(0, 3).map((p) => `${p.date} ${p.error}`).join(", ")})` : ""}`);
      }
    }
    setBusy(null);
    setLog(out.length ? out : ["Nothing new to load."]);
    setResults((rs) => rs && rs.map((r) => ({ ...r, check: { ...r.check, same: [...r.check.same, ...(r.branch?.can_enter ? r.check.add : [])], add: r.branch?.can_enter ? [] : r.check.add } })));
  }

  async function replacePicked() {
    if (!results) return;
    if (reason.trim().length < 8) { setError("Give a reason of at least 8 characters for the replacements."); return; }
    setError(null);
    const out: string[] = [];
    for (const r of results) {
      for (const d of r.check.different) {
        const key = `${r.sheet.sheet}|${d.date}`;
        if (!pick.has(key) || !r.branch) continue;
        setBusy(`Correcting ${r.branch.name} ${d.date}…`);
        const res = await correctFromUpload({ branch: r.branch.id, date: d.date, cents: d.cents, reason: reason.trim() });
        out.push(`${r.branch.name} ${d.date}: ${res.ok ? (res.state === "APPLIED" ? `now ${centsToPhp(d.cents)}` : "sent for sign-off") : `not changed (${ERR[res.error] ?? res.error})`}`);
      }
    }
    setBusy(null);
    setLog((l) => [...l, ...out]);
    setPick(new Set());
  }

  const toAdd = results?.reduce((s, r) => s + (r.branch?.can_enter ? r.check.add.length : 0), 0) ?? 0;

  return (
    <div className="upload-flow">
      <div className="card">
        <h2>1. Choose the file</h2>
        <p className="small muted">In Google Sheets: File, Download, Microsoft Excel (.xlsx). All branch tabs are read at once; other tabs are ignored. Nothing is saved until you press Load.</p>
        <input type="file" accept=".xlsx,.csv" onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} disabled={!!busy} />
        {busy && <p className="small"><span className="spinner" aria-hidden /> {busy}</p>}
        {error && <div className="notice error">{error}</div>}
      </div>

      {results && (
        <>
          <div className="card">
            <h2>2. Check results</h2>
            {skipped.length > 0 && <p className="small muted">Ignored tabs (not branch sales): {skipped.join(", ")}.</p>}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tab</th><th>Branch</th><th className="num">New days</th><th className="num">Already in OS</th><th className="num">Different</th><th className="num">Held back</th><th className="num">Problems</th></tr></thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.sheet.sheet}>
                      <td>{r.sheet.sheet}</td>
                      <td>{r.branch?.name ?? <span className="field-error">Unknown branch</span>}{r.branch && !r.branch.can_enter && <div className="small muted">view only</div>}</td>
                      <td className="num"><strong>{r.check.add.length}</strong>{r.check.add.length > 0 && <div className="small muted">{centsToPhp(sumOf(r.check.add))}</div>}</td>
                      <td className="num">{r.check.same.length}</td>
                      <td className="num">{r.check.different.length ? <span className="delta down">{r.check.different.length}</span> : 0}</td>
                      <td className="num">{r.check.blocked.length + r.sheet.closed.length}</td>
                      <td className="num">{r.sheet.problems.length ? <span className="delta down">{r.sheet.problems.length}</span> : <span className="saved-tick">✓</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {results.map((r) => (r.sheet.problems.length + r.check.blocked.length + r.sheet.closed.length > 0) && (
              <details key={r.sheet.sheet} className="check-detail">
                <summary><strong>{r.branch?.name ?? r.sheet.sheet}</strong>: {r.sheet.problems.length} problem{r.sheet.problems.length === 1 ? "" : "s"}, {r.check.blocked.length + r.sheet.closed.length} held back</summary>
                <ul className="small">
                  {r.sheet.problems.map((p, i) => <li key={`p${i}`} className="field-error">Row {p.line}: {p.text}</li>)}
                  {r.check.blocked.filter((b) => b.cents > 0 || !b.why.startsWith("₱0")).map((b) => <li key={`b${b.date}`}>{b.date} {centsToPhp(b.cents)}: {b.why}</li>)}
                  {(() => {
                    const zero = r.check.blocked.filter((b) => b.cents === 0 && b.why.startsWith("₱0")).map((b) => b.date);
                    return zero.length > 0 && <li>{zero.length} day{zero.length === 1 ? "" : "s"} with ₱0 ({zero.slice(0, 6).join(", ")}{zero.length > 6 ? ", …" : ""}). Days without sales aren&apos;t loaded as ₱0: mark them Closed or No sales on Missing days.</li>;
                  })()}
                  {r.sheet.closed.length > 0 && <li>{r.sheet.closed.length} day{r.sheet.closed.length === 1 ? "" : "s"} typed as CLOSED ({r.sheet.closed.slice(0, 5).map((c) => c.date).join(", ")}{r.sheet.closed.length > 5 ? "…" : ""}). Mark these on Missing days.</li>}
                </ul>
              </details>
            ))}
            <p className="small muted">Problems and held-back days are never loaded. Fix them in the sheet and upload again, or enter them on Daily sales.</p>
          </div>

          <div className="card">
            <h2>3. Load the new days</h2>
            <p className="small">{toAdd > 0 ? `${toAdd} new day${toAdd === 1 ? "" : "s"} will be added. Days already in the OS are left alone.` : "There are no new days to add."}</p>
            <button type="button" onClick={loadAll} disabled={!!busy || toAdd === 0}>Load {toAdd} new day{toAdd === 1 ? "" : "s"}</button>
          </div>

          {results.some((r) => r.check.different.length > 0) && (
            <div className="card">
              <h2>4. Days where the file and the OS differ</h2>
              <p className="small muted">These are left as they are unless you tick them. Ticked days are replaced with the file&apos;s amount as a correction, with your reason{results.some((r) => r.branch && !r.branch.self_publish) ? ". Corrections need a second person once sign-off is on" : ""}.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th></th><th>Branch</th><th>Date</th><th className="num">In the OS</th><th className="num">In the file</th><th className="num">Difference</th></tr></thead>
                  <tbody>
                    {results.flatMap((r) => r.check.different.map((d) => {
                      const key = `${r.sheet.sheet}|${d.date}`;
                      return (
                        <tr key={key}>
                          <td><input type="checkbox" aria-label={`Replace ${d.date}`} disabled={!r.branch?.can_enter} checked={pick.has(key)}
                            onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(key); else n.delete(key); return n; })} /></td>
                          <td>{r.branch?.name}</td><td>{d.date}</td>
                          <td className="num">{centsToPhp(d.osCents)}</td><td className="num">{centsToPhp(d.cents)}</td>
                          <td className="num">{d.cents > d.osCents ? "+" : "−"}{centsToPhp(Math.abs(d.cents - d.osCents))}</td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
              <div className="row-buttons" style={{ marginTop: 12 }}>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. Sheet updated after recount" maxLength={500} style={{ flex: "1 1 260px" }} />
                <button type="button" onClick={replacePicked} disabled={!!busy || pick.size === 0}>Replace {pick.size} ticked day{pick.size === 1 ? "" : "s"}</button>
              </div>
            </div>
          )}

          {log.length > 0 && <div className="notice ok"><ul className="plain">{log.map((l, i) => <li key={i}>{l}</li>)}</ul></div>}
        </>
      )}
    </div>
  );
}
