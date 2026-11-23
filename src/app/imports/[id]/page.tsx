import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { formatManila } from "@/lib/dates";
import { DiscardForm, PublishForm, ReverseForm } from "../Forms";

export default async function BatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ duplicate?: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { duplicate } = await searchParams;
  const { supabase, access, branches } = await requireAccess();
  const { data: b } = await supabase.from("import_batches").select("*").eq("id", id).maybeSingle();
  if (!b) notFound(); // also what another branch's user sees
  const { data: rows } = await supabase
    .from("import_rows")
    .select("row_number, source_key, posting_date, gross_cents, validation_errors, state")
    .eq("batch_id", id)
    .order("row_number")
    .limit(2000);
  const all = rows ?? [];
  const invalid = all.filter((r) => r.state === "INVALID");
  const validCents = all.filter((r) => r.state !== "INVALID").reduce((s, r) => s + Number(r.gross_cents ?? 0), 0);
  const branch = branches.find((x) => x.id === b.branch_id);
  const isUploader = b.created_by === access.user_id;
  const canApprove = can(access, ["OWNER", "FINANCE"], b.branch_id);
  const { data: org } = await supabase.from("organizations").select("require_second_signoff").maybeSingle();
  const secondSignoff = org?.require_second_signoff !== false;
  const selfAllowed = !secondSignoff && can(access, ["OWNER"], b.branch_id);
  const countsMatch = invalid.length === 0 && all.length === b.expected_row_count && validCents === Number(b.expected_gross_cents);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>{b.source_filename}</h1>
        <p className="muted small">
          {branch?.name} · uploaded {formatManila(b.created_at)} · <span className={`pill ${b.state}`}>{b.state}</span> · SHA-256 {b.source_sha256.slice(0, 12)}…
        </p>
        {duplicate && <div className="notice info">This exact file was already uploaded for this branch, so here is the existing batch.</div>}

        <div className="grid">
          <div className="card stat"><div className="label">Branch report says</div><div className="value">{centsToPhp(b.expected_gross_cents)}</div><div className="note">{b.expected_row_count} sales</div></div>
          <div className="card stat"><div className="label">File contains (valid rows)</div><div className="value">{centsToPhp(validCents)}</div><div className="note">{all.length - invalid.length} of {all.length} rows valid</div></div>
          <div className="card stat"><div className="label">Check</div><div className="value">{countsMatch ? "Matches" : "Doesn't match"}</div><div className="note">{invalid.length} rows with errors</div></div>
        </div>

        {b.state === "STAGED" && canApprove && (!isUploader || selfAllowed) && countsMatch && (
          <div className="card"><h2 style={{ marginTop: 0 }}>Sign off</h2><PublishForm batch={b.id} /></div>
        )}
        {selfAllowed && b.state === "STAGED" && <div className="notice info">Pre-launch mode: second-person sign-off is off, so you can publish your own upload. Turn it back on before launch.</div>}
        {b.state === "STAGED" && isUploader && !selfAllowed && <div className="notice info">Someone else with Owner or Finance access has to sign this off.</div>}
        {b.state === "STAGED" && !countsMatch && <div className="notice error">This batch can't be published. Discard it below, then upload the corrected file or totals.</div>}
        {b.state === "STAGED" && can(access, ["OWNER", "FINANCE", "MANAGER"], b.branch_id) && (
          <div className="card"><h2 style={{ marginTop: 0 }}>Discard</h2><p className="small muted">Use this if the file or the expected totals were wrong. Nothing was published, and the record is kept.</p><DiscardForm batch={b.id} /></div>
        )}
        {b.state === "PUBLISHED" && canApprove && (
          <div className="card"><h2 style={{ marginTop: 0 }}>Reverse</h2><p className="small muted">Removes this batch from all totals. The rows and audit trail are kept.</p><ReverseForm batch={b.id} /></div>
        )}
        {b.state === "REVERSED" && <div className="notice info">Reversed {b.reversed_at ? formatManila(b.reversed_at) : ""}: {b.reversal_reason}</div>}

        {invalid.length > 0 && (
          <>
            <h2>Rows with errors</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th className="num">Row</th><th>Source id</th><th>Problems</th></tr></thead>
                <tbody>
                  {invalid.slice(0, 500).map((r) => (
                    <tr key={r.row_number}><td className="num">{r.row_number}</td><td>{r.source_key ?? "—"}</td><td>{(r.validation_errors as string[]).join(", ")}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}
