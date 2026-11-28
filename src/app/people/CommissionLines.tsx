// A person's commission lines for the month (People › person). update-0105 (CHRIS Nov 28): on phones the Commission
// column was off the right edge, so "paid ₱0.00" (what the client paid) read like a ₱0 commission. Phones now show the
// commission right under the service, and "client paid" says whose money it is.
import { centsToPhp } from "@/lib/csv";
import { ROLE_TEXT } from "@/lib/commission";

export type Line = { id: string; role: string; amount_cents: number; service_logs: { id: string; service_date: string; state: string; photos_due?: boolean; amount_paid_cents: number; branch_id: string; services: { name: string } | null } };

function status(l: Line) {
  const s = l.service_logs.state;
  if (s === "REJECTED") return { cls: "REVERSED", text: "Rejected" };
  if (l.service_logs.photos_due) return { cls: "STAGED", text: "Photos missing" };
  return s === "APPROVED" ? { cls: "PUBLISHED", text: "Approved" } : { cls: "STAGED", text: "Waiting" };
}

export function CommissionLines({ lines, branchName, empty }: { lines: Line[]; branchName: Record<string, string>; empty: string }) {
  return (
    <div className="table-wrap">
      <table className="commission-lines">
        <thead><tr><th>Date</th><th>Service</th><th className="num cl-wide">Commission</th><th className="cl-wide">Type</th><th>Status</th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const st = status(l);
            return (
              <tr key={l.id} className={l.service_logs.state === "REJECTED" ? "rejected" : undefined}>
                <td className="cl-date">{l.service_logs.service_date}</td>
                <td>
                  {l.service_logs.services?.name}
                  <div className="cl-phone"><strong>{centsToPhp(l.amount_cents)}</strong> <span className="small">commission ({ROLE_TEXT[l.role]})</span></div>
                  <div className="small muted">{branchName[l.service_logs.branch_id]} · client paid {centsToPhp(l.service_logs.amount_paid_cents)}</div>
                </td>
                <td className="num cl-wide"><strong>{centsToPhp(l.amount_cents)}</strong></td>
                <td className="cl-wide"><span className={`tag ${l.role}`}>{ROLE_TEXT[l.role]}</span></td>
                <td><span className={`pill ${st.cls}`}>{st.text}</span></td>
              </tr>
            );
          })}
          {lines.length === 0 && <tr><td colSpan={5} className="muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
