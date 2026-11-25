import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireAccess, can, canApprove } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { DetailsForm } from "@/components/DetailsForm";
import { legalName, type Details } from "@/lib/employeeDetails";
import { approveDetails } from "../actions";
import { ReturnForm } from "./ReturnForm";

/** Owner or GM reviews one submission: correct anything, then approve (applies it) or send back with a note. */
export default async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, access } = await requireAccess();
  if (!canApprove(access, null)) redirect("/");
  const { data: s } = await supabase.from("employee_detail_submissions").select("id, user_id, data, state, submitted_at").eq("id", id).maybeSingle();
  if (!s) notFound();
  const [{ data: u }, { data: emp }] = await Promise.all([
    supabase.from("app_users").select("display_name, email, join_status").eq("id", s.user_id).maybeSingle(),
    supabase.from("employees").select("id, full_name, position").eq("app_user_id", s.user_id).maybeSingle(),
  ]);
  const data = s.data as Details;

  return (
    <>
      <TopBar access={access} />
      <main className="narrow">
        <nav className="crumbs"><Link className="back" href="/admin/details">← Staff details</Link></nav>
        <h1>Review: {u?.display_name}</h1>
        <p className="muted small">{u?.email} · {emp ? `${emp.position ?? "No position yet"}` : "No employee record yet"}</p>
        {s.state !== "PENDING" ? (
          <div className="notice info">This one was already decided, or they sent a newer copy.</div>
        ) : s.user_id === access.user_id && !can(access, ["OWNER"], null) ? (
          <div className="notice info">These are your own details, so an owner approves them.</div>
        ) : (
          <>
            {u?.join_status === "PENDING" && <div className="notice error">Approve their join request on Users and roles first. These details can only be applied once they're on staff.</div>}
            <DetailsForm action={approveDetails} initial={data} submitLabel="Approve and save to employee record"
              extra={
                <fieldset className="card">
                  <legend>Employee record</legend>
                  <div className="field-grid">
                    <label className="field half"><span>Name on the record *</span><input name="full_name" defaultValue={legalName(data)} maxLength={120} required /></label>
                  </div>
                  <p className="small muted">Edit any answer above to correct it. Your corrections are what get saved.</p>
                </fieldset>
              }>
              <input type="hidden" name="submission" value={s.id} />
            </DetailsForm>
            <div className="card">
              <h2>Or send it back</h2>
              <ReturnForm submission={s.id} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
