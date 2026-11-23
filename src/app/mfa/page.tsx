import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { MfaForm } from "./MfaForm";

export default async function MfaPage() {
  const { access } = await requireAccess({ allowWithoutMfa: true });
  if (access.mfa) redirect("/");
  return (
    <div className="center">
      <div className="card auth-card">
        <img src="/hermosa-logo.png" alt="Hermosa Aesthetics" />
        <h1>Verify it's you</h1>
        <p className="muted small">Owner, finance and HR accounts need a second step to protect payroll, approvals and company totals.</p>
        <MfaForm />
      </div>
    </div>
  );
}
