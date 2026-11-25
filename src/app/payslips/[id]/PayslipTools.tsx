"use client";
import { useState } from "react";
import { drawPayslip } from "@/lib/payslipImage";
import { pdfFromJpeg } from "@/lib/irImage";
import type { Payslip } from "@/lib/payroll";

const blobOf = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), type, q));
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Save as photo (PNG) or PDF, drawn in the browser. */
export function PayslipTools({ p }: { p: Payslip }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const name = `Payslip-${p.period_start}-${p.name.replace(/[^A-Za-z0-9]+/g, "-")}`;
  async function draw() {
    await document.fonts.ready;
    return drawPayslip(p, "/hermosa-logo-transparent.png", getComputedStyle(document.body).fontFamily || "sans-serif");
  }
  async function go(kind: "png" | "pdf") {
    setBusy(kind); setMsg(null);
    try {
      const c = await draw();
      if (kind === "png") download(await blobOf(c, "image/png"), `${name}.png`);
      else download(pdfFromJpeg(new Uint8Array(await (await blobOf(c, "image/jpeg", 0.92)).arrayBuffer()), c.width, c.height), `${name}.pdf`);
    } catch { setMsg("Could not make the file. Try again."); }
    setBusy(null);
  }
  return (
    <div className="row-buttons no-print">
      <button type="button" className="secondary" onClick={() => go("png")} disabled={!!busy}>{busy === "png" ? "Making photo…" : "Save as photo"}</button>
      <button type="button" className="secondary" onClick={() => go("pdf")} disabled={!!busy}>{busy === "pdf" ? "Making PDF…" : "Download PDF"}</button>
      {msg && <span className="small">{msg}</span>}
    </div>
  );
}
