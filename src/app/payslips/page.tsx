import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { loadMyPayslips } from "./load";
import { peso, periodLabel } from "@/lib/payroll";

/** Staff: their own payslips once payroll is final (update-0046). */
export default async function PayslipsPage() {
  const { supabase, access } = await requireAccess();
  const payroll = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const { data: me } = await supabase.from("employees").select("id").eq("app_user_id", access.user_id).eq("active", true).order("created_at").limit(1).maybeSingle();
  const list = me ? await loadMyPayslips(supabase, me.id) : [];
  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>My payslips</h1>
        <p className="muted small">Your payslip shows here once payroll for the cutoff is final. Tap one to see the details, your commissions, or to save it as a photo or PDF.</p>
        {payroll && <p className="small"><Link href="/payroll">Go to Payroll ›</Link></p>}
        <div className="card">
          {!me && <p className="muted small">Your login isn&apos;t linked to a staff record yet. Ask the GM.</p>}
          {me && list.length === 0 && <p className="muted small">No payslips yet.</p>}
          {list.length > 0 && (
            <ul className="plain-list">
              {list.map((p) => (
                <li key={p.id}>
                  <span><Link href={`/payslips/${p.id}`}><strong>{periodLabel(p.period_start)}</strong></Link> <span className="small muted">{p.slip_no}</span></span>
                  <strong>{peso(p.net_cents)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
