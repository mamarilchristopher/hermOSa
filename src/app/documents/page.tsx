import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { dateLabel, groupDocs, type DocVersion } from "@/lib/documents";
import { AddVersionForm, RemoveVersion } from "./Forms";

/** Documents (update-0082, CHRIS Nov 26): every approved form, its current version and all old versions. */
export default async function DocumentsPage() {
  const { supabase, access } = await requireAccess();
  const management = access.grants.some((g) => (g.role === "OWNER" || g.role === "MANAGER") && g.branch_id === null);
  const { data, error } = await supabase.from("documents")
    .select("id, doc_key, title, category, version, note, file_path, file_name, approved_on, created_at").limit(1000);
  const groups = groupDocs((data ?? []) as DocVersion[]);
  const categories = [...new Set(groups.map((g) => g.category))];

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Documents</h1>
        <p className="muted small">The clinic&apos;s approved forms. Open one to view it, download it as a PDF or share it. Older versions stay listed under each form.</p>
        {error && <div className="notice info">{error.code === "42P01" ? "The owner needs to run update-0082 in Supabase first." : "Could not load. Try again."}</div>}

        {categories.map((cat) => (
          <section key={cat}>
            <h2 className="doc-cat">{cat}</h2>
            <div className="doc-grid">
              {groups.filter((g) => g.category === cat).map((g) => (
                <div className="card doc-card" key={g.key}>
                  <Link href={`/documents/${g.current.id}`} className="doc-open">
                    <span className="doc-icon" aria-hidden>PDF</span>
                    <span className="doc-main">
                      <strong>{g.title}</strong>
                      <span className="small"><span className="pill PUBLISHED">Current</span> {g.current.version} · approved {dateLabel(g.current.approved_on)}</span>
                      {g.current.note && <span className="small muted">{g.current.note}</span>}
                    </span>
                  </Link>
                  {management && <RemoveVersion id={g.current.id} label={`${g.title}, ${g.current.version}`} />}
                  {g.old.length > 0 && (
                    <details className="doc-old">
                      <summary className="small">Old versions ({g.old.length})</summary>
                      <ul className="plain-list">
                        {g.old.map((o) => (
                          <li key={o.id}>
                            <Link href={`/documents/${o.id}`}><strong>{o.version}</strong> · {o.approved_on ? `approved ${dateLabel(o.approved_on)}` : dateLabel(null)}</Link>
                            {o.note && <span className="small muted"> · {o.note}</span>}
                            {management && <RemoveVersion id={o.id} label={`${g.title}, ${o.version}`} />}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
        {!error && groups.length === 0 && <p className="muted">No documents yet.</p>}

        {management && (
          <details className="card add-doc">
            <summary><strong>+ Upload a new version</strong> <span className="small muted">owners and the GM · PDF</span></summary>
            <AddVersionForm docs={groups.map((g) => ({ key: g.key, title: g.title, category: g.category, next: `Version ${g.old.length + 2}` }))} />
          </details>
        )}
      </main>
    </>
  );
}
