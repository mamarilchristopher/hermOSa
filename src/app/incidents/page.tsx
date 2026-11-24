import Link from "next/link";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { dayLabel } from "@/lib/homeGlance";
import { IR_STATE, minutesText, type Ir } from "@/lib/incidents";
import { LimitForm } from "./Forms";

export default async function Incidents() {
  const { supabase, access } = await requireAccess();
  const { data, error } = await supabase.rpc("incident_list");
  const owner = can(access, ["OWNER"], null);
  if (error) {
    return (<><TopBar access={access} /><main><h1>Incident reports</h1>
      <div className="notice info">{error.code === "PGRST202" ? "The owner needs to run update-0023 in Supabase first." : "Could not load. Try again."}</div></main></>);
  }
  const { limit, reports } = data as { limit: number; reports: Ir[] };
  const manager = reports.some((r) => r.can_manage) || access.grants.some((g) => g.role === "OWNER" || g.role === "MANAGER");
  const open = reports.filter((r) => ["DRAFT", "ISSUED", "EXPLAINED"].includes(r.state));
  const done = reports.filter((r) => !open.includes(r));
  const Row = ({ r }: { r: Ir }) => (
    <li>
      <span><strong>IR no. {r.ir_no} · {r.name}</strong><br />
        <span className="small muted">Tardiness · {dayLabel(r.period_start)} to {dayLabel(r.period_end)} · {minutesText(r.late_minutes)} late over {r.late_days} day{r.late_days === 1 ? "" : "s"}</span></span>
      <span className={`pill ${IR_STATE[r.state].cls}`}>{IR_STATE[r.state].label}</span>
      <Link className="button secondary small" href={`/incidents/${r.id}`}>Open</Link>
    </li>
  );
  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Incident reports</h1>
        <p className="muted small">{manager
          ? "Tardiness IRs are drafted automatically from the time clock when someone's late minutes in a payroll cutoff reach the limit. Review, issue, then close with the action taken."
          : "Incident reports issued to you. Open one to read it and write your explanation."}</p>
        {owner && <div className="card"><LimitForm minutes={limit} /></div>}
        <div className="card">
          <h2>Open</h2>
          {open.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing open.</p> : <ul className="plain-list">{open.map((r) => <Row key={r.id} r={r} />)}</ul>}
        </div>
        {done.length > 0 && (
          <div className="card">
            <h2>Closed</h2>
            <ul className="plain-list">{done.map((r) => <Row key={r.id} r={r} />)}</ul>
          </div>
        )}
      </main>
    </>
  );
}
