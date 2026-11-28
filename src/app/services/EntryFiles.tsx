"use client";
// v0.100.6 (CHRIS Nov 28): see an entry's waiver pages and proof of payment right on its card while approving, so a sale
// isn't approved blind. Entries waiting for sign-off show small previews by themselves; the others have a button.
// Tapping a preview opens the in-app photo viewer (never a new tab), with ‹ › through every file of the entry.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { viewPhotos } from "@/components/PhotoViewer";

type Kind = "WAIVER" | "PROOF" | "BEFORE" | "AFTER";
type File = { kind: Kind; full: string; thumb: string };
const LABEL: Record<Kind, string> = { WAIVER: "Waiver", PROOF: "Proof of payment", BEFORE: "Before", AFTER: "After" };
const ORDER: Kind[] = ["WAIVER", "PROOF", "BEFORE", "AFTER"];
// Browsers other than Safari can't show HEIC originals: the viewer uses the saved preview for those.
const shows = (path: string) => !/\.(heic|heif)$/i.test(path);

async function load(log: string): Promise<File[] | null> {
  const sb = createClient();
  const [{ data: ph, error: e1 }, { data: pr }] = await Promise.all([
    sb.rpc("entry_photos", { p_log: log }),
    sb.from("payment_proofs").select("path, thumb_path").eq("service_log_id", log).order("created_at"),
  ]);
  const photos = (!e1 && ph?.ok ? ph.photos ?? [] : []) as { kind: Kind; path: string; thumb: string | null }[];
  const proofs = ((pr ?? []) as { path: string; thumb_path: string | null }[]).map((p) => ({ kind: "PROOF" as Kind, path: p.path, thumb: p.thumb_path }));
  if (e1 && !proofs.length) return null;
  const sign = async (bucket: string, list: { path: string; thumb: string | null }[]) => {
    const paths = [...new Set(list.flatMap((x) => [x.path, x.thumb].filter((s): s is string => !!s)))];
    if (!paths.length) return new Map<string, string>();
    const { data } = await sb.storage.from(bucket).createSignedUrls(paths, 3600);
    return new Map((data ?? []).filter((d) => d.path && d.signedUrl).map((d) => [d.path as string, d.signedUrl as string]));
  };
  const [cu, pu] = await Promise.all([sign("client-photos", photos), sign("payment-proofs", proofs)]);
  const out: File[] = [];
  for (const [list, urls] of [[photos, cu], [proofs, pu]] as const) {
    for (const x of list) {
      const full = urls.get(x.path), thumb = x.thumb ? urls.get(x.thumb) : undefined;
      const view = full && shows(x.path) ? full : thumb ?? full;
      if (view) out.push({ kind: x.kind, full: view, thumb: thumb ?? view });
    }
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** auto: load as soon as the card scrolls into view (entries waiting for sign-off). needsWaiver: paid visits and backjobs. */
export function EntryFiles({ log, auto, needsWaiver }: { log: string; auto: boolean; needsWaiver: boolean }) {
  const [open, setOpen] = useState(auto);
  const [files, setFiles] = useState<File[] | null | "loading">("loading");
  const box = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!open || started.current) return;
    const start = () => { if (started.current) return; started.current = true; void load(log).then(setFiles).catch(() => setFiles(null)); };
    const el = box.current;
    if (!auto || !el || typeof IntersectionObserver === "undefined") { start(); return; }
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [open, auto, log]);

  if (!open) return <button type="button" className="secondary small" onClick={() => setOpen(true)}>📄 Waiver &amp; proof</button>;
  const list = Array.isArray(files) ? files : [];
  const waivers = list.filter((f) => f.kind === "WAIVER").length;
  const proofs = list.filter((f) => f.kind === "PROOF").length;
  const all = list.map((f, i) => ({ src: f.full, alt: `${LABEL[f.kind]}${list.filter((x) => x.kind === f.kind).length > 1 ? ` ${list.slice(0, i + 1).filter((x) => x.kind === f.kind).length}` : ""}` }));
  return (
    <div ref={box} className="entry-files">
      {files === "loading" ? <span className="small muted">Loading waiver and proof…</span>
        : files === null ? <span className="small muted">Couldn&apos;t load the files. Refresh the page.</span> : (
          <>
            <div className="entry-files-row">
              {list.map((f, i) => (
                <button key={f.full} type="button" className={`entry-file ${f.kind}`} onClick={() => viewPhotos(all, i)} aria-label={`Open ${all[i].alt}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.thumb} alt="" loading="lazy" />
                  <span>{all[i].alt}</span>
                </button>
              ))}
              {list.length === 0 && <span className="small muted">No photos or proof attached.</span>}
            </div>
            <div className="entry-files-note small">
              {needsWaiver && waivers === 0 && <span className="pill REVERSED">No waiver attached</span>}
              {waivers > 0 && <span className="muted">{waivers} waiver page{waivers === 1 ? "" : "s"}</span>}
              <span className="muted">{proofs ? `${proofs} proof${proofs === 1 ? "" : "s"} of payment` : "No proof of payment"}</span>
              {!auto && <button type="button" className="link-like small" onClick={() => setOpen(false)}>Hide</button>}
            </div>
          </>
        )}
    </div>
  );
}
