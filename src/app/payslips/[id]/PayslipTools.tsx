"use client";
import { useState } from "react";
import { drawPayslipPages } from "@/lib/payslipImage";
import { pdfFromJpegs } from "@/lib/irImage";
import type { Payslip } from "@/lib/payroll";

const blobOf = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), type, q));
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Save as photo (every page as a PNG), Copy as photo (page 1) or Download PDF (all pages), drawn in the browser. */
export function PayslipTools({ p }: { p: Payslip }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const name = `Payslip-${p.period_start}-${p.name.replace(/[^A-Za-z0-9]+/g, "-")}`;
  async function draw() {
    await document.fonts.ready;
    return drawPayslipPages(p, "/hermosa-logo-transparent.png", getComputedStyle(document.body).fontFamily || "sans-serif");
  }
  async function go(kind: "png" | "pdf") {
    setBusy(kind); setMsg(null);
    try {
      const pages = await draw();
      if (kind === "png") {
        for (let i = 0; i < pages.length; i++) {
          download(await blobOf(pages[i], "image/png"), pages.length > 1 ? `${name}-page-${i + 1}.png` : `${name}.png`);
          if (i < pages.length - 1) await new Promise((r) => setTimeout(r, 400));
        }
      } else {
        const jpegs = await Promise.all(pages.map(async (c) => ({ jpeg: new Uint8Array(await (await blobOf(c, "image/jpeg", 0.92)).arrayBuffer()), w: c.width, h: c.height })));
        download(pdfFromJpegs(jpegs), `${name}.pdf`);
      }
    } catch { setMsg("Could not make the file. Try again."); }
    setBusy(null);
  }
  async function copy() {
    setBusy("copy"); setMsg(null);
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") throw new Error("no clipboard");
      // Safari needs the clipboard write to start right away, so it gets a promise of the image.
      const png = draw().then((pages) => blobOf(pages[0], "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setMsg("Page 1 copied. Paste it in a chat.");
    } catch { setMsg("This browser can't copy photos. Use Save as photo instead."); }
    setBusy(null);
  }
  const more = p.commissions.length > 0;
  return (
    <div className="row-buttons no-print">
      <button type="button" className="secondary" onClick={copy} disabled={!!busy}>{busy === "copy" ? "Copying…" : "Copy as photo"}</button>
      <button type="button" className="secondary" onClick={() => go("png")} disabled={!!busy}>{busy === "png" ? "Making photos…" : more ? "Save as photos" : "Save as photo"}</button>
      <button type="button" className="secondary" onClick={() => go("pdf")} disabled={!!busy}>{busy === "pdf" ? "Making PDF…" : "Download PDF"}</button>
      {msg && <span className="small">{msg}</span>}
    </div>
  );
}
