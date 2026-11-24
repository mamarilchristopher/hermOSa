import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { IR_STATE, type Ir } from "@/lib/incidents";
import { IssueForm, PrintButton } from "../Forms";
import { IrDocument } from "../IrDocument";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, access } = await requireAccess();
  const { data } = await supabase.rpc("incident_list");
  const r = ((data as { reports: Ir[] } | null)?.reports ?? []).find((x) => x.id === id);
  if (!r) notFound();
  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="no-print"><Link href="/incidents" className="small">← Incident reports</Link></p>
        <div className="row-buttons no-print" style={{ justifyContent: "space-between" }}>
          <span className={`pill ${IR_STATE[r.state].cls}`}>{IR_STATE[r.state].label}</span>
          {r.state !== "DRAFT" && <PrintButton />}
        </div>

        <IrDocument r={r} />

        {r.state === "DRAFT" && r.can_manage && (
          <div className="card no-print">
            <h2>Review</h2>
            <p className="small muted">The employee can&apos;t see this IR until you issue it. While it&apos;s a draft, it keeps updating if they are late again this cutoff.</p>
            <IssueForm id={r.id} />
          </div>
        )}
      </main>
    </>
  );
}
