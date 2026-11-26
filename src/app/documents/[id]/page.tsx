import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { dateLabel, groupDocs, staticUrl, type DocVersion } from "@/lib/documents";
import { PdfViewer } from "../PdfViewer";

/** One document version, shown as a PDF inside the app with Download and Share (CHRIS Nov 26, update-0082). */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, access } = await requireAccess();
  const cols = "id, doc_key, title, category, version, note, file_path, file_name, approved_on, created_at";
  const { data: doc } = await supabase.from("documents").select(cols).eq("id", id).maybeSingle();
  if (!doc) notFound();
  const d = doc as DocVersion;
  const { data: all } = await supabase.from("documents").select(cols).eq("doc_key", d.doc_key);
  const g = groupDocs((all ?? []) as DocVersion[])[0];
  const versions = g ? [g.current, ...g.old] : [d];
  const isCurrent = g?.current.id === d.id;
  let url = staticUrl(d.file_path);
  if (!url) {
    const { data: s } = await supabase.storage.from("documents").createSignedUrl(d.file_path, 3600);
    url = s?.signedUrl ?? null;
  }

  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="small"><Link href="/documents">← Documents</Link></p>
        <h1 className="doc-title">{d.title}</h1>
        <p className="muted small" style={{ marginTop: 0 }}>
          {isCurrent ? <span className="pill PUBLISHED">Current</span> : <span className="pill REVERSED">Old version</span>} {d.version} · {d.approved_on ? `approved ${dateLabel(d.approved_on)}` : dateLabel(null)}
          {d.note && <> · {d.note}</>}
        </p>
        {!isCurrent && g && <p className="notice warn small">This is an old version. <Link href={`/documents/${g.current.id}`}>Open the current one ({g.current.version})</Link></p>}
        {url ? <PdfViewer url={url} fileName={d.file_name} title={`${d.title} (${d.version})`} sharePath={`/documents/${d.id}`} />
          : <div className="notice error">Could not open this file. Try again.</div>}
        {versions.length > 1 && (
          <div className="card">
            <h2>All versions</h2>
            <ul className="plain-list">
              {versions.map((v) => (
                <li key={v.id}>
                  {v.id === d.id ? <strong>{v.version} (open)</strong> : <Link href={`/documents/${v.id}`}>{v.version}</Link>}
                  <span className="small muted"> · {v.approved_on ? `approved ${dateLabel(v.approved_on)}` : dateLabel(null)}{v.id === g?.current.id ? " · current" : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
