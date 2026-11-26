import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Playfair_Display } from "next/font/google";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { peso, shortName, type PlanStep } from "@/lib/promoRules";
import { doneCount, nextDue, planStatus, type Log, type PromoPart } from "@/lib/promoTrack";
import { ScheduleView } from "./ScheduleView";

const serif = Playfair_Display({ subsets: ["latin"], weight: ["600", "700"], display: "swap" });

type Card = {
  ok: boolean; error?: string; manage?: boolean;
  client: { id: string; name: string; contact: string | null; branch: string; start_on: string; ends_on: string; price_cents: number; schedule: PlanStep[]; state: "ACTIVE" | "DONE" | "CANCELLED" };
  promo: { id: string; title: string; parts: PromoPart[]; pay_service_id: string | null; state: string };
  logs: { service_id: string; date: string; n: number; amount_cents: number }[];
};
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** One client's promo (update-0087): the recommended schedule to send them, and the clinic's copy with what's done. */
export default async function PromoClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, access } = await requireAccess();
  const { data, error } = await supabase.rpc("promo_client_card", { p_id: id });
  const c = data as Card | null;
  if (error || !c?.ok) {
    return (<><TopBar access={access} /><main><h1>Client promo</h1><div className="notice info">
      {error?.code === "PGRST202" ? "The owner needs to run update-0087 in Supabase first." : c?.error === "NOT_FOUND" ? "That client's promo wasn't found." : "You can't open this page."}
    </div></main></>);
  }
  const today = manilaToday();
  const logs: Log[] = c.logs.map((l) => ({ ...l, amount_cents: Number(l.amount_cents) }));
  const parts = c.promo.parts;
  const names = Object.fromEntries(parts.map((p) => [p.service_id, shortName(p.name)]));
  const totals = Object.fromEntries(parts.map((p) => [p.service_id, p.sessions]));
  const done = doneCount(logs);
  const plan = planStatus(c.client.schedule, logs);
  const next = c.client.state === "ACTIVE" ? nextDue(c.client.schedule, logs, today) : null;
  const paid = logs.reduce((s, l) => s + l.amount_cents, 0);
  const sessionsDone = parts.reduce((s, p) => s + Math.min(p.sessions, done[p.service_id] ?? 0), 0);
  const sessionsAll = parts.reduce((s, p) => s + p.sessions, 0);
  // Sessions done that aren't on the plan (logged on other days) still count; they show in the progress, not the list.
  return (
    <>
      <TopBar access={access} />
      <main className="promos">
        <p className="small"><Link href={c.manage ? `/promos/${c.promo.id}` : "/services"}>← {c.manage ? c.promo.title : "Service log"}</Link></p>
        <h1>{c.client.name}</h1>
        <p className="muted small">
          {c.promo.title} · started {day(c.client.start_on)} at {c.client.branch} · use by {day(c.client.ends_on)}
          {c.client.contact ? ` · ${c.client.contact}` : ""}
        </p>
        {c.client.state !== "ACTIVE" && <div className="notice info">{c.client.state === "DONE" ? "All sessions are done." : "This client's promo was cancelled."}</div>}
        {next && (
          <div className={`notice ${next.overdue ? "warn" : "info"}`}>
            Next: <strong>{names[next.s]} {next.n} of {totals[next.s]}</strong>, planned {day(next.d)}
            {next.overdue ? `, ${next.late} days ago. Message the client to book.` : next.due ? " (due now)." : "."}
          </div>
        )}
        <div className="grid">
          <div className="card stat">
            <div className="label">Sessions done</div>
            <div className="value">{sessionsDone} of {sessionsAll}</div>
            {parts.map((p) => (
              <div key={p.service_id} className="promo-progress">
                <span className="small">{names[p.service_id]}: {Math.min(p.sessions, done[p.service_id] ?? 0)} of {p.sessions}</span>
                <span className="bar" aria-hidden><span style={{ width: `${Math.round((100 * Math.min(p.sessions, done[p.service_id] ?? 0)) / p.sessions)}%` }} /></span>
              </div>
            ))}
          </div>
          <div className="card stat">
            <div className="label">Paid</div>
            <div className="value">{peso(paid)}</div>
            <div className="note">of {peso(Number(c.client.price_cents))}{paid < Number(c.client.price_cents) ? `, ${peso(Number(c.client.price_cents) - paid)} left to pay` : ", fully paid"}</div>
          </div>
        </div>
        <ScheduleView
          id={c.client.id} title={c.promo.title} client={c.client.name} ends={c.client.ends_on} start={c.client.start_on} today={today}
          plan={plan} names={names} totals={totals} parts={parts} logs={logs} manage={!!c.manage} active={c.client.state === "ACTIVE"}
          cancelled={c.client.state === "CANCELLED"} serif={serif.style.fontFamily} serifClass={serif.className}
        />
      </main>
    </>
  );
}
