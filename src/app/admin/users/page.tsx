import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { GrantForm } from "./GrantForm";
import { rejectJoin, revokeInvite, revokeRole, setActive } from "./actions";
import { ApproveForm, CopyLink, NewInviteForm } from "./JoinForms";
import Link from "next/link";
import { byRankThenName, staffRank } from "@/lib/staffOrder";
import { PositionCell } from "../../people/PositionCell";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const sortByName = (await searchParams).sort === "name";
  const { supabase, access, branches } = await requireAccess();
  if (!can(access, ["OWNER"], null)) redirect("/");
  const [{ data: all }, { data: grants }, { data: invites }, { data: emps }] = await Promise.all([
    supabase.from("app_users").select("id, display_name, email, active, join_status, requested_branch_id, joined_at").order("display_name"),
    supabase.from("role_grants").select("id, user_id, role_code, branch_id").is("revoked_at", null),
    supabase.from("staff_invites").select("id, code, expires_at, use_count").is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }),
    supabase.from("employees").select("id, app_user_id, position"),
  ]);
  const positionOf = new Map((emps ?? []).map((e) => [e.app_user_id, e.position as string | null]));
  const employeeOf = new Map((emps ?? []).map((e) => [e.app_user_id, e.id as string]));
  const grantsOf = (id: string) => (grants ?? []).filter((g) => g.user_id === id);
  const listed = (all ?? []).filter((u) => u.join_status !== "PENDING" && u.join_status !== "REJECTED");
  const users = sortByName ? listed : byRankThenName(listed, (u) => staffRank(grantsOf(u.id), positionOf.get(u.id)) + (u.active ? 0 : 10), (u) => u.display_name);
  const waiting = (all ?? []).filter((u) => u.join_status === "PENDING").sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  const clinics = branches.filter((b) => b.kind === "CLINIC").map((b) => ({ id: b.id, name: b.name }));
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const others = (users ?? []).filter((u) => u.id !== access.user_id && u.active);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Users and roles</h1>
        <p className="muted small">
          New staff join with the invite link below. They get no access until you approve them and set their staff level.
          Owner, Finance and HR roles must use an authenticator app.
        </p>

        <section className="card">
          <h2>Join requests{waiting.length > 0 && <span className="nav-badge inline">{waiting.length}</span>}</h2>
          {waiting.length === 0 && <p className="muted small">Nobody is waiting.</p>}
          {waiting.map((u) => (
            <div key={u.id} className="join-request">
              <div className="join-who">
                <strong>{u.display_name}</strong>
                <span className="small muted">{u.email} · registered {new Date(u.joined_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}
                  {u.requested_branch_id && ` · says ${branchName[u.requested_branch_id] ?? "a branch"}`}</span>
              </div>
              <ApproveForm user={u.id} branchId={u.requested_branch_id} branches={clinics} />
              <form action={rejectJoin}>
                <input type="hidden" name="user" value={u.id} />
                <button type="submit" className="secondary small">Reject</button>
              </form>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Invite link</h2>
          <p className="muted small">Send this to the staff group chat. Anyone with the link can register, but nobody gets in until you approve them. Turn a link off when you're done.</p>
          {(invites ?? []).map((i) => (
            <div key={i.id} className="invite-row">
              <CopyLink url={`${origin}/join/${i.code}`} />
              <span className="small muted">Works until {new Date(i.expires_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })} · used {i.use_count}×</span>
              <form action={revokeInvite}>
                <input type="hidden" name="invite" value={i.id} />
                <button type="submit" className="secondary small">Turn off</button>
              </form>
            </div>
          ))}
          <NewInviteForm />
        </section>

        <div className="list-head">
          <h2>Staff</h2>
          <div className="segmented" aria-label="Sort">
            <Link href="/admin/users" className={sortByName ? "" : "on"}>By role</Link>
            <Link href="/admin/users?sort=name" className={sortByName ? "on" : ""}>By name</Link>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Position</th><th>Email</th><th>Roles</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.display_name}{!u.active && <span className="pill REVERSED" style={{ marginLeft: 6 }}>Inactive</span>}</td>
                  <td>{employeeOf.get(u.id) ? <PositionCell employeeId={employeeOf.get(u.id)!} position={positionOf.get(u.id) ?? null} /> : <span className="muted small">No employee record</span>}</td>
                  <td className="small">{u.email}</td>
                  <td>
                    {(grants ?? []).filter((g) => g.user_id === u.id).map((g) => (
                      <form key={g.id} action={revokeRole} style={{ display: "flex", gap: 8, alignItems: "center", margin: "2px 0" }}>
                        <input type="hidden" name="grant" value={g.id} />
                        <span>{g.role_code} · {g.branch_id ? branchName[g.branch_id] : "All branches"}</span>
                        {u.id !== access.user_id && <button className="secondary small" type="submit">Remove</button>}
                      </form>
                    ))}
                  </td>
                  <td>
                    {u.id !== access.user_id && (
                      <form action={setActive}>
                        <input type="hidden" name="user" value={u.id} />
                        <input type="hidden" name="name" value={u.display_name} />
                        <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                        <button className="secondary" type="submit">{u.active ? "Deactivate" : "Reactivate"}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {others.length > 0 && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Give someone an extra role</h2>
            <GrantForm users={others} branches={branches.filter((b) => b.kind === "CLINIC")} />
          </div>
        )}
      </main>
    </>
  );
}
