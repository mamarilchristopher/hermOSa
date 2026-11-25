"use client";
// Client archive (CHRIS, Nov 26): every archive photo carries an auto-tag at the bottom — client, service, branch,
// date, lead/assist. The stored original stays untouched; the tag is added to the downloaded copy as a strip BELOW the
// photo (nothing covers the photo itself), at full resolution. Social media photos are never tagged.
import { useState } from "react";

export function TaggedDownload({ url, tag, filename }: { url: string; tag: string; filename: string }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const blob = await (await fetch(url)).blob();
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
      const font = Math.max(18, Math.round(bmp.width / 45));
      const pad = Math.round(font * 0.8);
      const c = document.createElement("canvas");
      const g0 = c.getContext("2d")!;
      g0.font = `600 ${font}px system-ui, sans-serif`;
      // Wrap the tag to the photo's width.
      const words = tag.split(" "); const lines: string[] = []; let line = "";
      for (const w of words) {
        const t = line ? `${line} ${w}` : w;
        if (g0.measureText(t).width > bmp.width - pad * 2 && line) { lines.push(line); line = w; } else line = t;
      }
      if (line) lines.push(line);
      const strip = pad * 2 + lines.length * Math.round(font * 1.3);
      c.width = bmp.width; c.height = bmp.height + strip;
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      g.fillStyle = "#2f241d"; g.fillRect(0, bmp.height, c.width, strip);
      g.fillStyle = "#ffffff"; g.font = `600 ${font}px system-ui, sans-serif`; g.textBaseline = "top";
      lines.forEach((l, i) => g.fillText(l, pad, bmp.height + pad + i * Math.round(font * 1.3)));
      const out = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("photo"))), "image/jpeg", 0.95));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(out); a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch {
      // A format the browser can't draw (e.g. HEIC outside Safari): save the untouched original instead.
      window.open(url, "_blank", "noopener");
    } finally { setBusy(false); }
  };
  return <button type="button" className="link-button small" onClick={go} disabled={busy}>{busy ? "Preparing…" : "Download"}</button>;
}
