import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAccess, errorText } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { cutoffEnd, dayLabel } from "@/lib/homeGlance";
import { TodoCard, type Todo } from "../ManagerHome";

type ViewAs = {
  ok: boolean; error?: string; name: string; email: string; joined_at: string | null;
  employee: { id: string; position: string | null; branch_id: string; commission_eligible: boolean } | null;
  roles: { role: string; branch_id: string | null }[];
  details_state: string | null;
  sent_back: { count: number; latest: string | null };
  unsigned: { count: number; oldest: string | null; cents: number };
  month_approved_cents: number; logged_today: number; last_seen: string | null;
};
const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Front desk", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};
const LOGGERS = ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"];

/** Owners and the general manager: a read-only look at someone's Home and pending work. */
export default async function ViewAsPage({ searchParams }: { searchParams: Promise<{ u?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.some((g) => (g.role === "OWNER" || g.role === "MANAGER") && g.branch_id === null)) redirect("/me");
  const id = z.uuid().safeParse((await searchParams).u);
  if (!id.success) redirect("/me");
  const { data } = await supabase.rpc("view_as", { p_user: id.data });
  const v = (data ?? { ok: false, error: "UNKNOWN" }) as ViewAs;
  const today = manilaToday();
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  if (!v.ok) {
    return (<><TopBar access={access} /><main><Link href="/me">← Back to my Home</Link><div className="notice error">{v.error === "UNKNOWN" ? "View as isn't set up yet. The owner needs to run update-0021 in Supabase." : errorText(v.error)}</div></main></>);
  }
  const first = v.name.trim().split(/\s+/)[0];
  const todos: Todo[] = [];
  if (v.details_state === "RETURNED") todos.push({ text: "Employee details were sent back to fix", href: "/admin/details", urgent: true });
  else if (v.details_state !== "APPROVED" && v.details_state !== "PENDING") todos.push({ text: "Employee details not filled in yet", href: "/admin/details", urgent: true });
  else if (v.details_state === "PENDING") todos.push({ text: "Employee details sent, waiting for the owner to review", href: "/admin/details" });
  if (v.sent_back.count) todos.push({ text: `${v.sent_back.count} service log ${v.sent_back.count === 1 ? "entry was" : "entries were"} sent back in the last 30 days`, href: `/services?date=${v.sent_back.latest}`, urgent: true });
  if (v.unsigned.count) todos.push({ text: `${v.unsigned.count} commission ${v.unsigned.count === 1 ? "entry" : "entries"} not signed yet (oldest ${dayLabel(v.unsigned.oldest!)}, ${centsToPhp(v.unsigned.cents)}). Not paid in this cutoff (closes ${dayLabel(cutoffEnd(today))}) unless signed`, href: `/services?date=${v.unsigned.oldest}`, urgent: true });
  if (v.roles.some((r) => LOGGERS.includes(r.role)) && !v.logged_today) todos.push({ text: "Nothing logged today yet", href: "/services" });
  const scope = v.roles.map((r) => `${ROLE_LABEL[r.role] ?? r.role}, ${r.branch_id ? branchName[r.branch_id] ?? "branch" : "all branches"}`);
  const seen = v.last_seen ? new Date(v.last_seen).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  return (
    <>
      <TopBar access={access} />
      <main>
        <div className="notice info view-as-bar">
          <span>Viewing <strong>{first}&apos;s</strong> Home. Read only: nothing can be changed here.</span>
          <Link className="button secondary small" href="/me">Back to my Home</Link>
        </div>
        <h1>Hi, {first}</h1>
        <p className="muted small">{v.employee?.position ?? "Staff"}{v.employee && ` · ${branchName[v.employee.branch_id] ?? ""}`} · {dayLabel(today)}{seen && ` · last in the app ${seen}`}</p>
        <TodoCard todos={todos} />
        {v.employee?.commission_eligible && (
          <div className="grid">
            <div className="card stat"><div className="label">Approved commission this month</div><div className="value">{centsToPhp(v.month_approved_cents)}</div></div>
            <div className="card stat"><div className="label">Waiting sign-off</div><div className="value">{centsToPhp(v.unsigned.cents)}</div>
              {v.employee && <div className="note"><Link href={`/people/${v.employee.id}`}>See every commission line →</Link></div>}</div>
          </div>
        )}
        <div className="card">
          <h2>Details</h2>
          <dl className="kv" style={{ borderTop: 0, paddingTop: 0 }}>
            <dt>Name</dt><dd>{v.name}</dd>
            <dt>Position</dt><dd>{v.employee?.position ?? "Not set yet"}</dd>
            <dt>Home branch</dt><dd>{v.employee ? branchName[v.employee.branch_id] : "Not set yet"}</dd>
            <dt>Commission</dt><dd>{v.employee ? (v.employee.commission_eligible ? "Yes, 5% of amount paid" : "No") : "Not set yet"}</dd>
            <dt>App access</dt><dd>{scope.join("; ") || "None yet"}</dd>
            {v.joined_at && <><dt>Joined the app</dt><dd>{v.joined_at.slice(0, 10)}</dd></>}
          </dl>
        </div>
      </main>
    </>
  );
}
