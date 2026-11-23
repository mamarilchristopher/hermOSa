import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, branchesFor } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { formatManila } from "@/lib/dates";
import { UploadForm } from "./Forms";

export default async function ImportsPage() {
  const { supabase, access, branches } = await requireAccess();
  const readable = branchesFor(access, branches, ["OWNER", "FINANCE", "AUDITOR", "MANAGER"]);
  if (readable.length === 0) redirect("/");
  const stageable = branchesFor(access, branches, ["OWNER", "FINANCE", "MANAGER"]);
  const names = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  // RLS returns only batches for branches this user may see.
  const { data: batches } = await supabase
    .from("import_batches")
    .select("id, branch_id, source_filename, state, source_row_count, expected_row_count, expected_gross_cents, actual_gross_cents, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Historical sales imports</h1>
        <p className="muted small">
          Upload a branch's past sales as CSV with columns <code>source_id, posting_date, amount_php</code> (dates as YYYY-MM-DD,
          amounts without commas). Nothing counts until a second person checks it against the branch's report and signs it off.
        </p>
        {stageable.length > 0 && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Upload</h2>
            <UploadForm branches={stageable} />
            <p className="small muted">Use DEMO or sanitized files while testing. Don't upload patient names.</p>
          </div>
        )}
        <h2>Batches</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Uploaded</th><th>Branch</th><th>File</th><th>Status</th><th className="num">Rows</th><th className="num">Expected total</th></tr>
            </thead>
            <tbody>
              {(batches ?? []).map((b) => (
                <tr key={b.id}>
                  <td>{formatManila(b.created_at)}</td>
                  <td>{names[b.branch_id]}</td>
                  <td><Link href={`/imports/${b.id}`}>{b.source_filename}</Link></td>
                  <td><span className={`pill ${b.state}`}>{b.state}</span></td>
                  <td className="num">{b.source_row_count}</td>
                  <td className="num">{centsToPhp(b.expected_gross_cents)}</td>
                </tr>
              ))}
              {(batches ?? []).length === 0 && <tr><td colSpan={6} className="muted">No imports yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
