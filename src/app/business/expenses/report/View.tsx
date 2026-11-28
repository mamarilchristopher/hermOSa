// Expense report view (v0.102.4, format A "One-page summary", CHRIS Nov 28 2026): the period/branch controls and the
// paper-like sheet. Server-safe; the download buttons are a small client component.
import Link from "next/link";
import { ControlBar, PeriodNav, Tabs } from "@/components/Controls";
import { centsToPhp } from "@/lib/csv";
import { dayLabel } from "@/lib/homeGlance";
import { currentAt, rangeLabel, reportCsv, type Period, type PeriodKind, type Report } from "@/lib/expenseReport";
import { ReportActions } from "./Actions";

type Q = { period?: string; at?: string; from?: string; to?: string; branch?: string };
const php = (c: number) => centsToPhp(Math.round(c / 100) * 100).replace(/\.00$/, "");
const chg = (cur: number, prev: number) => {
  if (!prev) return cur ? "new" : "";
  const r = Math.round(((cur - prev) / prev) * 100);
  return `${r >= 0 ? "▲" : "▼"} ${Math.abs(r)}%`;
};
const pct = (m: number | null) => (m === null ? "—" : `${Math.round(m * 100)}%`);
const KINDS: { key: PeriodKind; label: string }[] = [
  { key: "month", label: "Month" }, { key: "cutoff", label: "Cutoff" }, { key: "quarter", label: "Quarter" }, { key: "year", label: "Year" }, { key: "custom", label: "Custom" },
];

export type ReportViewProps = {
  per: Period; rep: Report; today: string; scopeKey: string; scopeLabel: string; placeName: string; by: string; stamp: string;
  tabs: { key: string; label: string }[];
};

export function ReportView({ per, rep, today, scopeKey, scopeLabel, placeName, by, stamp, tabs }: ReportViewProps) {
  const scope = scopeKey === "" ? null : scopeKey;
  const q = (o: Partial<Q>) => {
    const s = new URLSearchParams();
    const period = o.period ?? per.kind;
    if (period !== "month") s.set("period", period);
    if (period === "custom") { s.set("from", o.from ?? per.from); s.set("to", o.to ?? per.to); }
    else {
      const k = period as Exclude<PeriodKind, "custom">;
      const at = o.at ?? (period !== per.kind ? currentAt(k, today) : per.at);
      if (at !== currentAt(k, today)) s.set("at", at);
    }
    const b = o.branch ?? scopeKey;
    if (b) s.set("branch", b);
    const t = s.toString();
    return `/business/expenses/report${t ? `?${t}` : ""}`;
  };
  const title = `Expense report · ${per.label}`;
  const range = `${rangeLabel(per.from, per.upTo)}${per.partial ? " (so far)" : ""}`;
  const vs = per.prevLabel;
  const file = `Hermosa expense report ${per.kind === "custom" ? `${per.from} to ${per.to}` : per.label.replace(/[()]/g, "")}${scopeKey ? ` ${scopeKey === "company" ? "Company-wide" : placeName}` : ""}`;
  const csv = reportCsv(rep, title, `${scopeLabel} · ${range}`, vs);
  const kpis: { label: string; value: string; note: string }[] = rep.sales === null
    ? [
      { label: "Company-wide costs", value: php(rep.spent), note: `${chg(rep.spent, rep.prevSpent)} vs ${vs}` },
      { label: "Entries", value: String(rep.entries), note: `${rep.receipts} with a receipt` },
    ]
    : [
      { label: "Sales", value: php(rep.sales), note: rep.prevSales ? `${chg(rep.sales, rep.prevSales)} vs ${vs}` : "" },
      { label: "Expenses", value: php(rep.spent), note: rep.prevSpent ? `${chg(rep.spent, rep.prevSpent)} vs ${vs}` : "" },
      { label: "Left (profit)", value: php(rep.left!), note: "after all costs" },
      { label: "Margin", value: pct(rep.margin), note: rep.prevMargin !== null ? `${vs}: ${pct(rep.prevMargin)}` : "" },
    ];


return (
    <main>
      <div className="no-print">
        <div className="title-row tdy-title">
          <h1>Expense report</h1>
          <Link className="button secondary small" href={`/business/expenses${per.kind === "month" && per.at !== today.slice(0, 7) ? `?month=${per.at}` : ""}`}>← Expenses</Link>
        </div>
        <p className="muted small">Pick the period and branch, then download it as a PDF to print or send, or as Excel for the accountant.</p>
        <ControlBar>
          <Tabs tabs={tabs.map((t) => ({ href: q({ branch: t.key }), label: t.label, on: t.key === scopeKey }))} />
          {per.kind === "custom" ? (
            <form className="xr-custom" method="get" action="/business/expenses/report">
              <input type="hidden" name="period" value="custom" />
              {scopeKey && <input type="hidden" name="branch" value={scopeKey} />}
              <label>From <input type="date" name="from" defaultValue={per.from} max={today} /></label>
              <label>To <input type="date" name="to" defaultValue={per.to} max={today} /></label>
              <button type="submit" className="small">Show</button>
            </form>
          ) : (
            <PeriodNav prev={q({ at: per.prevAt! })} next={per.nextAt ? q({ at: per.nextAt }) : null} label={per.label}
              reset={per.nextAt ? { href: q({ at: currentAt(per.kind, today) }), label: "Latest" } : null} />
          )}
        </ControlBar>
        <div className="xr-bar">
          <div className="segmented" role="tablist" aria-label="Period">
            {KINDS.map((k) => <Link key={k.key} href={q({ period: k.key, at: undefined })} role="tab" aria-selected={k.key === per.kind} className={k.key === per.kind ? "on" : ""}>{k.label}</Link>)}
          </div>
          <ReportActions csv={csv} file={file} />
        </div>
      </div>

      <article className="xr-doc">
        <header className="xr-head">
          <div>
            <h1>{title}</h1>
            <div className="xr-meta">{scopeLabel} · {range} · compared with {vs}</div>
          </div>
          <img src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" className="xr-logo" />
        </header>

        <div className={`xr-kpis n${kpis.length}`}>
          {kpis.map((k) => <div key={k.label} className="xr-kpi"><span>{k.label}</span><b>{k.value}</b><i>{k.note}</i></div>)}
        </div>

        <h2>Where the money went</h2>
        {rep.groups.length === 0 ? <p className="xr-empty">No expenses for this period yet.</p> : (
          <div className="xr-scroll">
            <table className="xr-table">
              <thead><tr><th>Category</th><th className="n">This period</th><th className="n xr-ph-hide">{vs}</th><th className="n">Change</th><th className="xr-share-col">Share</th></tr></thead>
              <tbody>
                {rep.groups.map((g) => [
                  ...g.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td><td className="n">{php(r.cents)}</td><td className="n xr-ph-hide">{php(r.prev)}</td><td className="n">{chg(r.cents, r.prev)}</td>
                      <td className="xr-share-col"><span className="xr-bar-fill" style={{ width: `${rep.spent ? (r.cents / rep.spent) * 100 : 0}%` }} /><span className="xr-pct">{rep.spent ? Math.round((r.cents / rep.spent) * 100) : 0}%</span></td>
                    </tr>
                  )),
                  <tr key={`${g.key}-total`} className="sub"><td>{g.label} total</td><td className="n">{php(g.cents)}</td><td className="n xr-ph-hide">{php(g.prev)}</td><td className="n">{chg(g.cents, g.prev)}</td><td className="xr-share-col" /></tr>,
                ])}
                <tr className="tot"><td>Total expenses</td><td className="n">{php(rep.spent)}</td><td className="n xr-ph-hide">{php(rep.prevSpent)}</td><td className="n">{chg(rep.spent, rep.prevSpent)}</td><td className="xr-share-col" /></tr>
              </tbody>
            </table>
          </div>
        )}

        {rep.branches && (
          <>
            <h2>By branch</h2>
            <div className="xr-scroll">
              <table className="xr-table">
                <thead><tr><th>Branch</th><th className="n">Sales</th><th className="n xr-ph-hide">Own costs</th><th className="n xr-ph-hide">Share of company-wide</th><th className="n">Left</th><th className="n">Margin</th></tr></thead>
                <tbody>
                  {rep.branches.map((x) => (
                    <tr key={x.id}><td>{x.name}</td><td className="n">{php(x.sales)}</td><td className="n xr-ph-hide">{php(x.own)}</td><td className="n xr-ph-hide">{php(x.shared)}</td><td className="n">{php(x.left)}</td><td className="n">{pct(x.margin)}</td></tr>
                  ))}
                  <tr className="tot"><td>All branches</td><td className="n">{php(rep.sales ?? 0)}</td><td className="n xr-ph-hide">{php(rep.spent - rep.shared)}</td><td className="n xr-ph-hide">{php(rep.shared)}</td><td className="n">{php(rep.left ?? 0)}</td><td className="n">{pct(rep.margin)}</td></tr>
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="xr-note">
          {scope !== "company" && "Company-wide costs (HQ staff, software, accountant and the like) are split by each branch's share of sales. Sales from Nov 25, 2026 are approved Service log entries. "}
          Salaries come from final payroll cutoffs{rep.hasAds ? `, and Meta ad spend from Windsor${rep.adsThrough ? ` through ${dayLabel(rep.adsThrough)}` : ""}` : ""}. {rep.entries} typed {rep.entries === 1 ? "entry" : "entries"}, {rep.receipts} with a receipt photo.
        </p>

        <div className="xr-sign"><div>Prepared by</div><div>Checked by (GM)</div><div>Approved by (Owner)</div></div>
        <footer className="xr-foot"><span>Hermosa OS · Generated {stamp} by {by}</span>{rep.hasAds && <span>* Meta ad spend with 12% VAT</span>}</footer>
      </article>
    </main>
);
}
