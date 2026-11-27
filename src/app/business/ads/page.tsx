import Link from "next/link";
import { AddPanel } from "@/components/Controls";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { compact, Donut, GoldSpark, Ring } from "@/components/BizCharts";
import { RoasBars, SpendSalesChart } from "@/components/AdsCharts";
import { manilaToday } from "@/lib/dates";
import { addDays, monthEnd } from "@/lib/insights";
import { centsOfCell } from "@/lib/business";
import type { StatusDay } from "@/lib/homeGlance";
import {
  AD_SERVICES, adRoas, adServiceOf, CREATIVES, monthName, NOV_SHARES, perMessage, periodOptions, PLAN, PLAN_DECEMBER, PLAN_TESTING,
  ROAS_FLOOR, roas, SERVICE_LABEL, SOURCE_LABEL, SOURCES, sourceOf, spendMonths, spent, spentK, summarize, summarizeSources, withVat, x,
  type AdService, type LogForSource, type Source, type SpendRow,
} from "@/lib/ads";
import { chunks, every } from "../load";
import { saveSources, saveSpend } from "./actions";

type LogRow = LogForSource & { log_no: string | null; branch_id: string; service_date: string; service_id: string; client_name: string | null };
const MGMT = ["OWNER", "FINANCE", "AUDITOR", "MANAGER"];
const peso = (pesos: number) => `₱${pesos.toLocaleString("en-US")}`;

/** Business › Ads (update-0096, CHRIS Nov 27): what Meta ads cost against what each branch sold, and where sales came from. */
export default async function Ads({ searchParams }: { searchParams: Promise<{ p?: string; ok?: string; err?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.some((g) => MGMT.includes(g.role))) redirect("/me");
  const ownerGm = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const sp = await searchParams;
  const today = manilaToday();
  const thisMonth = today.slice(0, 7);
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const ids = clinics.map((b) => b.id);
  const codeOf = Object.fromEntries(clinics.map((b) => [b.id, b.code]));
  const shortName = (name: string) => name.replace(/^Hermosa\s+/i, "");

  // daily_sales_status reads at most 800 days.
  const salesFrom = addDays(today, -790) > "2025-01-01" ? addDays(today, -790) : "2025-01-01";
  const [{ data: spendData, error: spendErr }, { data: st }, { data: svcData }] = await Promise.all([
    supabase.from("ad_spend_monthly").select("month, branch_id, service, spend_cents, messages, through").order("month"),
    supabase.rpc("daily_sales_status", { p_start: salesFrom, p_end: today }),
    supabase.from("services").select("id, name"),
  ]);
  if (spendErr) {
    return (<><TopBar access={access} /><main className="business"><div className="biz-head"><h1>Ads</h1></div>
      <div className="notice info">{spendErr.code === "42P01" || spendErr.code === "PGRST205" ? "The owner needs to run update-0096 in Supabase first." : "Ad figures couldn't load. Try again in a moment."}</div></main></>);
  }
  const rows = ((spendData ?? []) as SpendRow[]).map((r) => ({ ...r, spend_cents: Number(r.spend_cents), messages: Number(r.messages) }));
  const months = spendMonths(rows);
  const opts = periodOptions(months, thisMonth);
  const period = opts.find((o) => o.key === sp.p) ?? opts[0];
  if (!period) {
    return (<><TopBar access={access} /><main className="business"><div className="biz-head"><h1>Ads</h1></div><div className="notice info">No ad spend saved yet.</div></main></>);
  }

  // Declared sales per branch per month (the Daily Sales figure, the service log only where nothing was typed).
  const sales = new Map<string, Map<string, number>>();
  for (const r of ((st as { ok?: boolean; days?: StatusDay[] } | null)?.days ?? [])) {
    const v = centsOfCell(r);
    if (v === null) continue;
    const m = sales.get(r[0]) ?? new Map<string, number>();
    m.set(r[1].slice(0, 7), (m.get(r[1].slice(0, 7)) ?? 0) + v);
    sales.set(r[0], m);
  }

  // The period's Service log: service shares per branch, and where each sale came from.
  const pStart = `${period.months[0]}-01`;
  const pEnd = monthEnd(`${period.months[period.months.length - 1]}-01`) < today ? monthEnd(`${period.months[period.months.length - 1]}-01`) : today;
  const logs = await every<LogRow>((a, b) => supabase.from("service_logs")
    .select("id, log_no, branch_id, service_date, service_id, amount_paid_cents, session_no, promo_client_id, booking_id, client_name")
    .gte("service_date", pStart).lte("service_date", pEnd).neq("state", "REJECTED").order("id").range(a, b));
  const [srcRows, bookRows] = await Promise.all([
    chunks<{ service_log_id: string; source: Source }>(logs.map((l) => l.id), (part) => supabase.from("service_log_sources").select("service_log_id, source").in("service_log_id", part)),
    chunks<{ id: string; platform: string }>([...new Set(logs.map((l) => l.booking_id).filter((v): v is string => !!v))], (part) => supabase.from("bookings").select("id, platform").in("id", part)),
  ]);
  const manual = new Map(srcRows.map((r) => [r.service_log_id, r.source]));
  const platform = new Map(bookRows.map((r) => [r.id, r.platform]));
  const svcName = Object.fromEntries(((svcData ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]));

  const logged = new Map<string, Record<AdService, number>>();
  for (const l of logs) {
    const amt = Number(l.amount_paid_cents);
    if (amt <= 0) continue;
    const t = logged.get(l.branch_id) ?? { HIKO: 0, GLUTA: 0, OTHER: 0 };
    t[adServiceOf(svcName[l.service_id] ?? "")] += amt;
    logged.set(l.branch_id, t);
  }
  const shares = new Map<string, Record<AdService, number>>();
  let sharesFromLog = 0;
  for (const id of ids) {
    const t = logged.get(id), tot = t ? t.HIKO + t.GLUTA + t.OTHER : 0;
    if (t && tot >= 5_000_000) { shares.set(id, { HIKO: t.HIKO / tot, GLUTA: t.GLUTA / tot, OTHER: t.OTHER / tot }); sharesFromLog++; }
    else if (NOV_SHARES[codeOf[id]]) shares.set(id, NOV_SHARES[codeOf[id]]);
  }

  const sum = summarize(rows, period.months, sales, ids, shares);
  const tot = sum.total;
  const partial = period.months.includes(thisMonth);
  const through = rows.filter((r) => period.months.includes(r.month.slice(0, 7))).map((r) => r.through).filter(Boolean).sort().pop() ?? null;
  const nMonths = period.months.length;

  // Last 13 months for the chart and sparkline.
  const chartMonths = months.slice(-13).map((m) => {
    const sp = rows.filter((r) => r.month.startsWith(m) && ids.includes(r.branch_id)).reduce((s, r) => s + r.spend_cents, 0);
    const sl = ids.reduce((s, id) => s + (sales.get(id)?.get(m) ?? 0), 0);
    return { key: m, label: monthName(m, false), spend: withVat(sp), sales: sl, partial: m === thisMonth };
  });

  // Sales sources for the period.
  const items = logs.map((l) => ({ l, cents: Number(l.amount_paid_cents), ...sourceOf(l, manual.get(l.id), l.booking_id ? platform.get(l.booking_id) : undefined) }));
  const src = summarizeSources(items);
  const logMonths = [...new Set(logs.map((l) => l.service_date.slice(0, 7)))];
  const spendInLogMonths = rows.filter((r) => logMonths.includes(r.month.slice(0, 7)) && ids.includes(r.branch_id)).reduce((s, r) => s + r.spend_cents, 0);
  const ad = adRoas(src, spendInLogMonths);
  const firstLog = logs.reduce<string | null>((m, l) => (m === null || l.service_date < m ? l.service_date : m), null);
  const untagged = items.filter((i) => i.cents > 0 && !i.source).sort((a, b) => b.l.service_date.localeCompare(a.l.service_date) || b.cents - a.cents).slice(0, 25);
  const bName = Object.fromEntries(clinics.map((b) => [b.id, shortName(b.name)]));

  // Plan vs the period's monthly average (pre-VAT).
  const planTotal = PLAN.reduce((s, p) => s + p.hiko + p.gluta, 0) + PLAN_TESTING;
  const avgSpend = tot.spend / nMonths;
  const lineOf = (id: string, s: AdService) => sum.line.get(`${id}|${s}`) ?? { spend: 0, messages: 0, sales: 0 };
  const bars = clinics.flatMap((b) => (["HIKO", "GLUTA"] as AdService[]).map((s) => {
    const l = lineOf(b.id, s), r = roas(l);
    return { key: `${b.id}-${s}`, group: shortName(b.name), label: SERVICE_LABEL[s], value: r,
      tip: `${shortName(b.name)} ${SERVICE_LABEL[s]}: ${l.spend ? spent(l.spend) : "no ads"} · sales ≈ ${compact(l.sales)} (${Math.round((shares.get(b.id)?.[s] ?? 0) * 100)}% of the branch) · ${x(r)}` };
  }));
  const flags = bars.filter((b) => b.value !== null && b.value < ROAS_FLOOR && lineOf(b.key.split("-").slice(0, -1).join("-"), b.key.split("-").pop() as AdService).spend > 0);
  const best = [...bars].filter((b) => b.value !== null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
  const qp = (p: string) => `/business/ads?p=${encodeURIComponent(p)}`;

  return (
    <>
      <TopBar access={access} />
      <main className="business ads">
        <div className="biz-head"><h1>Ads</h1><span className="muted">Meta ads vs sales · all branches</span></div>
        <nav className="ads-periods" aria-label="Period">
          {opts.map((o) => <Link key={o.key} href={qp(o.key)} className={o.key === period.key ? "on" : ""} aria-current={o.key === period.key ? "page" : undefined}>{o.label}</Link>)}
        </nav>
        {sp.ok && <div className="notice ok">✓ {sp.ok}</div>}
        {sp.err && <div className="notice error">{sp.err}</div>}

        <div className="biz-kpis">
          <div className="card biz-kpi">
            <div className="label">Ad spend</div>
            <div className="value">{spentK(tot.spend)}</div>
            <div className="sub muted">{nMonths > 1 ? `${spentK(avgSpend)} a month` : partial && through ? `to ${monthName(through.slice(0, 7), false)} ${Number(through.slice(8))}` : "this month"}</div>
            <GoldSpark values={chartMonths.map((m) => m.spend)} id="ads-sp" label="Ad spend, last 13 months" />
          </div>
          <div className="card biz-kpi">
            <div className="label">ROAS</div>
            <div className="value">{x(roas(tot))}</div>
            <div className="sub muted" title="Total declared sales ÷ ad spend with VAT. Includes walk-ins, referrals and package sessions.">{compact(tot.sales)} sales ÷ spend*</div>
            <GoldSpark values={chartMonths.map((m) => (m.spend ? (m.sales / m.spend) * 100 : 0))} id="ads-roas" label="ROAS, last 13 months" />
          </div>
          <div className="card biz-kpi">
            <div className="label">Per message</div>
            <div className="value">{perMessage(tot) === null ? "–" : `₱${Math.round(perMessage(tot)! / 100)}*`}</div>
            <div className="sub muted">{tot.messages.toLocaleString("en-US")} new chats</div>
          </div>
          <div className="card biz-kpi biz-goal">
            <Ring frac={ad ? ad.coverage : 0} label={ad ? `${Math.round(ad.coverage * 100)}%` : "0%"} sub="sources known" />
            <div>
              <div className="label">From ads</div>
              <div className="value">{ad ? x(ad.value) : "–"}</div>
              <div className="sub muted">{ad ? `ROAS from ad clients${ad.estimated ? " (est.)" : ""}` : "tag sources below"}</div>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Spend* vs sales <small>last 13 months · bars = ad spend*, line = sales</small></h2>
          <SpendSalesChart months={chartMonths} title="Monthly ad spend with VAT against declared sales, last 13 months" />
          <div className="biz-signals ads-findings">
            <span className="good" title="QC Main spent about half in November 2026 and its sales held.">✓ QC Main: half the spend in Nov, sales held</span>
            {best && <span className="good" title={best.tip}>🏆 Best: {best.group} {best.label} {x(best.value)}</span>}
            {flags.slice(0, 3).map((f) => <span key={f.key} className="bad" title={f.tip}>▼ {f.group} {f.label} {x(f.value)}</span>)}
          </div>
        </div>

        <div className="biz-row">
          <div className="card">
            <h2>Branches <small>{period.label}{partial ? " · so far" : ""}</small></h2>
            <div className="table-wrap">
              <table className="ads-table">
                <thead><tr><th>Branch</th><th>Spend*</th><th>Sales</th><th>ROAS</th><th>Per chat*</th></tr></thead>
                <tbody>
                  {clinics.map((b) => {
                    const l = sum.branch.get(b.id)!, r = roas(l), pm = perMessage(l);
                    return (
                      <tr key={b.id}>
                        <td>{shortName(b.name)}</td>
                        <td>{spentK(l.spend)}</td>
                        <td>{compact(l.sales)}</td>
                        <td><span className={`roas ${r !== null && r < ROAS_FLOOR ? "low" : "ok"}`}>{x(r)}</span></td>
                        <td>{pm === null ? "–" : `₱${Math.round(pm / 100)}*`}</td>
                      </tr>
                    );
                  })}
                  <tr className="tot"><td>All</td><td>{spentK(tot.spend)}</td><td>{compact(tot.sales)}</td><td><b>{x(roas(tot))}</b></td><td>{perMessage(tot) === null ? "–" : `₱${Math.round(perMessage(tot)! / 100)}*`}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="small muted">Spend counts for the branch whose Facebook page ran the ad. ROAS = total sales ÷ spend*.</p>
          </div>
          <div className="card">
            <h2>Hiko vs Gluta <small>ROAS per branch</small></h2>
            <RoasBars bars={bars} floor={ROAS_FLOOR} title="ROAS of Hiko and Gluta ads per branch" />
            <p className="small muted">
              Sales per service = branch sales × its share in {sharesFromLog === clinics.length ? "this period's Service log" : sharesFromLog ? "the Service log (November 2026 shares where it's thin)" : "the November 2026 Service log"}. Red = under {ROAS_FLOOR}x.
            </p>
          </div>
        </div>

        <div className="card" id="sources">
          <h2>Where sales came from <small>{firstLog ? `Service log from ${monthName(firstLog.slice(0, 7), false)} ${Number(firstLog.slice(8))}` : "no Service log in this period"}</small></h2>
          {src.total > 0 ? (
            <div className="ads-src">
              <Donut items={SOURCES.filter((s) => src.bySource[s] > 0).map((s) => ({ name: SOURCE_LABEL[s], cents: src.bySource[s] })).concat(src.total - src.known > 0 ? [{ name: "Not known yet", cents: src.total - src.known }] : [])}
                center={`${Math.round((src.known / src.total) * 100)}%`} sub="known" />
              <ul className="ads-src-facts">
                <li><b>{compact(src.bySource.AD)}</b> from ad clients{ad ? <> · <b>{x(ad.value)}</b> ROAS{ad.estimated ? " (estimated from the known part)" : ""}</> : null}</li>
                <li><b>{compact(src.auto)}</b> worked out automatically: later package sessions = returning, bookings from a Facebook or Instagram chat = ad</li>
                <li><b>{compact(src.tagged)}</b> tagged by hand{ownerGm ? " (below)" : ""}</li>
                <li><b>{compact(src.total - src.known)}</b> not known yet</li>
              </ul>
            </div>
          ) : <p className="small muted">No sales logged in this period yet.</p>}
          {ownerGm && (
            <form action={saveSources} className="ads-tag">
              <input type="hidden" name="period" value={period.key} />
              {untagged.length > 0 && (
                <details>
                  <summary>Tag the latest {untagged.length} unknown sale{untagged.length === 1 ? "" : "s"}</summary>
                  <div className="table-wrap">
                    <table className="ads-table">
                      <thead><tr><th>SL</th><th>Date</th><th>Branch</th><th>Client</th><th>Paid</th><th>Came from</th></tr></thead>
                      <tbody>
                        {untagged.map(({ l, cents }) => (
                          <tr key={l.id}>
                            <td className="mono">{l.log_no ?? "–"}</td>
                            <td>{monthName(l.service_date.slice(0, 7), false)} {Number(l.service_date.slice(8))}</td>
                            <td>{bName[l.branch_id] ?? ""}</td>
                            <td>{l.client_name ?? ""}</td>
                            <td>{compact(cents)}</td>
                            <td><select name={`src_${l.id}`} defaultValue="" aria-label={`Source of ${l.log_no ?? "this sale"}`}>
                              <option value="">–</option>
                              {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                            </select></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              <label>
                From sales-log photos: one sale per line, SL number then where the client came from
                <textarea name="lines" rows={4} placeholder={"SL-2611-0012 ad\nSL-2611-0013 walk-in\nSL-2611-0014 referral"} />
              </label>
              <p className="small muted">Words: ad, page, walk-in, referral, returning, other. Send the photos to Claude and you&apos;ll get these lines back to paste.</p>
              <button type="submit">Save sources</button>
            </form>
          )}
        </div>

        <div className="biz-row">
          <div className="card">
            <h2>Recommended month <small>pre-VAT budgets</small></h2>
            <div className="table-wrap">
              <table className="ads-table">
                <thead><tr><th>Branch</th><th>Hiko</th><th>Gluta</th><th>Now*</th></tr></thead>
                <tbody>
                  {PLAN.map((p) => {
                    const b = clinics.find((c) => c.code === p.code);
                    const now = b ? (sum.branch.get(b.id)?.spend ?? 0) / nMonths : 0;
                    return (
                      <tr key={p.code} title={p.note}>
                        <td>{b ? shortName(b.name) : p.code}</td>
                        <td>{peso(p.hiko)}</td>
                        <td>{p.gluta ? peso(p.gluta) : "Off"}</td>
                        <td className="muted">{spentK(now)}/mo</td>
                      </tr>
                    );
                  })}
                  <tr><td>Testing</td><td colSpan={2}>{peso(PLAN_TESTING)} for new ads</td><td /></tr>
                  <tr className="tot"><td>Total</td><td colSpan={2}><b>{peso(planTotal)}</b> <span className="muted">≈ {spentK(planTotal * 100)} with VAT</span></td><td className="muted">{spentK(avgSpend)}/mo</td></tr>
                </tbody>
              </table>
            </div>
            <p className="small muted">December: up to {peso(PLAN_DECEMBER)} pre-VAT for payday and Christmas bursts. Hover a row for why.</p>
          </div>
          <div className="card">
            <h2>Best and worst ads <small>per new chat*</small></h2>
            <div className="ads-creatives">
              {CREATIVES.map((c) => {
                const pm = withVat(c.spend) / c.messages / 100;
                return (
                  <div key={c.name} className={c.best ? "best" : "worst"} title={`${c.where}: ${spent(c.spend)} spent, ${c.messages.toLocaleString("en-US")} chats`}>
                    <span className="tag">{c.best ? "Best" : "Worst"}</span>
                    <span className="nm">{c.name}</span>
                    <b>₱{pm.toFixed(1)}*</b>
                  </div>
                );
              })}
            </div>
            <p className="small muted">&quot;Affordable&quot; wording and testimonials get the cheapest chats; an exact ₱8,999 price cost twice as much. Jun 2025 – Nov 2026.</p>
          </div>
        </div>

        {ownerGm && (
          <AddPanel id="spend" title="Add or correct monthly ad spend" hint="Owners and the GM">
            <form action={saveSpend} className="ads-tag">
              <input type="hidden" name="period" value={period.key} />
              <label>
                One line per month, branch and service: month, branch, Hiko/Gluta/Other, pesos BEFORE VAT, new chats (optional: last day covered)
                <textarea name="spend" rows={4} placeholder={"2026-12, QC Main, Hiko, 95000, 2100\n2026-12, Marikina, Gluta, 20000, 600, 2026-12-15"} />
              </label>
              <p className="small muted">Saving a month, branch and service again replaces it. Claude can pull these from Meta each month.</p>
              <button type="submit">Save ad spend</button>
            </form>
          </AddPanel>
        )}

        <p className="small muted ads-foot">* = amount spent with 12% VAT. Recommended budgets are before VAT. Full analysis: <a href="https://claude.ai/artifact/NBhJKh5fqUpE7SG6pVQsTD" target="_blank" rel="noreferrer">Meta ads ROAS check</a>.</p>
      </main>
    </>
  );
}
