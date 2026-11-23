import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { DetailsForm } from "@/components/DetailsForm";
import type { Details } from "@/lib/employeeDetails";
import { submitDetails } from "./actions";

/** Staff fill in their own employee details. New joiners can do this while they wait for approval. */
export default async function MyDetails() {
  const { supabase, access } = await requireAccess({ allowPending: true });
  const pendingJoin = access.join_status === "PENDING";
  const [{ data: subs }, { data: emp }] = await Promise.all([
    supabase.from("employee_detail_submissions").select("id, data, state, note, submitted_at, decided_at")
      .eq("user_id", access.user_id).neq("state", "SUPERSEDED").order("submitted_at", { ascending: false }).limit(1),
    supabase.from("employees").select("id, employee_details(data, approved_at)").eq("app_user_id", access.user_id).maybeSingle(),
  ]);
  const last = subs?.[0];
  const approved = (emp as unknown as { employee_details: { data: Details; approved_at: string } | null } | null)?.employee_details ?? null;
  const [first, ...rest] = access.display_name.split(/\s+/);
  const initial: Details = (last?.data as Details) ?? approved?.data ?? { first_name: first ?? "", last_name: rest.join(" "), nationality: "Filipino" };
  const day = (t: string) => new Date(t).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });

  const body = (
    <main className="narrow">
      {pendingJoin && <nav className="crumbs"><Link className="back" href="/pending">← Back</Link></nav>}
      <h1>My employee details</h1>
      <p className="muted small">For your employee record, payroll and government reports. Fields with * are required. The owner assigns your position.</p>
      {last?.state === "PENDING" && <div className="notice info">Sent {day(last.submitted_at)}. Waiting for the owner to check and approve. You can still change something and send again.</div>}
      {last?.state === "RETURNED" && <div className="notice error"><strong>The owner sent this back:</strong> {last.note} Please fix it and send again.</div>}
      {last?.state === "APPROVED" && <div className="notice ok">Approved {day(last.decided_at!)}. To change something, edit below and send again.</div>}
      <DetailsForm action={submitDetails} initial={initial} submitLabel="Send to the owner for approval" />
    </main>
  );
  return pendingJoin ? body : (<><TopBar access={access} />{body}</>);
}
