import { sortServices } from "@/lib/serviceOrder";
import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { AddServiceForm, ServiceRow } from "./Forms";

type Svc = { id: string; name: string; price_cents: number | null; commission_cents: number | null; active: boolean; is_addon?: boolean; is_meds?: boolean };

/** Price list and commission per service (update-0042). Owners and the GM edit; managers can look. */
export default async function PricesPage() {
  const { supabase, access } = await requireAccess();
  const edit = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const look = edit || access.grants.some((g) => ["MANAGER", "FINANCE", "AUDITOR"].includes(g.role));
  const { data, error } = look ? await supabase.from("services").select("*").order("name") /* "*": is_addon exists only after update-0080 */ : { data: [], error: null };
  const list = sortServices((data ?? []) as Svc[]);
  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="small"><Link href="/services">‹ Service log</Link></p>
        <h1>Price list and commissions</h1>
        <p className="muted small">The price fills in on the service log and on bookings. A set commission is paid as is (lead 60%, assist 40%); without one it&apos;s 5% of the amount paid. Add-ons (like L-Carnitine with a drip) can be added to any service on the log and pay 5% of what was paid for them.</p>
        {!look && <div className="notice info">Only owners and managers can see the price list.</div>}
        {error && <div className="notice info">{error.code === "42703" ? "The owner needs to run update-0042 in Supabase first." : "Could not load. Try again."}</div>}
        {edit && (
          <div className="card">
            <h2>Add a service</h2>
            <AddServiceForm />
          </div>
        )}
        {look && (
          <div className="card">
            <h2>Services ({list.filter((s) => s.active).length})</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Service</th><th className="num">Price</th><th className="num">Commission</th><th className="num">Lead / assist</th><th></th></tr></thead>
                <tbody>{list.map((s) => <ServiceRow key={s.id} s={s} edit={edit} />)}</tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
