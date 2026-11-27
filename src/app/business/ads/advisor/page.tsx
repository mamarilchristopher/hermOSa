import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { compact } from "@/components/BizCharts";
import { manilaToday } from "@/lib/dates";
import { addDays } from "@/lib/insights";
import { centsOfCell } from "@/lib/business";
import type { StatusDay } from "@/lib/homeGlance";
import { adServiceOf, NOV_SHARES, SERVICE_LABEL, type AdService } from "@/lib/ads";
import { advise, fmtDay, LEARN_PER_WEEK, perChat, roleOf, type Feed, type LineView } from "@/lib/adsAdvisor";
import { links, newAdSets, PLAYBOOK, planMap, planPerDay, playLine, proposedPerDay, statusLabel, type PlayLine } from "@/lib/adsPlaybook";
import { every } from "../../load";

const MGMT = ["OWNER", "FINANCE", "AUDITOR", "MANAGER"];
const peso = (p: number) => `₱${Math.round(p).toLocaleString("en-US")}`;
const vat = (p: number) => `₱${Math.round(p * 1.12).toLocaleString("en-US")}*`;
const xr = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)}x`);
const STATE_LABEL: Record<string, string> = { WINNER: "Winner: keep", TIRING: "Tiring: add versions", FATIGUED: "Fatigued: pause + remake", LOSER: "Loser: pause", NEW: "Learning", STEADY: "Steady" };
const ACTION_CLASS: Record<string, string> = { RAISE: "up", TEST: "up", START: "up", CUT: "down", OFF: "down", KEEP: "keep", WAIT: "keep", NONE: "none" };

/** Business › Ad advisor (update-0099, CHRIS Nov 27): this week's budget moves, ads to turn off or copy, ad set set-up and videos, and the market radar. */
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
  for (const r of ((st as { days?: StatusDay[] } | null)?.days ?? [])) {
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
  const nowPerDay = lines.reduce((s, l) => s + l.budget, 0);
  const nextPerDay = lines.reduce((s, l) => s + (l.action === "NONE" ? 0 : l.newBudget), 0);
  const moves = lines.filter((l) => ["RAISE", "TEST", "CUT", "OFF", "START"].includes(l.action));
  const byState = (st: string) => lines.flatMap((l) => l.ads.filter((a) => a.state === st));
  const offAds = byState("LOSER"), fatigued = byState("FATIGUED"), tiring = byState("TIRING"), winners = byState("WINNER");
  const mismatches = lines.flatMap((l) => l.adsets.filter((s) => s.mismatch).map((s) => ({ l, s })));
  const stale = res.staleDays !== null && res.staleDays >= 2;
  const loaded = feed.loaded_at ? new Date(feed.loaded_at).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const byBranch = ["QC_MAIN", "FAIRVIEW", "STA_MARIA", "MARIKINA"].map((code) => ({ code, lines: lines.filter((l) => l.branch === code) })).filter((b) => b.lines.length);
  const nextReview = lines.map((l) => l.nextReview).filter((d) => d > today).sort()[0] ?? null;
  const pb = PLAYBOOK;

  return (
    <>
      <TopBar access={access} />
      <main className="business ads advisor">
        <div className="biz-head"><h1>Ad advisor</h1><span className="muted">what to change in Meta ads this week</span></div>
        <div className={`notice ${stale ? "warn" : "info"} adv-fresh`}>
          {res.lastDate ? <>Meta data through <b>{fmtDay(res.lastDate)}</b>{loaded ? <> · loaded {loaded}</> : null}. </> : "No Meta data yet. "}
          {feed.source === "seed" || !feed.source
            ? "These are the starting figures; the daily update starts once the Windsor export is set up (on your To-Do)."
            : stale ? `The daily update hasn't arrived for ${res.staleDays} days. Check the Windsor export.` : "Updates every day."}
          {" "}Weeks run {fmtDay(res.w7)}–{fmtDay(res.end)}.
        </div>

        <div className="biz-kpis">
          <div className="card biz-kpi">
            <div className="label">Budget a day</div>
            <div className="value">{peso(nowPerDay)}</div>
            <div className="sub muted">now · plan {peso(planPerDay())} · pre-VAT</div>
          </div>
          <div className="card biz-kpi">
            <div className="label">After this week</div>
            <div className="value">{peso(nextPerDay)}</div>
            <div className="sub muted">{moves.length ? `${moves.length} budget move${moves.length === 1 ? "" : "s"}` : "no budget moves"}</div>
          </div>
          <div className="card biz-kpi">
            <div className="label">Ads</div>
            <div className="value">{winners.length} <small className="muted">winning</small></div>
            <div className="sub muted">{offAds.length + fatigued.length} to pause · {tiring.length} tiring</div>
          </div>
          <div className="card biz-kpi">
            <div className="label">Next review</div>
            <div className="value">{nextReview ? fmtDay(nextReview) : "Now"}</div>
            <div className="sub muted">budgets change once a week at most</div>
          </div>
        </div>

        {(offAds.length > 0 || fatigued.length > 0 || mismatches.length > 0 || tiring.length > 0) && (
          <div className="card adv-todo">
            <h2>Do first</h2>
            <ul>
              {mismatches.map(({ l, s }) => <li key={s.id} className="bad"><b>{nameOf[l.branch]} {SERVICE_LABEL[l.service]}:</b> ad set &quot;{s.name}&quot; is aimed at the {nameOf[s.mismatch!] ?? s.mismatch} area, not {nameOf[l.branch]}. Move its pin to {nameOf[l.branch]}.</li>)}
              {offAds.map((a) => <li key={a.id} className="bad"><b>Pause &quot;{a.name}&quot;</b> ({a.adset}): {a.why}</li>)}
              {fatigued.map((a) => <li key={a.id} className="bad"><b>Pause and remake &quot;{a.name}&quot;</b>: {a.why}</li>)}
              {tiring.map((a) => <li key={a.id} className="warn"><b>Add 1–2 new versions next to &quot;{a.name}&quot;</b>: {a.why}</li>)}
            </ul>
          </div>
        )}

        {pb.radar.growth_signals && (
          <section className="card adv-growth">
            <h2>Does more spend bring more sales? <small>45 weeks of 2026</small></h2>
            <ul className="adv-list">{pb.radar.growth_signals.findings.map((f) => <li key={f}>{f}</li>)}</ul>
            <h3>So</h3>
            <ul className="adv-acts">
              {pb.radar.growth_signals.actions.map((a) => (
                <li key={a.what}>
                  <span>{a.what}</span>
                  {a.status && <span className={`pill adv-st ${a.status}`}>{statusLabel(a.status)}</span>}
                </li>
              ))}
            </ul>
            <p className="small muted">{pb.radar.growth_signals.source.replace(/\.?\s*Monthly table:.*$/, ".")}</p>
          </section>
        )}

        {byBranch.map((b) => (
          <section key={b.code} className="card adv-branch">
            <h2>{nameOf[b.code] ?? b.code}</h2>
            {b.lines.map((l, i) => <LineCard key={l.key} l={l} rank={i} branchName={nameOf[b.code] ?? b.code} play={playLine(l.branch, l.service)} today={today} />)}
          </section>
        ))}

        <section className="card">
          <h2>New ad sets <small>pre-VAT a day{proposedPerDay() ? ` · ${peso(proposedPerDay())}/day waiting for your OK` : ""}</small></h2>
          {pb.proposed_note && <p className="small muted">{pb.proposed_note.replace(/^Lines with status 'proposed'/, "New ad sets").replace(/CHRIS's OK/g, "your OK").replace(/the ALL_TEST/g, "the testing ad set's")}</p>}
          <div className="adv-new">
            {newAdSets().map((p) => (
              <details key={p.ad_set_name}>
                <summary><b>{p.service_name}</b> · {p.daily_budget_pre_vat ? `${peso(p.daily_budget_pre_vat)}/day` : "₱0"} <span className={`pill adv-st ${p.status}`}>{statusLabel(p.status)}</span></summary>
                <Setup p={p} />
              </details>
            ))}
          </div>
        </section>

        {(pb.radar.service_gaps?.length ?? 0) > 0 && (
          <section className="card">
            <h2>Sales by service vs ad spend <small>Nov 1–24 Service log</small></h2>
            <ul className="adv-gaps">
              {pb.radar.service_gaps!.map((g) => (
                <li key={g.service}>
                  <div className="adv-gap-top"><b>{g.service}</b><span className={`adv-verdict ${g.verdict.split(":")[0]}`}>{g.verdict}</span></div>
                  <div className="small">
                    {peso(g.nov1_24_sales_php)} sales · {g.new_clients} new clients · ad spend {g.ad_spend_share_last30d}
                    {g.break_even_close_rate_for_5x ? <> · 5x needs {g.break_even_close_rate_for_5x} of chats to buy{g.assumed_cost_per_chat_vat ? ` (₱${g.assumed_cost_per_chat_vat}* a chat, ₱${Number(g.typical_ticket_php).toLocaleString("en-US")} ticket)` : ""}</> : null}
                  </div>
                  <div className="small muted">{g.by_branch}</div>
                </li>
              ))}
            </ul>
            {pb.radar.service_gaps_note && <p className="small muted">{pb.radar.service_gaps_note}</p>}
          </section>
        )}

        <section className="card">
          <h2>Untapped services worth testing</h2>
          <div className="adv-radar">
            {pb.radar.untapped.map((u) => (
              <details key={u.service}>
                <summary><b>{u.service}</b>{u.budget_day_pre_vat ? <> · test {peso(u.budget_day_pre_vat)}/day</> : <> · no extra budget</>}</summary>
                <p>{u.why}</p>
                <p><b>Set-up:</b> {u.setup}</p>
                <p><b>Ad:</b> {u.creative_brief}</p>
                <p className="small muted">Sources: {u.evidence.flatMap(links).map((x, i) => <span key={i}>{i ? " · " : ""}{x.href ? <a href={x.href} target="_blank" rel="noreferrer">{x.label}</a> : x.label}</span>)}</p>
              </details>
            ))}
          </div>
        </section>

        <div className="biz-row">
          <section className="card">
            <h2>Retargeting <small>{peso(pb.radar.retargeting.budget_day_pre_vat)}/day per page to start</small></h2>
            <p className="small">{pb.radar.retargeting.setup}</p>
            <ul className="adv-list">{pb.radar.retargeting.audiences.map((a) => <li key={a}>{a}</li>)}</ul>
            <p className="small"><b>Ads:</b> {pb.radar.retargeting.creative_plan}</p>
            <table className="ads-table adv-bench">
              <tbody>
                {pb.radar.retargeting.benchmarks.map((x) => (
                  <tr key={x.metric}><td>{x.metric}</td><td>{x.value}</td><td className="small">{links(x.source).map((s, i) => <span key={i}>{i ? " · " : ""}{s.href ? <a href={s.href} target="_blank" rel="noreferrer">{s.label}</a> : s.label}</span>)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <h2>What works in 2026</h2>
            <ul className="adv-trends">
              {pb.radar.trends.map((t) => (
                <li key={t.title}><b>{t.title}.</b> {t.detail} <span className="small muted">{links(t.source).map((s, i) => <span key={i}>{i ? " · " : ""}{s.href ? <a href={s.href} target="_blank" rel="noreferrer">{s.label}</a> : s.label}</span>)}</span></li>
              ))}
            </ul>
          </section>
        </div>

        <section className="card">
          <h2>Benchmarks <small>local clinic ads vs ours</small></h2>
          <div className="table-wrap">
            <table className="ads-table adv-bench">
              <thead><tr><th>Campaign type</th><th>Measure</th><th>Value</th><th>Source</th></tr></thead>
              <tbody>
                {pb.radar.benchmarks.map((x) => (
                  <tr key={x.campaign_type + x.metric}><td>{x.campaign_type}</td><td>{x.metric}</td><td>{x.value}</td>
                    <td className="small">{links(x.source).map((s, i) => <span key={i}>{i ? " · " : ""}{s.href ? <a href={s.href} target="_blank" rel="noreferrer">{s.label}</a> : s.label}</span>)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">{pb.radar.note}</p>
        </section>

        <details className="card biz-more">
          <summary>How the advisor decides</summary>
          <ul className="adv-list small">
            {pb.rules.map((r) => <li key={r}>{r}</li>)}
            <li>ROAS here = the line&apos;s share of the branch&apos;s declared sales ({fromLog === 4 ? "shares from the last 4 weeks of the Service log" : "November 2026 Service log shares where the last 4 weeks are thin"}) ÷ ad spend with VAT, week by week.</li>
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

function LineCard({ l, rank, branchName, play, today }: { l: LineView; rank: number; branchName: string; play: PlayLine | null; today: string }) {
  const pc = perChat(l.t7);
  const role = roleOf(rank, l.share);
  return (
    <article className={`adv-line ${ACTION_CLASS[l.action]}`}>
      <header>
        <div>
          <div className="adv-svc">{SERVICE_LABEL[l.service]} <span className="muted">· {role} ({Math.round(l.share * 100)}% of {branchName} sales)</span></div>
          <div className="adv-move">{l.headline}</div>
        </div>
        {play && <span className="pill adv-status">{statusLabel(play.status)}</span>}
      </header>
      <p className="adv-why">{l.why}</p>
      {l.t7.spend > 0 || l.p7.spend > 0 ? (
        <div className="adv-nums">
          <span><small>Spent 7 days</small>{vat(l.t7.spend)}</span>
          <span><small>Chats</small>{l.t7.msgs.toLocaleString("en-US")}</span>
          <span><small>Per chat</small>{pc === null ? "–" : `₱${pc.toFixed(0)}*`}</span>
          <span><small>ROAS</small>{xr(l.roas7)} <em className="muted">prev {xr(l.roasP7)}</em></span>
          <span><small>Sales 7 days</small>{compact(l.sales7)}</span>
          <span title="This line's share of the branch's sales ÷ its chats: what a chat is worth in sales"><small>Sales per chat</small>{l.salesPerChat === null ? "–" : `₱${Math.round(l.salesPerChat).toLocaleString("en-US")}`}</span>
        </div>
      ) : null}

      {l.adsets.map((s) => (
        <div key={s.id} className={`adv-set${s.mismatch ? " warn" : ""}`}>
          <b>Now:</b> {s.name} <span className="muted">({s.t7.msgs} chats this week{s.learnShort ? `, under ${LEARN_PER_WEEK}: still learning` : ""})</span>
          {s.text && <div className="small">{s.text}</div>}
          {s.mismatch && <div className="small bad">Aimed at the wrong area: the pin is nearest the other branch. Move it to {branchName}.</div>}
        </div>
      ))}

      {play && (
        <details>
          <summary>Recommended set-up and videos</summary>
          <Setup p={play} />
        </details>
      )}

      {l.ads.length > 0 && (
        <details>
          <summary>Ads ({l.ads.filter((a) => a.status === "ACTIVE").length} running)</summary>
          <ul className="adv-ads">
            {l.ads.map((a) => {
              const note = a.why;
              const pill = a.state ? <span className={`pill adv-flag ${a.state}`}>{STATE_LABEL[a.state]}</span> : null;
              return (
                <li key={a.id}>
                  <div className="adv-ad-top"><b>{a.name}</b>{pill}</div>
                  <div className="small adv-ad-facts">
                    {a.status === "ACTIVE" ? `running ${a.age}${a.agePlus ? "+" : ""} days` : a.status.toLowerCase().replace(/_/g, " ")} · {vat(a.t14.spend)} in 14 days · {a.t14.msgs.toLocaleString("en-US")} chats · {a.cpc14 === null ? "–" : `₱${a.cpc14.toFixed(0)}*`} a chat
                  </div>
                  {note && <div className="small muted">{note}</div>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <p className="small muted adv-next">Next review: {l.nextReview > today ? fmtDay(l.nextReview) : "today"}{l.lastChange ? ` · budget last changed ${fmtDay(l.lastChange)}` : ""}</p>
    </article>
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
