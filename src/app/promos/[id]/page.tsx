import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { justify, peso, shortName, type PlanStep, type Pkg } from "@/lib/promoRules";
import { nextDue, promoMoney, type ClientRow, type LogRow, type PromoPart } from "@/lib/promoTrack";
import { CostForm } from "./CostForm";
import { payStatus, SLOT_LABEL, type PostSlot } from "@/lib/promoPay";
import { CopyText } from "../post/PostCard";

type Client = ClientRow & { payments?: number; client_name: string; branch_id: string; start_on: string; ends_on: string; schedule: PlanStep[]; contact: string | null };
type L = { id: string; promo_client_id: string; service_id: string; service_date: string; session_no: number; amount_paid_cents: number };

async function chunks<T>(ids: string[], f: (part: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...((await f(ids.slice(i, i + 150))).data ?? []));
  return out;
}
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

/** Promo tracker (update-0087, CHRIS Nov 27): every client on a promo, sessions left, who to follow up, and the running profit. */
export default async function PromoTracker({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, access, branches } = await requireAccess();
  if (!(can(access, ["OWNER"], null) || can(access, ["MANAGER"], null))) {
    return (<><TopBar access={access} /><main><h1>Promo</h1><div className="notice info">Only owners and the GM can see promo tracking.</div></main></>);
  }
  const { data: p } = await supabase.from("promos").select("*").eq("id", id).maybeSingle();
  if (!p) notFound();
  const parts = (p.parts ?? []) as PromoPart[];
  const installment = p.pay_options === "INSTALLMENT";
  if (!parts.length) {
    return (<><TopBar access={access} /><main className="promos"><p className="small"><Link href="/promos">← Promos</Link></p><h1>{p.title}</h1>
      <div className="notice info">{p.state === "DRAFT" ? "This promo is still a draft. Approve it on the Promos page to start tracking clients." : "The owner needs to run update-0087 in Supabase first, then this promo's clients are tracked here."}</div></main></>);
  }
  const today = manilaToday();
  const { data: cData } = await supabase.from("promo_clients").select("*").eq("promo_id", id).order("start_on", { ascending: false });
  const clients = (cData ?? []) as Client[];
  const logs = await chunks<L>(clients.map((c) => c.id), (ids) =>
    supabase.from("service_logs").select("id, promo_client_id, service_id, service_date, session_no, amount_paid_cents").in("promo_client_id", ids).neq("state", "REJECTED"));
  const lines = await chunks<{ service_log_id: string; amount_cents: number }>(logs.map((l) => l.id), (ids) =>
    supabase.from("commission_lines").select("service_log_id, amount_cents").in("service_log_id", ids));
  const commissionOf = new Map<string, number>();
  for (const x of lines) commissionOf.set(x.service_log_id, (commissionOf.get(x.service_log_id) ?? 0) + Number(x.amount_cents));
  const { data: base } = await supabase.from("services").select("*").in("id", parts.map((x) => x.base_id));
  const cost = Object.fromEntries(((base ?? []) as { id: string; cost_cents?: number | null }[]).map((s) => [s.id, s.cost_cents == null ? null : Number(s.cost_cents)]));
  const usual = Object.fromEntries(((base ?? []) as { id: string; price_cents: number | null; commission_cents: number | null }[]).map((s) => [s.id, s.commission_cents ?? Math.round(Number(s.price_cents ?? 0) * 0.05)]));
  // CHRIS Nov 27: the price justification, management only (this page is owners and the GM).
  const { data: pkRows } = await supabase.from("services").select("*").eq("active", true);
  const pkgs: Pkg[] = ((pkRows ?? []) as { name: string; session_prices?: number[] | null }[]).filter((x) => Array.isArray(x.session_prices) && x.session_prices.length > 0)
    .map((x) => ({ name: x.name, total: (x.session_prices ?? []).reduce((a, b) => a + Number(b || 0), 0) }));
  const items = ((p.items ?? []) as { service_id: string; name: string; paid: number; free: number; unit_cents: number }[])
    .map((i) => ({ service_id: i.service_id, name: i.name, unit: Number(i.unit_cents), paid: i.paid, free: i.free }));
  const why = justify(items, Number(p.price_cents), { pkgs, usual, cost });
  const rows: LogRow[] = logs.map((l) => ({ promo_client_id: l.promo_client_id, service_id: l.service_id, amount_paid_cents: Number(l.amount_paid_cents), commission_cents: commissionOf.get(l.id) ?? 0 }));
  const money = promoMoney(parts, clients, rows, cost, Number(p.price_cents));
  const bName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const byClient = (cid: string) => logs.filter((l) => l.promo_client_id === cid).map((l) => ({ service_id: l.service_id, date: l.service_date, n: l.session_no, amount_cents: Number(l.amount_paid_cents) }));
  const list = clients.map((c) => {
    const ls = byClient(c.id);
    const doneN = parts.reduce((s, x) => s + Math.min(x.sessions, ls.filter((l) => l.service_id === x.service_id).length), 0);
    const paid = ls.reduce((s, l) => s + l.amount_cents, 0);
    const next = c.state === "ACTIVE" ? nextDue(c.schedule ?? [], ls, today) : null;
    const last = ls.map((l) => l.date).sort().at(-1) ?? null;
    // update-0091: a client on monthly payments: their next payment and whether they're behind.
    const plan = installment && (c.payments ?? 1) > 1 && c.state === "ACTIVE" ? payStatus(Number(c.price_cents), c.payments ?? 1, c.start_on, paid, today) : null;
    return { c, doneN, paid, next, last, plan };
  });
  const latePay = list.filter((x) => x.plan?.late);
  const all = parts.reduce((s, x) => s + x.sessions, 0);
  const names = Object.fromEntries(parts.map((x) => [x.service_id, shortName(x.name)]));
  // update-0091: the posting calendar and the pricing reply the CSRs use.
  const { data: postRows } = await supabase.from("promo_posts").select("slot, due_on, state, via, pricing_text").eq("promo_id", id).order("due_on");
  const posts = (postRows ?? []) as { slot: PostSlot; due_on: string; state: string; via: string | null; pricing_text: string | null }[];
  const pricing = posts.find((x) => x.pricing_text)?.pricing_text ?? null;
  const follow = list.filter((x) => x.next && (x.next.overdue || x.next.late >= -7)).sort((a, b) => (a.next!.d < b.next!.d ? -1 : 1));

  return (
    <>
      <TopBar access={access} />
      <main className="promos">
        <p className="small"><Link href="/promos">← Promos</Link></p>
        <h1>{p.title}</h1>
        <p className="muted small">
          {p.state === "APPROVED" ? "Running" : p.state === "ENDED" ? "Ended (no new clients)" : "Draft"} · {peso(Number(p.price_cents))} for {all} sessions · use within {p.valid_months} month{p.valid_months === 1 ? "" : "s"}
          {p.approved_at ? ` · approved ${day(String(p.approved_at).slice(0, 10))}` : ""}
          {installment ? ` · full payment or up to ${p.max_payments} monthly payments` : p.pay_options === "FULL" ? " · full payment" : ""}
        </p>

        <div className="grid">
          <div className="card stat hero">
            <div className="label">Profit so far</div>
            <div className="value">{peso(money.profitNow)}</div>
            <div className="note">Collected {peso(money.collected)} − commission paid {peso(money.commissionPaid)}{money.costDone ? ` − product used ${peso(money.costDone)}` : ""}</div>
            {!money.costsKnown && <div className="note" style={{ color: "var(--warn)" }}>Product costs aren&apos;t all set yet (below), so this is before some product costs.</div>}
          </div>
          <div className="card stat">
            <div className="label">Expected profit when all sessions are done</div>
            <div className="value">{peso(money.profitEnd)}</div>
            <div className="note">{pct(money.margin)} of {peso(money.sold)} sold · commission still to pay {peso(money.commissionOwed)}{money.costOwed ? ` · product still to use ${peso(money.costOwed)}` : ""}</div>
          </div>
          <div className="card stat">
            <div className="label">Clients</div>
            <div className="value">{money.clients.active + money.clients.done}</div>
            <div className="note">{money.clients.active} active · {money.clients.done} finished{money.clients.cancelled ? ` · ${money.clients.cancelled} cancelled` : ""}</div>
            <div className="note">Still to collect: {peso(money.balance)} · paid for sessions not yet done: {peso(money.unearned)}</div>
          </div>
        </div>

        <div className={`notice ${why.warnings.length ? "warn" : "info"} small promo-why`}>
          <strong>Why this price</strong> <span className="muted">(management only)</span>
          <div>{why.headline}</div>
          <ul>{why.lines.map((t) => <li key={t}>{t}</li>)}</ul>
          {why.warnings.length > 0 && <><strong>Check:</strong><ul>{why.warnings.map((t) => <li key={t}>{t}</li>)}</ul></>}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Per session</h2>
          <p className="small muted">Commission per session = 5% of the service&apos;s price per session in this promo (its share of the promo price over its sessions, free ones included), the same way Lux Queen 10+3 pays less than a solo Lux Queen. Split 60/40 when assisted. Type each service&apos;s product cost per session to see the true profit.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Service</th><th className="num">Sessions</th><th className="num">Price per session</th><th className="num">Commission</th><th className="num">Done / still owed</th><th>Product cost per session</th></tr></thead>
              <tbody>
                {money.rows.map((r) => (
                  <tr key={r.service_id}>
                    <td>{names[r.service_id]}</td>
                    <td className="num">{r.sessions}</td>
                    <td className="num">{peso(r.perSession)} <span className="muted small">(list {peso(r.unit_cents)})</span></td>
                    <td className="num">₱{(r.commission_cents / 100).toFixed(2)} <span className="muted small">(solo ₱{((usual[r.base_id] ?? 0) / 100).toFixed(2)})</span></td>
                    <td className="num">{r.done} / {r.owed}</td>
                    <td><CostForm service={r.base_id} promo={id} cents={r.cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {(posts.length > 0 || pricing) && (
          <div className="card">
            <div className="card-head"><h2 style={{ marginTop: 0 }}>Posting calendar</h2><Link className="small" href="/promos/post">Promo posts →</Link></div>
            <ul className="promo-follow">
              {posts.map((x) => (
                <li key={x.slot}>{SLOT_LABEL[x.slot]} · {day(x.due_on)}{x.slot === "LAUNCH" ? " · FB post + Story" : " · Story"}: {" "}
                  {x.state === "POSTED" ? <span className="pill PUBLISHED">Posted{x.via === "META" ? " by the app" : ""}</span> : x.state === "SKIPPED" ? <span className="pill REVERSED">Skipped</span> : x.due_on <= today ? <span className="pill STAGED">Due</span> : <span className="muted">coming up</span>}
                </li>
              ))}
            </ul>
            {pricing && (
              <details className="promo-pricing">
                <summary className="small"><strong>Reply for clients who ask</strong> (pricing)</summary>
                <pre>{pricing}</pre>
                <CopyText text={pricing} label="Copy reply" />
              </details>
            )}
          </div>
        )}

        {latePay.length > 0 && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Payments late</h2>
            <p className="small muted">Clients on monthly payments who are behind. Their next session can be logged once they pay.</p>
            <ul className="promo-follow">
              {latePay.map(({ c, plan }) => (
                <li key={c.id}><Link href={`/promos/client/${c.id}`}>{c.client_name}</Link>{c.contact ? ` · ${c.contact}` : ""}: <span className="delta down">{peso(plan!.behind)} behind</span>{plan!.next ? ` · next ${peso(plan!.next.amount)} (payment ${plan!.next.k} of ${c.payments}, due ${day(plan!.next.due)})` : ""}</li>
              ))}
            </ul>
          </div>
        )}

        {follow.length > 0 && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Follow up this week</h2>
            <p className="small muted">Clients whose next planned session is due within 7 days or already late. Message them to book.</p>
            <ul className="promo-follow">
              {follow.map(({ c, next }) => (
                <li key={c.id}>
                  <Link href={`/promos/client/${c.id}`}>{c.client_name}</Link>{c.contact ? ` · ${c.contact}` : ""}: {names[next!.s]} {next!.n}, planned {day(next!.d)}
                  {next!.overdue ? <span className="delta down"> {next!.late} days late</span> : next!.late >= 0 ? " (due now)" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Clients</h2>
          {list.length === 0 && <p className="small muted">No clients yet. When someone buys it, log their first visit in the Service log, pick this promo&apos;s item and choose &quot;New client&quot;.</p>}
          {list.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Client</th><th>Branch</th><th>Started</th><th className="num">Sessions</th><th className="num">Paid</th>{installment && <th>Payments</th>}<th>Next</th></tr></thead>
                <tbody>
                  {list.map(({ c, doneN, paid, next, last, plan }) => (
                    <tr key={c.id}>
                      <td><Link href={`/promos/client/${c.id}`}>{c.client_name}</Link>{c.state !== "ACTIVE" && <span className="muted small"> · {c.state === "DONE" ? "finished" : "cancelled"}</span>}</td>
                      <td>{bName[c.branch_id] ?? ""}</td>
                      <td>{day(c.start_on)}</td>
                      <td className="num">{doneN} / {all}</td>
                      <td className="num">{peso(paid)}{paid < Number(c.price_cents) && c.state !== "CANCELLED" ? <span className="muted small"> ({peso(Number(c.price_cents) - paid)} left)</span> : ""}</td>
                      {installment && <td className="small">{(c.payments ?? 1) <= 1 ? "Full" : plan ? <>{c.payments} monthly{plan.next ? <> · next {peso(plan.next.amount)} {day(plan.next.due)}</> : ""}{plan.late && <span className="delta down"> late</span>}</> : `${c.payments} monthly`}</td>}
                      <td className="small">{next ? <>{names[next.s]} {next.n} · {day(next.d)}{next.overdue && <span className="delta down"> late</span>}</> : c.state === "ACTIVE" ? (last ? `last visit ${day(last)}` : "") : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
