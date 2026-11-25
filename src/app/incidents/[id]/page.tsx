import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { IR_STATE, type Ir } from "@/lib/incidents";
import { IssueForm } from "../Forms";
import { IrTools } from "../IrTools";
import { IrDocument } from "../IrDocument";

export default async function IncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ issued?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
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
          <IrTools r={r} />
        </div>
        {sp.issued && <div className="notice ok no-print">IR issued. {r.name.split(" ")[0]} now has an urgent notice to acknowledge it and respond. A PDF copy is being saved in Hermosa OS.</div>}

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
