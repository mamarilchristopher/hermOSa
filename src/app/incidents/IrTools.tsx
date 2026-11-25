"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { drawIrImage, pdfFromJpeg } from "@/lib/irImage";
import type { Ir } from "@/lib/incidents";
import { markIrPdf } from "./actions";

async function draw(r: Ir) {
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  await document.fonts.ready;
  return drawIrImage(r, "/hermosa-logo-transparent.png", font);
}
const blobOf = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), type, q));

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function makePdf(r: Ir) {
  const c = await draw(r);
  const jpeg = new Uint8Array(await (await blobOf(c, "image/jpeg", 0.9)).arrayBuffer());
  return pdfFromJpeg(jpeg, c.width, c.height);
}

/**
 * Save as photo (PNG) for anyone who can see the IR. For management: the IR is kept as a PDF in private storage,
 * saved again automatically whenever it changed since the last save, plus a Download PDF button.
 */
export function IrTools({ r }: { r: Ir }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const saved = useRef(false);
  const stale = r.can_manage && r.state !== "DRAFT" && (!r.pdf_saved_at || (r.updated_at != null && r.pdf_saved_at < r.updated_at));

  async function savePdf(quiet: boolean) {
    try {
      const pdf = await makePdf(r);
      const { error } = await createClient().storage.from("incident-reports").upload(`${r.id}.pdf`, pdf, { contentType: "application/pdf", upsert: true });
      if (error) throw error;
      await markIrPdf(r.id);
      if (!quiet) setMsg("Saved as PDF in Hermosa OS.");
      return pdf;
    } catch {
      if (!quiet) setMsg("Could not save the PDF. Check your internet and try again.");
      return null;
    }
  }

  useEffect(() => {
    if (stale && !saved.current) { saved.current = true; void savePdf(true); }
  });

  async function photo() {
    setBusy("photo"); setMsg(null);
    try { download(await blobOf(await draw(r), "image/png"), `IR-${r.ir_no}-${r.name.replace(/\s+/g, "-")}.png`); }
    catch { setMsg("Could not make the photo. Try again."); }
    setBusy(null);
  }

  async function pdf() {
    setBusy("pdf"); setMsg(null);
    const name = `IR-${r.ir_no}-${r.name.replace(/\s+/g, "-")}.pdf`;
    const fresh = r.can_manage ? await savePdf(false) : null;
    const blob = fresh ?? (await makePdf(r).catch(() => null));
    if (blob) download(blob, name); else setMsg("Could not make the PDF. Try again.");
    setBusy(null);
  }

  if (r.state === "DRAFT") return null;
  return (
    <div className="row-buttons no-print">
      <button type="button" className="secondary" onClick={photo} disabled={!!busy}>{busy === "photo" ? "Making photo…" : "Save as photo"}</button>
      <button type="button" className="secondary" onClick={pdf} disabled={!!busy}>{busy === "pdf" ? "Making PDF…" : "Download PDF"}</button>
      {r.can_manage && <span className="small muted">{r.pdf_saved_at && !stale ? "Kept as PDF in Hermosa OS" : "Saving a PDF copy in Hermosa OS…"}</span>}
      {msg && <span className="small">{msg}</span>}
    </div>
  );
}
