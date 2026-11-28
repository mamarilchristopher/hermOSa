// Expenses dashboard (CHRIS Nov 28, option A "Profit board"): money out next to sales, bills still to enter as action
// cards, where the money goes, per-branch profit, then every entry. Server-safe (the forms inside are client components).
import Link from "next/link";
import { AddPanel, ControlBar, PeriodNav, Stat, Stats, Tabs } from "@/components/Controls";
import { centsToPhp } from "@/lib/csv";
import { monthLabel } from "@/lib/insights";
import { dayLabel } from "@/lib/homeGlance";
import { shiftMonth, type Category, type Dashboard, type Line } from "@/lib/expenses";
import { ExpenseForm, RemoveExpense, type BranchOpt, type CatOpt, type Prefill } from "./Forms";
import { saveCategory } from "./actions";
import { IconReceipt } from "@/components/Icons";

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** On All branches, one line per automatic item (a payroll cutoff, the month's ads) with the branches in its note. */
function grouped(lines: Line[], bName: Record<string, string>, php: (c: number) => string): Line[] {
  const out: Line[] = [];
  const at = new Map<string, number>();
  for (const l of lines) {
    if (!l.auto) { out.push(l); continue; }
    const k = `${l.auto}|${l.text}`;
    const i = at.get(k);
    const part = `${l.branch_id ? bName[l.branch_id] ?? "Branch" : "Company-wide"} ${php(l.cents)}`;
    if (i === undefined) { at.set(k, out.length); out.push({ ...l, key: `g-${l.key}`, sub: `${l.auto === "PAYROLL" ? "Auto from payroll" : l.sub.split(" · ")[0]} · ${part}` }); continue; }
    const g = out[i];
    out[i] = { ...g, cents: g.cents + l.cents, date: l.date > g.date ? l.date : g.date, sub: `${g.sub} · ${part}` };
  }
  return out;
}
const php = (c: number) => centsToPhp(Math.round(c / 100) * 100).replace(/\.00$/, "");
const pesoInput = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, "");
function Chg({ cur, prev, goodWhenUp }: { cur: number; prev: number; goodWhenUp: boolean }) {
  if (!prev) return null;
  const r = Math.round(((cur - prev) / prev) * 100);
  if (r === 0) return null;
  const up = r > 0;
  return <span className={`delta ${up === goodWhenUp ? "up" : "down"}`}>{up ? "▲" : "▼"} {Math.abs(r)}%</span>;
}

export type ViewProps = {
  ym: string; thisMonth: string; today: string; scope: string; scopeLabel: string; org: string;
  branches: BranchOpt[]; tabs: { key: string; label: string }[]; cats: Category[]; d: Dashboard; canManage: boolean; canCategories: boolean;
  receipts: Record<string, { path: string; url?: string }[]>; prefills: Record<string, Prefill>; catFilter: string | null; showCats: boolean;
  ok?: string; err?: string;
};

export function ExpensesView(p: ViewProps) {
  const { ym, thisMonth, today, scope, d } = p;
  const q = (o: { month?: string; branch?: string; cat?: string | null; cats?: boolean }) => {
    const s = new URLSearchParams();
    const m = o.month ?? ym, b = o.branch ?? scope, c = o.cat === undefined ? p.catFilter : o.cat;
    if (m !== thisMonth) s.set("month", m);
    if (b) s.set("branch", b);
    if (c) s.set("cat", c);
    if (o.cats) s.set("cats", "1");
    const t = s.toString();
    return `/business/expenses${t ? `?${t}` : ""}`;
  };
  const opts: CatOpt[] = p.cats.filter((c) => c.kind !== "AUTO" && c.active).map((c) => ({ id: c.id, name: c.name, grp: c.grp }));
  const form = (prefill: Prefill = {}, submit?: string) => (
    <ExpenseForm org={p.org} cats={opts} branches={p.branches} prefill={prefill} month={ym} scope={scope} today={today} submit={submit} />
  );
  const bName = Object.fromEntries(p.branches.map((b) => [b.id, b.name]));
  const maxCat = Math.max(1, ...d.cats.map((c) => Math.max(c.cents, c.prev)));
  const maxBranch = Math.max(1, ...d.branches.map((b) => Math.max(b.sales, b.spent)));
  const lines0 = p.catFilter ? d.lines.filter((l) => l.categoryId === p.catFilter) : d.lines;
  const lines = scope === "" ? grouped(lines0, bName, php) : lines0;
  const filterName = p.catFilter ? d.cats.find((c) => c.id === p.catFilter)?.name ?? "this category" : null;
  const expected = d.due.reduce((s, x) => s + x.expected, 0);
  const autoHref = (l: Line) => (l.auto === "PAYROLL" ? "/payroll" : "/business/ads");

  return (
    <main>
      <div className="title-row tdy-title">
        <h1>Expenses</h1>
        <div className="xr-actions">
          <Link className="button small" href={`/business/expenses/report${[ym !== thisMonth ? `at=${ym}` : "", scope ? `branch=${scope}` : ""].filter(Boolean).join("&").replace(/^(?=.)/, "?")}`}>Expense report</Link>
          {p.canCategories && <Link className="button secondary small" href={q({ cats: !p.showCats })}>{p.showCats ? "Close categories" : "Categories & budgets"}</Link>}
        </div>
      </div>
      <p className="muted small">Money out next to sales. Salaries come from final payroll cutoffs and Meta ad spend from Windsor by themselves; type the rest, with a receipt photo.</p>
      {p.ok && <div className="notice ok">{p.ok}</div>}
      {p.err && <div className="notice error">{p.err}</div>}

      <ControlBar>
        <Tabs tabs={p.tabs.map((t) => ({ href: q({ branch: t.key }), label: t.label, on: t.key === scope }))} />
        <PeriodNav prev={q({ month: shiftMonth(ym, -1) })} next={ym < thisMonth ? q({ month: shiftMonth(ym, 1) }) : null} label={monthLabel(ym)}
          reset={ym === thisMonth ? null : { href: q({ month: thisMonth }), label: "This month" }} prevLabel="Previous month" nextLabel="Next month" />
      </ControlBar>

      {p.canManage && <AddPanel title="Add expense" hint="Scan a receipt or screenshot, or type it" id="add">{form({ branch_id: scope === "company" ? null : scope ? p.branches.find((b) => b.code === scope)?.id : undefined })}</AddPanel>}

      {p.showCats && p.canCategories && <Categories cats={p.cats} month={ym} scope={scope} />}

      <Stats>
        <Stat hero label={`Spent${ym === thisMonth ? " so far" : ""}`} value={php(d.spent)}
          note={<><Chg cur={d.spent} prev={d.prevSpent} goodWhenUp={false} /> <span className="muted">vs {d.vsLabel}</span></>} />
        {d.sales !== null ? <Stat label="Sales" value={php(d.sales)} note={d.prevSales ? <><Chg cur={d.sales} prev={d.prevSales} goodWhenUp /> <span className="muted">vs {d.vsLabel}</span></> : undefined} />
          : <Stat label="Shared costs" value={php(d.spent)} note={<span className="muted">split across branches by sales</span>} />}
        {d.left !== null && <Stat label="Left after expenses" value={php(d.left)} tone={d.left < 0 ? "bad" : undefined}
          note={d.margin !== null ? <span className={`delta ${d.margin >= 0.3 ? "up" : "down"}`}>{Math.round(d.margin * 100)}% margin</span> : undefined} />}
        <Stat label="Bills not entered" value={d.due.length} tone={d.due.some((x) => x.overdue) ? "warn" : undefined}
          note={d.due.length ? <span className="muted">≈ {php(expected)} expected</span> : <span className="muted">{d.dueTotal ? `all ${d.dueTotal} monthly bills in` : "no monthly bills yet"}</span>} />
      </Stats>

      {d.due.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Due this month</h2><span className="small muted">Monthly bills from last month not entered yet</span></div>
          <div className="exp-due">
            {d.due.map((x) => (
              <div key={`${x.categoryId}|${x.branch_id}`} className={`exp-due-card${x.overdue ? " late" : ""}`}>
                <span className="small muted">{x.branch_id ? bName[x.branch_id] ?? "Branch" : "Company-wide"} · {x.overdue ? (ym === thisMonth ? `was due ${monthLabel(ym).split(" ")[0]} ${x.day}` : "not entered") : `due ${monthLabel(ym).split(" ")[0]} ${x.day}`}</span>
                <strong>{x.category}</strong>
                <span className="exp-due-amt">≈ {php(x.expected)}</span>
                {p.canManage && (
                  <details className="exp-quick">
                    <summary className="button small">Add {php(x.expected)}</summary>
                    {form({ category_id: x.categoryId, branch_id: x.branch_id, amount: pesoInput(x.expected), description: x.lastText.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/, LONG[Number(ym.slice(5, 7)) - 1]), payee: x.payee,
                      spent_on: ym === thisMonth ? today : `${ym}-${String(x.day).padStart(2, "0")}` }, "Add bill")}
                  </details>
                )}
              </div>
            ))}
            {d.dueDone > 0 && <div className="exp-due-card done"><span className="small muted">Done</span><strong>{d.dueDone} of {d.dueTotal} bills in</strong><span className="exp-due-amt">✓</span></div>}
          </div>
        </div>
      )}

      <div className={scope === "" ? "exp-two" : ""}>
        <div className="card">
          <div className="card-head"><h2>Where the money goes</h2><span className="small muted">vs {d.vsLabel} · tap one for its entries</span></div>
          {d.cats.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing entered for {monthLabel(ym)} yet.</p> : d.cats.map((c) => (
            <Link key={c.id} href={q({ cat: p.catFilter === c.id ? null : c.id })} className={`exp-cat${p.catFilter === c.id ? " on" : ""}`}>
              <span className="exp-cat-name">{c.name}{c.auto && <span className="exp-tag">auto</span>}</span>
              <span className="exp-bar"><i className={c.auto ? "auto" : ""} style={{ width: `${(c.cents / maxCat) * 100}%` }} />
                {c.budget ? <b title={`Budget ${php(c.budget)}`} style={{ left: `${Math.min(100, (c.budget / maxCat) * 100)}%` }} /> : null}</span>
              <span className="num exp-cat-amt">{php(c.cents)}</span>
              <span className="exp-cat-chg">{c.budget && c.cents > c.budget ? <span className="delta down">over budget</span> : <Chg cur={c.cents} prev={c.prev} goodWhenUp={false} />}</span>
            </Link>
          ))}
          <p className="small muted" style={{ margin: "10px 0 0" }}>* with 12% VAT · auto = filled by the app{d.adsThrough ? ` · ads through ${dayLabel(d.adsThrough)}` : ""}</p>
        </div>
        {scope === "" && (
          <div className="card">
            <div className="card-head"><h2>Per branch</h2><span className="small muted">left after expenses</span></div>
            {d.branches.map((b) => (
              <Link key={b.id} href={q({ branch: p.tabs.find((t) => t.label === b.name)?.key ?? "" })} className="exp-branch">
                <strong>{b.name}</strong>
                <span className="exp-pair"><i className="s" style={{ width: `${(b.sales / maxBranch) * 100}%` }} /><i className="e" style={{ width: `${(b.spent / maxBranch) * 100}%` }} /></span>
                <span className="num">{php(b.left)}{b.margin !== null && <><br /><span className={`delta ${b.margin >= 0.3 ? "up" : "down"}`}>{Math.round(b.margin * 100)}%</span></>}</span>
              </Link>
            ))}
            <p className="exp-legend small muted"><span><i className="s" /> Sales</span><span><i className="e" /> Expenses</span><span>Company-wide costs split by sales</span></p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>{filterName ? `${filterName}, ${monthLabel(ym)}` : `Entries, ${monthLabel(ym)}`}</h2>
          {filterName ? <Link className="small" href={q({ cat: null })}>Show all ×</Link> : <span className="small muted">{lines.length} line{lines.length === 1 ? "" : "s"}</span>}</div>
        {lines.length === 0 ? <p className="muted" style={{ margin: 0 }}>No entries.</p> : (
          <ul className="plain-list exp-lines">
            {lines.map((l) => (
              <li key={l.key} className="exp-line">
                <span className="exp-date muted">{dayLabel(l.date).split(", ")[1]}</span>
                <span className="exp-what"><strong>{l.text}</strong><span className="small muted">{l.sub}</span></span>
                <span className="num exp-amt">{php(l.cents)}</span>
                <span className="exp-acts">
                  {l.auto ? <Link className="small" href={autoHref(l)}>{l.auto === "PAYROLL" ? "Payroll →" : "Ads →"}</Link> : (
                    <>
                      {(p.receipts[l.id!] ?? []).filter((r) => r.url).map((r, i) => (
                        <a key={r.path} className="small exp-receipt" href={r.url} {...(r.path.endsWith(".pdf") ? { target: "_blank", rel: "noreferrer", "data-newtab": "" } : {})}><IconReceipt className="ic-lead" />{i === 0 ? "Receipt" : i + 1}</a>
                      ))}
                      {p.canManage && p.prefills[l.id!] && (
                        <details className="exp-edit">
                          <summary className="small">Edit</summary>
                          <div className="exp-edit-body">
                            {form(p.prefills[l.id!], "Save changes")}
                            <RemoveExpense id={l.id!} month={ym} scope={scope} />
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

const GRP = [["FIXED", "Monthly bills"], ["PEOPLE", "People"], ["CLINIC", "Clinic"], ["BUSINESS", "Business"]];
/** Owners and the GM: add categories, set a monthly budget, mark a bill as monthly, hide unused ones. */
function Categories({ cats, month, scope }: { cats: Category[]; month: string; scope: string }) {
  const hidden = (k: string, v: string) => <input type="hidden" name={k} value={v} />;
  return (
    <div className="card">
      <div className="card-head"><h2>Categories &amp; budgets</h2><span className="small muted">Monthly = expected every month (shows in Due this month). Budget is optional.</span></div>
      <ul className="plain-list exp-cats">
        {cats.map((c) => (
          <li key={c.id} className={c.active ? "" : "muted"}>
            <form action={saveCategory} className="exp-cat-form">
              {hidden("id", c.id)}{hidden("month", month)}{hidden("scope", scope)}
              <input name="name" defaultValue={c.name} maxLength={60} aria-label="Name" disabled={c.kind === "AUTO"} />
              {c.kind === "AUTO" ? <span className="exp-tag">auto</span> : (
                <select name="kind" defaultValue={c.kind} aria-label="How often"><option value="MONTHLY">Monthly</option><option value="ONE_OFF">As needed</option></select>
              )}
              <input name="budget" inputMode="decimal" defaultValue={c.budget_cents ? pesoInput(c.budget_cents) : ""} placeholder="Budget ₱/month" aria-label="Monthly budget" />
              <select name="active" defaultValue={String(c.active)} aria-label="Shown"><option value="true">Shown</option><option value="false">Hidden</option></select>
              <button type="submit" className="secondary small">Save</button>
            </form>
          </li>
        ))}
      </ul>
      <form action={saveCategory} className="exp-cat-form exp-cat-new">
        {hidden("month", month)}{hidden("scope", scope)}
        <input name="name" required minLength={2} maxLength={60} placeholder="New category, e.g. Aircon cleaning" aria-label="New category" />
        <select name="grp" defaultValue="BUSINESS" aria-label="Group">{GRP.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select name="kind" defaultValue="ONE_OFF" aria-label="How often"><option value="MONTHLY">Monthly</option><option value="ONE_OFF">As needed</option></select>
        <input name="budget" inputMode="decimal" placeholder="Budget ₱/month" aria-label="Monthly budget" />
        <button type="submit" className="small">Add category</button>
      </form>
    </div>
  );
}
