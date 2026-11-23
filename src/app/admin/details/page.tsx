import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";

/** Owner: employee details waiting for approval. */
export default async function DetailsQueue({ searchParams }: { searchParams: Promise<{ done?: string; returned?: string }> }) {
  const { supabase, access } = await requireAccess();
  if (!can(access, ["OWNER"], null)) redirect("/");
  const sp = await searchParams;
  const [{ data: subs }, { data: users }, { data: emps }] = await Promise.all([
    supabase.from("employee_detail_submissions").select("id, user_id, state, submitted_at, decided_at").neq("state", "SUPERSEDED")
      .order("submitted_at", { ascending: false }).limit(200),
    supabase.from("app_users").select("id, display_name, join_status"),
    supabase.from("employees").select("id, app_user_id, employee_details(approved_at)"),
  ]);
  const name = Object.fromEntries((users ?? []).map((u) => [u.id, u]));
  const waiting = (subs ?? []).filter((s) => s.state === "PENDING").reverse();
  const latestDone = new Map<string, { state: string; decided_at: string | null }>();
  for (const s of subs ?? []) if (s.state !== "PENDING" && !latestDone.has(s.user_id)) latestDone.set(s.user_id, s);
  const empList = (emps ?? []) as unknown as { id: string; app_user_id: string | null; employee_details: { approved_at: string } | null }[];
  const missing = empList.filter((e) => e.app_user_id && !e.employee_details && !waiting.some((w) => w.user_id === e.app_user_id));
  const day = (t: string) => new Date(t).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Staff details</h1>
        <p className="muted small">Staff fill in their details from their Home page. Nothing reaches the employee record until you approve it. You can correct anything before approving.</p>
        {sp.done && <div className="notice ok">Approved and saved to the employee record.</div>}
        {sp.returned && <div className="notice ok">Sent back. They'll see your note on their details page.</div>}
        <div className="card">
          <h2>Waiting for you ({waiting.length})</h2>
          {waiting.length === 0 && <p className="muted small">Nothing to review.</p>}
          <ul className="plain-list">
            {waiting.map((s) => (
              <li key={s.id}>
                <span><strong>{name[s.user_id]?.display_name ?? "Someone"}</strong> <span className="small muted">sent {day(s.submitted_at)}{name[s.user_id]?.join_status === "PENDING" && " · join request not approved yet"}</span></span>
                <Link className="button small" href={`/admin/details/${s.id}`}>Review</Link>
              </li>
            ))}
          </ul>
        </div>
        {missing.length > 0 && (
          <div className="card">
            <h2>Haven't sent details yet ({missing.length})</h2>
            <p className="small muted">Remind them to open Home, then "My employee details".</p>
            <ul className="plain-list">{missing.map((e) => <li key={e.id}><span>{name[e.app_user_id!]?.display_name ?? "Staff"}</span></li>)}</ul>
          </div>
        )}
        {latestDone.size > 0 && (
          <div className="card">
            <h2>Recently decided</h2>
            <ul className="plain-list">
              {[...latestDone.entries()].slice(0, 20).map(([u, s]) => (
                <li key={u}><span>{name[u]?.display_name ?? "Staff"}</span>
                  <span className={`pill ${s.state === "APPROVED" ? "PUBLISHED" : "REVERSED"}`}>{s.state === "APPROVED" ? "Approved" : "Sent back"}</span>
                  {s.decided_at && <span className="small muted">{day(s.decided_at)}</span>}</li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
