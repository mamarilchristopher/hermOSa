import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, can, canApprove } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Uid } from "@/components/Uid";

/** Owner or GM: employee details waiting for approval. */
export default async function DetailsQueue({ searchParams }: { searchParams: Promise<{ done?: string; returned?: string }> }) {
  const { supabase, access } = await requireAccess();
  if (!canApprove(access, null)) redirect("/");
  const owner = can(access, ["OWNER"], null);
  const sp = await searchParams;
  const [{ data: subs }, { data: users }, { data: emps }] = await Promise.all([
    supabase.from("employee_detail_submissions").select("id, user_id, state, submitted_at, decided_at").neq("state", "SUPERSEDED")
      .order("submitted_at", { ascending: false }).limit(200),
    supabase.from("app_users").select("id, uid, display_name, email, join_status, active"),
    supabase.from("employees").select("id, app_user_id, active, employee_details(approved_at)"),
  ]);
  const name = Object.fromEntries((users ?? []).map((u) => [u.id, u]));
  const waiting = (subs ?? []).filter((s) => s.state === "PENDING").reverse();
  const latestDone = new Map<string, { state: string; decided_at: string | null }>();
  for (const s of subs ?? []) if (s.state !== "PENDING" && !latestDone.has(s.user_id)) latestDone.set(s.user_id, s);
  const empList = (emps ?? []) as unknown as { id: string; app_user_id: string | null; active: boolean; employee_details: { approved_at: string } | null }[];
  // Only active, approved accounts with an active employee record, once per account.
  const seen = new Set<string>();
  const missing = empList.filter((e) => {
    const u = e.app_user_id ? name[e.app_user_id] : undefined;
    if (!u || !e.active || !u.active || u.join_status !== "APPROVED" || e.employee_details) return false;
    if (seen.has(u.id) || waiting.some((w) => w.user_id === u.id)) return false;
    seen.add(u.id);
    return true;
  });
  // Two accounts with the same name: show the sign-in email so you can tell them apart.
  const shown = [...waiting.map((w) => w.user_id), ...missing.map((e) => e.app_user_id!)];
  const nameCount = new Map<string, number>();
  for (const id of shown) { const n = name[id]?.display_name?.toLowerCase(); if (n) nameCount.set(n, (nameCount.get(n) ?? 0) + 1); }
  const dupe = (id: string) => (nameCount.get(name[id]?.display_name?.toLowerCase() ?? "") ?? 0) > 1;
  const dupes = new Set(shown.filter(dupe).map((id) => name[id]?.display_name)).size;
  const day = (t: string) => new Date(t).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Staff details</h1>
        <p className="muted small">Staff fill in their details from their Home page. Nothing reaches the employee record until you approve it. You can correct anything before approving.</p>
        {sp.done && <div className="notice ok">Approved and saved to the employee record.</div>}
        {sp.returned && <div className="notice ok">Sent back. They'll see your note on their details page.</div>}
        {dupes > 0 && (
          <div className="notice error">
            {dupes === 1 ? "One name appears" : `${dupes} names appear`} more than once below. That usually means the person registered twice with different emails.
            Check the emails and UIDs, then turn off the extra account on {owner ? <Link href="/admin/users">Users and roles</Link> : "Users and roles (ask an owner)"}.
          </div>
        )}
        <div className="card">
          <h2>Waiting for you ({waiting.length})</h2>
          {waiting.length === 0 && <p className="muted small">Nothing to review.</p>}
          <ul className="plain-list">
            {waiting.map((s) => (
              <li key={s.id}>
                <span><strong>{name[s.user_id]?.display_name ?? "Someone"}</strong><Uid v={name[s.user_id]?.uid} /> <span className="small muted">sent {day(s.submitted_at)}{dupe(s.user_id) && ` · ${name[s.user_id]?.email}`}{name[s.user_id]?.join_status === "PENDING" && " · join request not approved yet"}</span></span>
                {s.user_id === access.user_id && !owner
                  ? <span className="small muted">Yours: an owner approves it</span>
                  : <Link className="button small" href={`/admin/details/${s.id}`}>Review</Link>}
              </li>
            ))}
          </ul>
        </div>
        {missing.length > 0 && (
          <div className="card">
            <h2>Haven't sent details yet ({missing.length})</h2>
            <p className="small muted">Remind them to open Home, then "My employee details".</p>
            <ul className="plain-list">{missing.map((e) => <li key={e.id}><span>{name[e.app_user_id!]?.display_name ?? "Staff"}<Uid v={name[e.app_user_id!]?.uid} />{dupe(e.app_user_id!) && <span className="small muted"> · {name[e.app_user_id!]?.email}</span>}</span></li>)}</ul>
          </div>
        )}
        {latestDone.size > 0 && (
          <div className="card">
            <h2>Recently decided</h2>
            <ul className="plain-list">
              {[...latestDone.entries()].slice(0, 20).map(([u, s]) => (
                <li key={u}><span>{name[u]?.display_name ?? "Staff"}<Uid v={name[u]?.uid} /></span>
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
