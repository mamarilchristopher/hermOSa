import { ROLE_CHOICES } from "@/lib/staffLevels";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { rejectJoin } from "../users/actions";
import { ApproveForm, GM_LEVELS } from "../users/JoinForms";
import { Uid } from "@/components/Uid";
import { sameNameAccounts } from "@/lib/nameKey";

/** Join requests for the General Manager (company-wide manager). Owners use Users and roles. */
export default async function JoinsPage() {
  const { supabase, access, branches } = await requireAccess();
  const owner = can(access, ["OWNER"], null);
  if (owner) redirect("/admin/users");
  if (!can(access, ["MANAGER"], null)) redirect("/");
  const { data } = await supabase.from("app_users").select("id, uid, display_name, email, requested_branch_id, requested_level, joined_at")
    .eq("join_status", "PENDING").order("joined_at");
  const waiting = data ?? [];
  const { data: others } = await supabase.from("app_users").select("id, uid, display_name, active, join_status");
  const clinics = branches.filter((b) => b.kind === "CLINIC" || b.kind === "WFH").map((b) => ({ id: b.id, name: b.name }));
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Join requests</h1>
        <p className="muted small">
          Staff who registered with the invite link wait here with no access. Check it's really them, pick their staff level and
          home branch, then tap Approve. Only an owner can make someone an Owner.
        </p>
        <section className="card">
          <h2>Waiting{waiting.length > 0 && <span className="nav-badge inline">{waiting.length}</span>}</h2>
          {waiting.length === 0 && <p className="muted small">Nobody is waiting.</p>}
          {waiting.map((u) => (
            <div key={u.id} className="join-request">
              <div className="join-who">
                <strong>{u.display_name}<Uid v={u.uid} /></strong>
                <span className="small muted">{u.email} · registered {new Date(u.joined_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}
                  {u.requested_branch_id && ` · says ${branchName[u.requested_branch_id] ?? "a branch"}`}{u.requested_level && ` · as ${ROLE_CHOICES.find(([k]) => k === u.requested_level)?.[1] ?? u.requested_level}`}</span>
              </div>
              {sameNameAccounts(u, others ?? []).length > 0 && (
                <p className="small join-dupe">
                  Already has an account? {sameNameAccounts(u, others ?? []).map((x) => `${x.display_name} (${x.uid}${x.active === false ? ", turned off" : ""})`).join(", ")}.
                  If it&apos;s the same person, Reject this one and have them sign in with that account instead.
                </p>
              )}
              <ApproveForm user={u.id} branchId={u.requested_branch_id} branches={clinics} levels={GM_LEVELS} asked={u.requested_level} />
              <form action={rejectJoin}>
                <input type="hidden" name="user" value={u.id} />
                <button type="submit" className="secondary small">Reject</button>
              </form>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
