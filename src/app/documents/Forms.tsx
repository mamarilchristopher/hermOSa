"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { keyFor } from "@/lib/documents";
import { removeDocumentVersion } from "./actions";

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
const NEW = "__new__";
const MAX_MB = 25;

type DocOpt = { key: string; title: string; category: string; next: string };

/** Owners and the GM: upload a PDF as the new current version of a document, or start a new document. */
export function AddVersionForm({ docs }: { docs: DocOpt[] }) {
  const router = useRouter();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
  const [doc, setDoc] = useState(docs[0]?.key ?? NEW);
  const picked = docs.find((d) => d.key === doc);
  const [version, setVersion] = useState(docs[0]?.next ?? "Version 1");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Client forms");
  const [approved, setApproved] = useState(today);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});

  async function save() {
    setMsg({});
    if (!file) return setMsg({ error: "Choose the PDF file." });
    if (file.type && file.type !== "application/pdf") return setMsg({ error: "The file must be a PDF." });
    if (file.size > MAX_MB * 1024 * 1024) return setMsg({ error: `The PDF must be ${MAX_MB} MB or smaller.` });
    if (!version.trim()) return setMsg({ error: "Write the version, like Version 4." });
    if (!picked && title.trim().length < 2) return setMsg({ error: "Write the document's name." });
    const key = picked ? picked.key : keyFor(title);
    const path = `${key}/${uuid()}.pdf`;
    setBusy(true);
    const sb = createClient();
    const up = await sb.storage.from("documents").upload(path, file, { contentType: "application/pdf" });
    if (up.error) { setBusy(false); return setMsg({ error: "The PDF didn't upload. Check your connection and try again." }); }
    const { data, error } = await sb.rpc("add_document_version", {
      p_key: key, p_title: picked ? picked.title : title.trim(), p_category: picked ? picked.category : category.trim(),
      p_version: version.trim(), p_note: note.trim() || null, p_path: path, p_file_name: file.name, p_approved_on: approved || null,
    });
    setBusy(false);
    const r = data as { ok: boolean; error?: string } | null;
    if (error || !r?.ok) {
      await sb.storage.from("documents").remove([path]);
      return setMsg({ error: error?.code === "PGRST202" ? "The owner needs to run update-0082 in Supabase first." : r?.error === "FORBIDDEN" ? "Only owners and the GM can upload documents." : "Could not save. Try again." });
    }
    setMsg({ ok: `${picked ? picked.title : title.trim()}, ${version.trim()} is now the current version.` });
    setFile(null); setNote("");
    router.refresh();
  }

  return (
    <div className="entry-grid doc-form">
      <label>Document
        <select value={doc} onChange={(e) => { setDoc(e.target.value); setVersion(docs.find((d) => d.key === e.target.value)?.next ?? "Version 1"); }}>
          {docs.map((d) => <option key={d.key} value={d.key}>{d.title}</option>)}
          <option value={NEW}>+ New document</option>
        </select>
      </label>
      {!picked && <>
        <label>Name<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Staff Employment Contract" /></label>
        <label>Group
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {["Client forms", "Staff forms", "Inventory", "Policies", "Other"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </>}
      <label>Version<input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={30} /></label>
      <label>Approved on<input type="date" value={approved} onChange={(e) => setApproved(e.target.value)} /></label>
      <label className="wide">What changed (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Adds the Service log code box" /></label>
      <label className="wide">PDF file<input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <div className="wide">
        <button type="button" disabled={busy} onClick={save}>{busy ? "Uploading…" : "Upload as the current version"}</button>
        <span className="small muted"> The version it replaces moves to Old versions.</span>
      </div>
      {msg.error && <p className="notice error wide">{msg.error}</p>}
      {msg.ok && <p className="notice ok wide">{msg.ok}</p>}
    </div>
  );
}

/** Owners and the GM: take a version off the page (added by mistake). */
export function RemoveVersion({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="link-button small danger-text" disabled={busy} onClick={async () => {
      if (!confirm(`Remove ${label}? It will no longer show on Documents.`)) return;
      setBusy(true);
      const r = await removeDocumentVersion(id);
      setBusy(false);
      if (r.error) alert(r.error); else router.refresh();
    }}>{busy ? "Removing…" : "Remove"}</button>
  );
}
