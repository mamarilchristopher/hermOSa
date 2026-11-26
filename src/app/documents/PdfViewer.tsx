"use client";
import { useEffect, useRef, useState } from "react";

/* pdf.js (Apache-2.0, legacy build for older phones) is served with the app from /pdfjs/. */
type PdfPage = { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> } };
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfJs = { GlobalWorkerOptions: { workerSrc: string }; getDocument: (o: { data: Uint8Array }) => { promise: Promise<PdfDoc> } };

/** Shows a PDF inside the app, page by page, with Download and Share (CHRIS Nov 26). */
export function PdfViewer({ url, fileName, title, sharePath }: { url: string; fileName: string; title: string; sharePath: string }) {
  const pages = useRef<HTMLDivElement>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "fallback" | "error">("loading");
  const [count, setCount] = useState(0);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let gone = false;
    (async () => {
      let buf: ArrayBuffer;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        buf = await res.arrayBuffer();
        if (gone) return;
        setBytes(buf);
      } catch { if (!gone) setState("error"); return; }
      try {
        const lib = (await import(/* webpackIgnore: true */ "/pdfjs/pdf.min.mjs" as string)) as PdfJs;
        lib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
        if (gone || !pages.current) return;
        setCount(pdf.numPages);
        const box = pages.current;
        box.innerHTML = "";
        const width = Math.min(box.clientWidth || 800, 1000);
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
          canvas.className = "pdf-page";
          canvas.setAttribute("aria-label", `Page ${n} of ${pdf.numPages}`);
          box.appendChild(canvas);
          const ctx = canvas.getContext("2d");
          if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
          if (gone) return;
        }
        setState("ready");
      } catch { if (!gone) setState("fallback"); }
    })();
    return () => { gone = true; };
  }, [url]);

  const blob = () => (bytes ? new Blob([bytes], { type: "application/pdf" }) : null);

  function download() {
    const b = blob();
    const a = document.createElement("a");
    a.href = b ? URL.createObjectURL(b) : url;
    a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    if (b) setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  async function share() {
    setMsg("");
    const b = blob();
    const link = `${window.location.origin}${sharePath}`;
    try {
      const file = b ? new File([b], fileName, { type: "application/pdf" }) : null;
      if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title }); return; }
      if (navigator.share) { await navigator.share({ title, url: link }); return; }
      await navigator.clipboard.writeText(link);
      setMsg("Link copied. It opens for anyone signed in to Hermosa OS. To send the file itself, use Download.");
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setMsg("Couldn't share from this device. Use Download instead.");
    }
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-bar">
        <span className="small muted">{state === "loading" ? "Opening…" : count ? `${count} page${count === 1 ? "" : "s"}` : "PDF"}</span>
        <span className="pdf-actions">
          <button type="button" className="secondary small" onClick={download} disabled={state === "error"}>Download PDF</button>
          <button type="button" className="small" onClick={share} disabled={state === "error"}>Share</button>
        </span>
      </div>
      {msg && <p className="small notice info">{msg}</p>}
      {state === "error" && <div className="notice error">Could not open this file. Check your connection and try again.</div>}
      {state === "fallback" && (
        <>
          <iframe className="pdf-frame" src={url} title={title} />
          <p className="small muted">Not showing? <a href={url} target="_blank" rel="noreferrer">Open the PDF</a>.</p>
        </>
      )}
      <div ref={pages} className="pdf-pages" hidden={state === "fallback" || state === "error"} />
    </div>
  );
}
