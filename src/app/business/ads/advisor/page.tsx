import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Chg, compact, GoldSpark } from "@/components/BizCharts";
import { RoasBars } from "@/components/AdsCharts";
import { manilaToday } from "@/lib/dates";
import { addDays } from "@/lib/insights";
import { centsOfCell } from "@/lib/business";
import type { StatusDay } from "@/lib/homeGlance";
import { withApprovedSales } from "@/lib/approvedSales";
import { adServiceOf, NOV_SHARES, SERVICE_LABEL, type AdService } from "@/lib/ads";
import { advise, BRANCH_ORDER, CUT_BELOW, fmtDay, LEARN_PER_WEEK, perChat, RAISE_AT, roleOf, type Feed, type LineView } from "@/lib/adsAdvisor";
import { links, newAdSets, PLAYBOOK, planMap, planPerDay, playLine, proposedPerDay, statusLabel, type PlayLine } from "@/lib/adsPlaybook";
import { every } from "../../load";
import PH from "@/data/phMarket.json";
import { ApproveChip } from "./ApproveChip";

const MGMT = ["OWNER", "FINANCE", "AUDITOR", "MANAGER"];
const peso = (p: number) => `₱${Math.round(p).toLocaleString("en-US")}`;
const vat = (p: number) => `₱${Math.round(p * 1.12).toLocaleString("en-US")}*`;
const xr = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)}x`);
const STATE_LABEL: Record<string, string> = { WINNER: "Winner: keep", TIRING: "Tiring: add versions", FATIGUED: "Fatigued: pause + remake", LOSER: "Loser: pause", NEW: "Learning", STEADY: "Steady" };
const ACTION_LABEL: Record<string, string> = { RAISE: "Raise", TEST: "Test", START: "Start", CUT: "Cut", OFF: "Turn off", KEEP: "Keep", WAIT: "Wait", NONE: "Off" };
const SHORT: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };
const ACTION_CLASS: Record<string, string> = { RAISE: "up", TEST: "up", START: "up", CUT: "down", OFF: "down", KEEP: "keep", WAIT: "keep", NONE: "none" };

/** Business › Ad advisor (update-0099, CHRIS Nov 27): this week's budget moves, ads to turn off or copy, ad set set-up and videos, and the market radar.
 *  v0.99.4 (CHRIS Nov 27 "too verbose"): gold dashboard — big numbers with ▲▼, one card per move with Approve, a branch table
 *  that opens to the detail, and a Philippines-first market card (our numbers, PH prices and costs; US figures folded away). */
export default async function AdAdvisor() {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.some((g) => MGMT.includes(g.role))) redirect("/me");
  const today = manilaToday();
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const codeOf = Object.fromEntries(clinics.map((b) => [b.id, b.code]));
  const nameOf = Object.fromEntries(clinics.map((b) => [b.code, b.name.replace(/^Hermosa\s+/i, "")]));

  const from = addDays(today, -35);
  const [{ data: feedData, error }, { data: st }, { data: svcData }] = await Promise.all([
    supabase.rpc("ads_feed_rows", { p_from: addDays(today, -42) }),
    supabase.rpc("daily_sales_status", { p_start: from, p_end: today }),
    supabase.from("services").select("id, name"),
  ]);
  const feed = feedData as Feed | null;
  if (error || !feed?.ok) {
    return (<><TopBar access={access} /><main className="business ads"><div className="biz-head"><h1>Ad advisor</h1></div>
      <div className="notice info">{error?.code === "PGRST202" ? "The owner needs to run update-0099 in Supabase first." : "The ad feed couldn't load. Try again in a moment."}</div></main></>);
  }

  // Declared sales per branch per day, and each branch's Hiko/Gluta share from the last 4 weeks of the Service log.
  const sales = new Map<string, Map<string, number>>();
  for (const r of await withApprovedSales(supabase, (st as { days?: StatusDay[] } | null)?.days ?? [], today)) {
    const v = centsOfCell(r), code = codeOf[r[0]];
    if (v === null || !code) continue;
    const m = sales.get(code) ?? new Map<string, number>();
    m.set(r[1], v);
    sales.set(code, m);
  }
  const logs = await every<{ branch_id: string; service_id: string; amount_paid_cents: number }>((a, b) => supabase.from("service_logs")
    .select("branch_id, service_id, amount_paid_cents").gte("service_date", addDays(today, -28)).lte("service_date", today).neq("state", "REJECTED").order("id").range(a, b));
  const svcName = Object.fromEntries(((svcData ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const tally = new Map<string, Record<AdService, number>>();
  for (const l of logs) {
    const code = codeOf[l.branch_id], amt = Number(l.amount_paid_cents);
    if (!code || amt <= 0) continue;
    const t = tally.get(code) ?? { HIKO: 0, GLUTA: 0, OTHER: 0 };
    t[adServiceOf(svcName[l.service_id] ?? "")] += amt;
    tally.set(code, t);
  }
  const shares = new Map<string, Record<AdService, number>>();
  let fromLog = 0;
  for (const code of Object.keys(NOV_SHARES)) {
    const t = tally.get(code), tot = t ? t.HIKO + t.GLUTA + t.OTHER : 0;
    if (t && tot >= 5_000_000) { shares.set(code, { HIKO: t.HIKO / tot, GLUTA: t.GLUTA / tot, OTHER: t.OTHER / tot }); fromLog++; }
    else shares.set(code, NOV_SHARES[code]);
  }

  const res = advise({ feed, today, sales, shares, plan: planMap() });
  const lines = res.lines;
  const pb = PLAYBOOK;
  const short = (code: string) => SHORT[code] ?? nameOf[code] ?? code;
  const tag = (l: LineView) => `${short(l.branch)} · ${SERVICE_LABEL[l.service]}`;

  // Headline numbers (spend with VAT, budgets before VAT).
  const sum = (f: (l: LineView) => number) => lines.reduce((a, l) => a + f(l), 0);
  const spend7 = sum((l) => l.t7.spend), spendP7 = sum((l) => l.p7.spend);
  const chats7 = sum((l) => l.t7.msgs), chatsP7 = sum((l) => l.p7.msgs);
  const sales7 = sum((l) => (l.t7.spend > 0 ? l.sales7 : 0)), salesP7 = sum((l) => (l.p7.spend > 0 ? l.salesP7 : 0));
  const roas7 = spend7 > 0 ? sales7 / 100 / (spend7 * 1.12) : null, roasP7 = spendP7 > 0 ? salesP7 / 100 / (spendP7 * 1.12) : null;
  const cpc7 = chats7 ? (spend7 * 1.12) / chats7 : null, cpcP7 = chatsP7 ? (spendP7 * 1.12) / chatsP7 : null;
  const dailySpend = Array.from({ length: 28 }, (_, i) => sum((l) => l.days[i]?.sp ?? 0) * 1.12);
  const dailyChats = Array.from({ length: 28 }, (_, i) => sum((l) => l.days[i]?.m ?? 0));
  const weekRoas = [0, 1, 2, 3].map((w) => {
    let sp = 0, sl = 0;
    for (const l of lines) {
      const s = l.days.slice(w * 7, w * 7 + 7).reduce((a, x) => a + x.sp, 0) * 1.12;
      if (s > 0 && l.roasWeeks[w] !== null) { sp += s; sl += l.roasWeeks[w]! * s; }
    }
    return sp > 0 ? sl / sp : null;
  });
  const nowPerDay = sum((l) => l.budget);
  const nextPerDay = sum((l) => (l.action === "NONE" ? 0 : l.newBudget));
  const plan = planPerDay();

  // One card per move.
  const ads = lines.flatMap((l) => l.ads.map((a) => ({ l, a })));
  const byState = (st: string) => ads.filter((x) => x.a.state === st);
  const losers = byState("LOSER"), fatigued = byState("FATIGUED"), tiring = byState("TIRING"), winners = byState("WINNER");
  const mismatches = lines.flatMap((l) => l.adsets.filter((s) => s.mismatch).map((s) => ({ l, s })));
  const moves: Move[] = [
    ...mismatches.map(({ l, s }) => ({
      id: `pin-${s.id}`, tone: "bad", tag: tag(l), kind: "Fix the area", title: `Move the map pin to ${short(l.branch)}`,
      short: `"${s.name}" is aimed at the ${short(s.mismatch!)} area`, why: `The ad set's location pin is nearest ${nameOf[s.mismatch!] ?? s.mismatch}, so its chats go to the wrong clinic. Move the pin (and radius) to ${nameOf[l.branch]}. ${s.text ?? ""}`,
      approve: `${tag(l)}: move ad set "${s.name}" pin to ${nameOf[l.branch]}`,
    })),
    ...lines.filter((l) => ["RAISE", "TEST", "CUT", "OFF", "START"].includes(l.action)).map((l) => ({
      id: `budget-${l.key}-${l.newBudget}`, tone: ["CUT", "OFF"].includes(l.action) ? "down" : "up", tag: tag(l),
      kind: l.action === "TEST" ? "Budget test" : l.action === "START" ? "Start" : l.action === "OFF" ? "Turn off" : l.action === "CUT" ? "Budget cut" : "Budget raise",
      title: l.action === "OFF" ? "Turn off" : `${peso(l.budget)} → ${peso(l.newBudget)}/day`,
      short: l.roas7 === null ? "No spend this week" : `ROAS ${xr(l.roas7)} this week · ${xr(l.roasP7)} last week`, why: l.why,
      approve: `${tag(l)}: ${l.headline}`, delta: l.budget > 0 ? l.newBudget / l.budget - 1 : null,
    })),
    ...losers.map(({ l, a }) => ({
      id: `pause-${a.id}`, tone: "bad", tag: tag(l), kind: "Pause ad", title: `Pause "${a.name}"`,
      short: `${a.cpc14 === null ? "No chats" : `₱${a.cpc14.toFixed(0)}* a chat`} · ${vat(a.t14.spend)} in 14 days`, why: a.why,
      approve: `${tag(l)}: pause ad "${a.name}"`,
    })),
    ...fatigued.map(({ l, a }) => ({
      id: `remake-${a.id}`, tone: "bad", tag: tag(l), kind: "Pause + remake", title: `Remake "${a.name}"`,
      short: `₱${(a.cpc14 ?? 0).toFixed(0)}* a chat vs its best ₱${(a.baseline ?? 0).toFixed(0)}*`, why: a.why,
      approve: `${tag(l)}: pause and remake ad "${a.name}"`,
    })),
    ...tiring.map(({ l, a }) => ({
      id: `tiring-${a.id}`, tone: "warn", tag: tag(l), kind: "Add new versions", title: `Freshen "${a.name}"`,
      short: "Add 1–2 new versions; keep it running", why: a.why,
      approve: `${tag(l)}: add 1–2 new versions next to ad "${a.name}"`,
    })),
  ];
  const holding = lines.filter((l) => l.action === "KEEP" || l.action === "WAIT").length;
  const nextReview = lines.map((l) => l.nextReview).filter((d) => d > today).sort()[0] ?? null;
  const learning = lines.flatMap((l) => l.adsets).filter((s) => s.learnShort).length;
  const stale = res.staleDays !== null && res.staleDays >= 2;
  const loaded = feed.loaded_at ? new Date(feed.loaded_at).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const counts = (["WINNER", "STEADY", "NEW", "TIRING", "FATIGUED", "LOSER"] as const).map((k) => ({ k, n: byState(k).length })).filter((x) => x.n > 0);

  // Market: our own numbers first.
  const im7 = sum((l) => l.t7.impressions), cl7 = sum((l) => l.t7.clicks);
  const ourCpm = im7 > 0 ? (spend7 * 1.12 * 1000) / im7 : null, ourCpcl = cl7 > 0 ? (spend7 * 1.12) / cl7 : null, ourCtr = im7 > 0 ? cl7 / im7 : null;
  const cpcBranch = BRANCH_ORDER.map((code) => {
    const ls = lines.filter((l) => l.branch === code);
    const t = ls.reduce((a, l) => ({ sp: a.sp + l.t7.spend, m: a.m + l.t7.msgs, ps: a.ps + l.p7.spend, pm: a.pm + l.p7.msgs }), { sp: 0, m: 0, ps: 0, pm: 0 });
    const now = t.m ? (t.sp * 1.12) / t.m : null, prev = t.pm ? (t.ps * 1.12) / t.pm : null;
    return { code, now, prev };
  }).filter((x) => x.now !== null);
  const roasSvc = (["HIKO", "GLUTA", "OTHER"] as AdService[]).map((svc) => {
    const ls = lines.filter((l) => l.service === svc);
    const sp = ls.reduce((a, l) => a + l.t7.spend, 0), sl = ls.reduce((a, l) => a + (l.t7.spend > 0 ? l.sales7 : 0), 0);
    const ps = ls.reduce((a, l) => a + l.p7.spend, 0), psl = ls.reduce((a, l) => a + (l.p7.spend > 0 ? l.salesP7 : 0), 0);
    return { svc, now: sp > 0 ? sl / 100 / (sp * 1.12) : null, prev: ps > 0 ? psl / 100 / (ps * 1.12) : null, spend: sp };
  }).filter((x) => x.spend > 0);
  const mkt = PH as PhMarket;
  const tier = (t: number) => pb.radar.benchmarks.filter((x) => (x.tier ?? 3) === t);

  return (
    <>
      <TopBar access={access} />
      <main className="business ads advisor adv2">
        <div className="biz-head">
          <h1>Ad advisor</h1>
          <span className={`adv-fresh2 ${stale ? "warn" : ""}`} title={feed.source === "seed" || !feed.source ? "Starting figures; the daily update starts once the Windsor export is set up (on your To-Do)." : "Updates every day from Meta."}>
            {res.lastDate ? <>Meta data to <b>{fmtDay(res.lastDate)}</b></> : "No Meta data yet"}
            {loaded ? <> · loaded {loaded}</> : null}
            {feed.source === "seed" || !feed.source ? " · starting figures" : stale ? ` · ${res.staleDays} days late` : " · daily"}
          </span>
        </div>

        <div className="biz-kpis">
          <div className="card biz-kpi">
            <div className="label">Spent, 7 days</div>
            <div className="value">{vat(spend7)}</div>
            <div className="sub"><Delta now={spend7} prev={spendP7} tone="neu" suffix="vs last week" /></div>
            <GoldSpark values={dailySpend} id="adv-sp" label="Ad spend per day, last 28 days" />
          </div>
          <div className="card biz-kpi">
            <div className="label">Chats, 7 days</div>
            <div className="value">{chats7.toLocaleString("en-US")}</div>
            <div className="sub"><Delta now={chats7} prev={chatsP7} suffix="vs last week" />{cpc7 !== null && <span className="adv-kpi-note">₱{cpc7.toFixed(0)}* a chat <Delta now={cpc7} prev={cpcP7} goodDown /></span>}</div>
            <GoldSpark values={dailyChats} id="adv-ch" label="Chats per day, last 28 days" />
          </div>
          <div className="card biz-kpi">
            <div className="label">ROAS, 7 days</div>
            <div className={`value ${roas7 !== null && roas7 < CUT_BELOW ? "adv-low" : ""}`}>{xr(roas7)}</div>
            <div className="sub"><Delta now={roas7} prev={roasP7} suffix="vs last week" /><span className="adv-kpi-note">goal {RAISE_AT}x · cut under {CUT_BELOW}x</span></div>
            <GoldSpark values={weekRoas} id="adv-ro" label="ROAS per week, last 4 weeks" />
          </div>
          <div className="card biz-kpi">
            <div className="label">Budget a day, pre-VAT</div>
            <div className="value">{peso(nowPerDay)}</div>
            <div className="sub">{nextPerDay !== nowPerDay ? <span className={`chg ${nextPerDay < nowPerDay ? "down" : "up"}`}>→ {peso(nextPerDay)} after OKs</span> : <span className="chg neu">no budget change</span>}</div>
            <div className="adv-meter" title={`Now ${peso(nowPerDay)} of the ${peso(plan)}/day plan (before VAT)`}><i style={{ width: `${Math.min(100, plan ? (nowPerDay / plan) * 100 : 0)}%` }} /><span>plan {peso(plan)}</span></div>
          </div>
        </div>

        <div className="biz-signals">
          {winners.length > 0 && <span className="good">{winners.length} winning ad{winners.length === 1 ? "" : "s"}</span>}
          {losers.length + fatigued.length > 0 && <span className="bad">{losers.length + fatigued.length} to pause</span>}
          {tiring.length > 0 && <span className="warn">{tiring.length} tiring</span>}
          {mismatches.length > 0 && <span className="bad">{mismatches.length} aimed at the wrong area</span>}
          {learning > 0 && <span title={`Under ${LEARN_PER_WEEK} chats a week, Meta is still learning`}>{learning} ad set{learning === 1 ? "" : "s"} still learning</span>}
          <span>{holding} line{holding === 1 ? "" : "s"} holding budget</span>
          <span>Next review {nextReview ? fmtDay(nextReview) : "today"}</span>
        </div>

        <section className="card adv-moves-card">
          <div className="adv-h">
            <h2>This week&apos;s moves <small>{moves.length ? `${moves.length} to OK` : "nothing to change"}</small></h2>
            <span className="small muted">Approve copies your OK for the ads chat. Meta changes only after you OK the preview.</span>
          </div>
          {moves.length === 0 ? (
            <p className="adv-calm">Every line is holding. Leave budgets alone so Meta keeps learning; next review {nextReview ? fmtDay(nextReview) : "today"}.</p>
          ) : (
            <div className="adv-moves">
              {moves.map((m) => (
                <article key={m.id} className={`adv-move ${m.tone}`}>
                  <div className="adv-move-top"><span className="adv-kind">{m.kind}</span><span className="adv-tag">{m.tag}</span></div>
                  <div className="adv-move-title">{m.title}{m.delta !== undefined && m.delta !== null && Number.isFinite(m.delta) && <Chg c={m.delta} />}</div>
                  <div className="adv-move-short">{m.short}</div>
                  <div className="adv-move-foot">
                    <ApproveChip id={m.id} text={m.approve} />
                    <details className="adv-why2"><summary>Why</summary><p>{m.why}</p></details>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="biz-row adv-charts">
          <section className="card">
            <h2>ROAS this week <small>sales ÷ ad spend*, by branch</small></h2>
            <RoasBars floor={CUT_BELOW} title="ROAS this week by branch and service" bars={lines.filter((l) => l.t7.spend > 0).map((l) => ({
              key: l.key, group: short(l.branch), label: SERVICE_LABEL[l.service], value: l.roas7,
              tip: `${tag(l)}: ${xr(l.roas7)} this week, ${xr(l.roasP7)} last week · ${vat(l.t7.spend)} spent · ${compact(l.sales7)} sales`,
            }))} />
            <p className="small muted">Dashed line = {CUT_BELOW}x. Two weeks under it cuts the budget 20%.</p>
          </section>
          <section className="card">
            <h2>Ad health <small>{ads.filter((x) => x.a.state).length} running ads</small></h2>
            <div className="adv-stack" role="img" aria-label={counts.map((c) => `${c.n} ${STATE_LABEL[c.k]}`).join(", ")}>
              {counts.map((c) => <i key={c.k} className={`adv-flag ${c.k}`} style={{ flexGrow: c.n }} title={`${c.n} ${STATE_LABEL[c.k]}`} />)}
            </div>
            <ul className="adv-legend">
              {counts.map((c) => <li key={c.k}><i className={`adv-flag ${c.k}`} /><b>{c.n}</b> {STATE_LABEL[c.k]}</li>)}
            </ul>
            {winners.length > 0 && (
              <>
                <h3>Best ads now <small>copy their hook into new versions</small></h3>
                <ol className="adv-best">
                  {[...winners].sort((x, y) => (x.a.cpc14 ?? 1e9) - (y.a.cpc14 ?? 1e9)).slice(0, 4).map(({ l, a }) => (
                    <li key={a.id}><span><b>{a.name}</b><small>{tag(l)} · running {a.age}{a.agePlus ? "+" : ""} days</small></span><em>{a.cpc14 === null ? "–" : `₱${a.cpc14.toFixed(0)}*`}<small>a chat</small></em></li>
                  ))}
                </ol>
              </>
            )}
            <p className="small muted">Each ad is judged against its own best 14 days, not its age. Winners keep their budget however long they run.</p>
          </section>
        </div>

        <section className="card adv-table">
          <h2>By branch and service <small>tap a row for ad sets, ads and set-up</small></h2>
          <div className="adv-thead" aria-hidden="true"><span>Line</span><span>Budget/day</span><span>ROAS 7d</span><span>Chats, 28 days</span><span>Move</span></div>
          {BRANCH_ORDER.map((code) => lines.filter((l) => l.branch === code).map((l, i) => (
            <details key={l.key} className={`adv-row ${ACTION_CLASS[l.action]}`}>
              <summary>
                <span className="adv-c-name"><b>{tag(l)}</b><small>{roleOf(i, l.share)} · {Math.round(l.share * 100)}% of sales</small></span>
                <span className="adv-c-num"><small>Budget</small>{l.budget ? peso(l.budget) : "–"}</span>
                <span className="adv-c-num"><small>ROAS</small>{xr(l.roas7)} <Delta now={l.roas7} prev={l.roasP7} /></span>
                <span className="adv-c-spark">{l.days.some((d) => d.m > 0) && <GoldSpark values={l.days.map((d) => d.m)} id={`sp-${l.key.replace(/\W/g, "")}`} label={`${tag(l)} chats per day`} w={120} h={30} />}</span>
                <span className={`pill adv-act ${ACTION_CLASS[l.action]}`}>{ACTION_LABEL[l.action]}</span>
              </summary>
              <LineDetail l={l} branchName={nameOf[l.branch] ?? l.branch} play={playLine(l.branch, l.service)} today={today} />
            </details>
          )))}
        </section>

        <section className="card adv-market">
          <h2>Market <small>Philippines only · our own numbers first</small></h2>
          {pb.radar.benchmarks_note && <p className="small muted adv-note">{pb.radar.benchmarks_note.replace(/\s*US figures removed \(us_reference_hidden\)\.?/, "")}</p>}

          <h3>1 · Our numbers <small>live, last 7 days</small></h3>
          <div className="adv-tiles3">
            <div className="adv-tile">
              <div className="label">Cost per chat* by branch</div>
              <ul className="adv-bars">
                {(() => { const mx = Math.max(1, ...cpcBranch.map((x) => x.now ?? 0)); return cpcBranch.map((x) => (
                  <li key={x.code}><span>{short(x.code)}</span><i><b style={{ width: `${((x.now ?? 0) / mx) * 100}%` }} /></i><em>₱{x.now!.toFixed(0)}*</em><Delta now={x.now} prev={x.prev} goodDown /></li>
                )); })()}
              </ul>
            </div>
            <div className="adv-tile">
              <div className="label">ROAS by service</div>
              <ul className="adv-bars">
                {(() => { const mx = Math.max(RAISE_AT, ...roasSvc.map((x) => x.now ?? 0)); return roasSvc.map((x) => (
                  <li key={x.svc} className={x.now !== null && x.now < CUT_BELOW ? "low" : ""}><span>{SERVICE_LABEL[x.svc]}</span><i><b style={{ width: `${((x.now ?? 0) / mx) * 100}%` }} /></i><em>{xr(x.now)}</em><Delta now={x.now} prev={x.prev} /></li>
                )); })()}
              </ul>
            </div>
            <div className="adv-tile">
              <div className="label">Us vs the Philippine market</div>
              <dl className="adv-vs">
                <div><dt>Cost per chat*</dt><dd><b>{cpc7 === null ? "–" : `₱${cpc7.toFixed(0)}*`}</b> <span className="muted">{mkt.refs.chat.label}</span>{vsRange(cpc7 === null ? null : cpc7 / 1.12, mkt.refs.chat.lo, mkt.refs.chat.hi)}</dd></div>
                <div><dt>CPM*</dt><dd><b>{ourCpm === null ? "–" : `₱${ourCpm.toFixed(0)}*`}</b> <span className="muted">{mkt.refs.cpm.label}</span>{vsMedian(ourCpm === null ? null : ourCpm / 1.12, mkt.refs.cpm.median)}</dd></div>
                <div><dt>Cost per click*</dt><dd><b>{ourCpcl === null ? "–" : `₱${ourCpcl.toFixed(1)}*`}</b> <span className="muted">{mkt.refs.cpc.label}</span>{vsMedian(ourCpcl === null ? null : ourCpcl / 1.12, mkt.refs.cpc.median)}</dd></div>
                <div><dt>Click rate</dt><dd><b>{ourCtr === null ? "–" : `${(ourCtr * 100).toFixed(1)}%`}</b></dd></div>
              </dl>
              <p className="small muted">PH figures are before VAT and cover all industries; compared before VAT.</p>
            </div>
          </div>
          {tier(1).length > 0 && (
            <details className="adv-fold">
              <summary>Our 2026 so far ({tier(1).length})</summary>
              <ul className="adv-list small">{tier(1).map((x) => <li key={x.metric + x.value}><b>{x.metric}</b> <span className="muted">({x.campaign_type})</span>: {x.value}</li>)}</ul>
            </details>
          )}

          <h3>2 · Competitors <small>Philippine clinics</small></h3>
          <div className="adv-comp">
            {tier(2).map((x) => {
              const pending = x.source === "pending";
              return (
                <div key={x.metric + x.value} className={`adv-tile${pending ? " pending" : ""}`}>
                  <span className="label">{x.campaign_type.replace(/^PH competitor (price|ads):?\s*/i, "").replace(/\(Meta Ad Library\)/, "Ads on Meta")} · {x.metric}</span>
                  {pending ? <span className="pill adv-st proposed">Not read yet</span> : null}
                  <p className="small adv-comp-v">{pending ? mkt.ad_library.note : x.value}</p>
                  {!pending && <p className="small muted"><Sources s={x.source} /></p>}
                  {pending && <div className="adv-chips">{mkt.ad_library.searches.map((q) => <a key={q.label} className="chip" href={q.url} target="_blank" rel="noreferrer">{q.label} ↗</a>)}</div>}
                </div>
              );
            })}
          </div>

          <h3>3 · Philippine Meta costs</h3>
          <ul className="adv-list small">{tier(3).map((x) => <li key={x.metric + x.value}><b>{x.campaign_type}, {x.metric}:</b> {x.value} <span className="muted"><Sources s={x.source} /></span></li>)}</ul>
        </section>

        <section className="card">
          <h2>Opportunities <small>{proposedPerDay() ? `${peso(proposedPerDay())}/day waiting for your OK` : "new money goes to new offers"}</small></h2>
          <div className="adv-opps">
            {newAdSets().map((p) => (
              <details key={p.ad_set_name} className="adv-tile adv-opp">
                <summary>
                  <span className="label">New ad set</span>
                  <span className="adv-opp-title">{p.service_name}</span>
                  <span className="adv-big">{p.daily_budget_pre_vat ? `${peso(p.daily_budget_pre_vat)}/day` : "₱0"}</span>
                  <span className={`pill adv-st ${p.status}`}>{statusLabel(p.status)}</span>
                </summary>
                <Setup p={p} />
              </details>
            ))}
            {pb.radar.untapped.map((u) => (
              <details key={u.service} className="adv-tile adv-opp">
                <summary>
                  <span className="label">Untapped service</span>
                  <span className="adv-opp-title">{u.service}</span>
                  <span className="adv-big">{u.budget_day_pre_vat ? `test ${peso(u.budget_day_pre_vat)}/day` : "no extra budget"}</span>
                </summary>
                <p className="small">{u.why}</p>
                <p className="small"><b>Set-up:</b> {u.setup}</p>
                <p className="small"><b>Ad:</b> {u.creative_brief}</p>
                <p className="small muted">Sources: <Sources s={u.evidence.join(" ; ")} /></p>
              </details>
            ))}
            <details className="adv-tile adv-opp">
              <summary>
                <span className="label">Retargeting</span>
                <span className="adv-opp-title">Bring back people who chatted</span>
                <span className="adv-big">{peso(pb.radar.retargeting.budget_day_pre_vat)}/day per page</span>
              </summary>
              <p className="small">{pb.radar.retargeting.setup}</p>
              <ul className="adv-list small">{pb.radar.retargeting.audiences.map((a) => <li key={a}>{a}</li>)}</ul>
              <p className="small"><b>Ads:</b> {pb.radar.retargeting.creative_plan}</p>
              {pb.radar.retargeting.benchmarks.map((x) => <p key={x.metric} className="small muted"><b>{x.metric}:</b> {x.value}</p>)}
            </details>
            {pb.radar.growth_signals && (
              <details className="adv-tile adv-opp">
                <summary>
                  <span className="label">Growth check</span>
                  <span className="adv-opp-title">Does more spend bring more sales?</span>
                  <span className="adv-big">Not on the same ads</span>
                </summary>
                <ul className="adv-list small">{pb.radar.growth_signals.findings.map((f) => <li key={f}>{f}</li>)}</ul>
                <ul className="adv-acts small">
                  {pb.radar.growth_signals.actions.map((a) => <li key={a.what}><span>{a.what}</span>{a.status && <span className={`pill adv-st ${a.status}`}>{statusLabel(a.status)}</span>}</li>)}
                </ul>
              </details>
            )}
            {(pb.radar.service_gaps?.length ?? 0) > 0 && (
              <details className="adv-tile adv-opp">
                <summary>
                  <span className="label">Sales vs ad spend</span>
                  <span className="adv-opp-title">Services selling with little ad money</span>
                  <span className="adv-big">{pb.radar.service_gaps!.length} services</span>
                </summary>
                <ul className="adv-gaps">
                  {pb.radar.service_gaps!.map((g) => (
                    <li key={g.service}>
                      <div className="adv-gap-top"><b>{g.service}</b><span className={`adv-verdict ${g.verdict.split(":")[0]}`}>{g.verdict}</span></div>
                      <div className="small">{peso(g.nov1_24_sales_php)} sales Nov 1–24 · {g.new_clients} new clients · ad spend {g.ad_spend_share_last30d}</div>
                    </li>
                  ))}
                </ul>
                {pb.radar.service_gaps_note && <p className="small muted">{pb.radar.service_gaps_note}</p>}
              </details>
            )}
          </div>
          <details className="adv-fold">
            <summary>What works in 2026</summary>
            <ul className="adv-trends">
              {pb.radar.trends.map((t) => <li key={t.title}><b>{t.title}.</b> {t.detail} <span className="small muted"><Sources s={t.source} /></span></li>)}
            </ul>
          </details>
        </section>

        <details className="card biz-more">
          <summary>How the advisor decides</summary>
          <ul className="adv-list small">
            {pb.rules.map((r) => <li key={r}>{r}</li>)}
            <li>ROAS here = the line&apos;s share of the branch&apos;s declared sales ({fromLog === 4 ? "shares from the last 4 weeks of the Service log" : "November 2026 Service log shares where the last 4 weeks are thin"}) ÷ ad spend with VAT, week by week. Weeks run {fmtDay(res.w7)}–{fmtDay(res.end)}.</li>
            {pb.refresh_rule ? <>
              <li>{pb.refresh_rule.principle} {pb.refresh_rule.baseline}</li>
              {pb.refresh_rule.states.map((x) => <li key={x.state}><b>{x.state[0].toUpperCase() + x.state.slice(1)}:</b> {x.test}. {x.action}</li>)}
              {pb.refresh_rule.cadence.map((c) => <li key={c}>{c}</li>)}
              {pb.refresh_rule.sales_and_foot_traffic.map((c) => <li key={c}>{c}</li>)}
              <li>Frequency and quality ranking aren&apos;t in the daily feed yet, so the app checks cost per chat and click rate; check the other two in Ads Manager.</li>
            </> : null}
            <li>Sales come first: sales per chat shows what a chat is worth in sales, because more chats haven&apos;t meant more sales in 2026.</li>
            <li>An ad set needs about {LEARN_PER_WEEK} chats a week to leave Meta&apos;s learning phase.</li>
            <li>December: {pb.december.daily_shape} {pb.december.reserve_rule}</li>
          </ul>
          <p className="small muted">Playbook updated {fmtDay(pb.updated)} · <a href={pb.master_plan} target="_blank" rel="noreferrer">master plan</a> · <a href={pb.catalog_sheet} target="_blank" rel="noreferrer">video library</a>. Nothing changes in Meta until you OK a preview.</p>
        </details>

        <p className="small muted ads-foot">* = amount spent with 12% VAT. Budgets are before VAT (what you type in Ads Manager). <Link href="/business/ads">Back to Ads</Link></p>
      </main>
    </>
  );
}

type Move = { id: string; tone: string; tag: string; kind: string; title: string; short: string; why: string; approve: string; delta?: number | null };
type PhMarket = {
  refs: { cpm: { label: string; median: number }; cpc: { label: string; median: number }; chat: { label: string; lo: number; hi: number } };
  ad_library: { note: string; searches: { label: string; url: string }[] };
};

/** Cost vs a PH median or range (before VAT): lower is better. */
function vsMedian(ours: number | null, median: number) {
  if (ours === null) return null;
  const c = ours / median - 1;
  return <span className={`chg ${c <= 0 ? "up" : "neu"}`}>{Math.abs(Math.round(c * 100))}% {c <= 0 ? "under" : "over"} median</span>;
}
function vsRange(ours: number | null, lo: number, hi: number) {
  if (ours === null) return null;
  return ours < lo ? <span className="chg up">below range</span> : ours > hi ? <span className="chg down">above range</span> : <span className="chg neu">mid-range</span>;
}

/** ▲▼ change pill; goodDown = lower is better (cost per chat), tone "neu" = neither good nor bad (spend). */
function Delta({ now, prev, goodDown, tone, suffix }: { now: number | null; prev: number | null; goodDown?: boolean; tone?: "neu"; suffix?: string }) {
  if (now === null || prev === null || !(prev > 0)) return null;
  const c = now / prev - 1;
  if (!Number.isFinite(c)) return null;
  const good = goodDown ? c <= 0 : c >= 0;
  return <span className={`chg ${tone ?? (good ? "up" : "down")}`}>{c >= 0 ? "▲" : "▼"} {Math.abs(Math.round(c * 100))}%{suffix ? ` ${suffix}` : ""}</span>;
}

function Sources({ s }: { s: string }) {
  return <>{links(s).map((x, i) => <span key={i}>{i ? " · " : ""}{x.href ? <a href={x.href} target="_blank" rel="noreferrer">{x.label}</a> : x.label}</span>)}</>;
}

function LineDetail({ l, branchName, play, today }: { l: LineView; branchName: string; play: PlayLine | null; today: string }) {
  const pc = perChat(l.t7), pcp = perChat(l.p7);
  return (
    <div className="adv-detail">
      <p className="adv-headline"><b>{l.headline}.</b> {l.why}</p>
      {l.t7.spend > 0 || l.p7.spend > 0 ? (
        <div className="adv-nums">
          <span><small>Spent 7 days</small>{vat(l.t7.spend)} <Delta now={l.t7.spend} prev={l.p7.spend} tone="neu" /></span>
          <span><small>Chats</small>{l.t7.msgs.toLocaleString("en-US")} <Delta now={l.t7.msgs} prev={l.p7.msgs} /></span>
          <span><small>Per chat</small>{pc === null ? "–" : `₱${pc.toFixed(0)}*`} <Delta now={pc} prev={pcp} goodDown /></span>
          <span><small>Sales 7 days</small>{compact(l.sales7)} <Delta now={l.sales7} prev={l.salesP7} /></span>
          <span title="This line's share of the branch's sales ÷ its chats: what a chat is worth in sales"><small>Sales per chat</small>{l.salesPerChat === null ? "–" : `₱${Math.round(l.salesPerChat).toLocaleString("en-US")}`}</span>
          <span><small>ROAS, 4 weeks</small><span className="adv-wk">{l.roasWeeks.map((r, i) => <em key={i} className={r !== null && r < CUT_BELOW ? "low" : ""}>{xr(r)}</em>)}</span></span>
        </div>
      ) : null}

      {l.adsets.map((s) => (
        <div key={s.id} className={`adv-set${s.mismatch ? " warn" : ""}`}>
          <b>Ad set now:</b> {s.name} <span className="muted">({s.t7.msgs} chats this week{s.learnShort ? `, under ${LEARN_PER_WEEK}: still learning` : ""})</span>
          {s.text && <div className="small">{s.text}</div>}
          {s.mismatch && <div className="small bad">Aimed at the wrong area: the pin is nearest the other branch. Move it to {branchName}.</div>}
        </div>
      ))}

      {l.ads.length > 0 && (
        <details open={l.ads.some((a) => a.state && a.state !== "STEADY" && a.state !== "NEW")}>
          <summary>Ads ({l.ads.filter((a) => a.status === "ACTIVE").length} running)</summary>
          <ul className="adv-ads">
            {l.ads.map((a) => (
              <li key={a.id}>
                <div className="adv-ad-top"><b>{a.name}</b>{a.state ? <span className={`pill adv-flag ${a.state}`}>{STATE_LABEL[a.state]}</span> : null}</div>
                <div className="small adv-ad-facts">
                  {a.status === "ACTIVE" ? `running ${a.age}${a.agePlus ? "+" : ""} days` : a.status.toLowerCase().replace(/_/g, " ")} · {vat(a.t14.spend)} in 14 days · {a.t14.msgs.toLocaleString("en-US")} chats · {a.cpc14 === null ? "–" : `₱${a.cpc14.toFixed(0)}*`} a chat
                </div>
                {a.why && <div className="small muted">{a.why}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {play && (
        <details>
          <summary>Recommended set-up and videos</summary>
          <Setup p={play} />
        </details>
      )}
      <p className="small muted adv-next">Next review: {l.nextReview > today ? fmtDay(l.nextReview) : "today"}{l.lastChange ? ` · budget last changed ${fmtDay(l.lastChange)}` : ""}</p>
    </div>
  );
}

function Setup({ p }: { p: PlayLine }) {
  const a = p.audience;
  const vids = PLAYBOOK.videos;
  return (
    <div className="adv-setup">
      <dl>
        <dt>Ad set</dt><dd>{p.ad_set_name} · {p.daily_budget_pre_vat ? `${peso(p.daily_budget_pre_vat)}/day` : "off"}</dd>
        <dt>Goal</dt><dd>{p.objective}</dd>
        <dt>Audience</dt>
        <dd>
          {a.mode === "advantage_plus" ? "Advantage+ audience" : a.mode === "custom_audiences" ? "Custom audiences (no Advantage+ expansion)" : "Detailed targeting"} · ages {a.age_min}–{a.age_max} · {a.genders === "all" ? "all genders" : a.genders}
          {a.interests.length > 0 && <> · suggestions: {a.interests.join(", ")}</>}
          {a.behaviors.length > 0 && <> · behaviours: {a.behaviors.join(", ")}</>}
          {a.note && <div className="small muted">{a.note}</div>}
        </dd>
        <dt>Location</dt><dd>{p.geo.include.join("; ")}{p.geo.exclude.length > 0 && <><br /><span className="muted">Exclude: {p.geo.exclude.join("; ")}</span></>}</dd>
        <dt>Placements</dt><dd>{p.placements}</dd>
      </dl>
      {p.creatives.length > 0 && (
        <ul className="adv-vids">
          {p.creatives.map((c, i) => (
            <li key={i}>
              <span className="pill adv-v">{c.v ?? "Find"}</span>
              <span><b>{c.v ? vids[c.v]?.title ?? c.ad_name ?? c.v : c.ad_name}</b> <span className="muted">({c.role})</span> {c.why}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="small">{p.rationale}</p>
      <p className="small muted">Goal: about ₱{p.kpis.target_cost_per_chat_vat}* a chat. Raise at {p.kpis.scale_if_weekly_real_roas_at_least}x a week; cut under {p.kpis.trim_if_real_roas_below_for_2_weeks}x for 2 weeks. Check every {p.review_after_days} days.</p>
    </div>
  );
}
