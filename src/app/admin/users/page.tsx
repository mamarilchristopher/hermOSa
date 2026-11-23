import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { GrantForm } from "./GrantForm";
import { revokeRole, setActive } from "./actions";

export default async function UsersPage() {
  const { supabase, access, branches } = await requireAccess();
  if (!can(access, ["OWNER"], null)) redirect("/");
  const [{ data: users }, { data: grants }] = await Promise.all([
    supabase.from("app_users").select("id, display_name, email, active").order("display_name"),
    supabase.from("role_grants").select("id, user_id, role_code, branch_id").is("revoked_at", null),
  ]);
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const others = (users ?? []).filter((u) => u.id !== access.user_id && u.active);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Users and roles</h1>
        <p className="muted small">
          To add someone: in Supabase go to Authentication, Users, Invite user. They appear here with no access until you give them a role.
          Owner, Finance and HR roles must use an authenticator app.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th></th></tr></thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id}>
                  <td>{u.display_name}{!u.active && <span className="pill REVERSED" style={{ marginLeft: 6 }}>Inactive</span>}</td>
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
            <h2 style={{ marginTop: 0 }}>Give someone a role</h2>
            <GrantForm users={others} branches={branches.filter((b) => b.kind === "CLINIC")} />
          </div>
        )}
      </main>
    </>
  );
}
