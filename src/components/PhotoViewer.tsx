"use client";
// CHRIS Nov 26: tapping a chat photo opens it right on the page (not a new tab), on every page.
// v0.100.6 (CHRIS Nov 28): several photos at once (an entry's waiver pages, proofs, before and after): ‹ › arrows, swipe
// or the arrow keys to go through them; tap the photo to zoom in (to read a waiver), tap again to fit.
import { useEffect, useRef, useState } from "react";

const EVENT = "hermosa:view-photo";
export type ViewerPhoto = { src: string; alt?: string };
/** Opens the photo viewer over the current page. */
export const viewPhoto = (src: string, alt = "Photo") => window.dispatchEvent(new CustomEvent(EVENT, { detail: { list: [{ src, alt }], i: 0 } }));
/** Opens several photos; start = the one tapped. */
export const viewPhotos = (list: ViewerPhoto[], start = 0) => {
  if (list.length) window.dispatchEvent(new CustomEvent(EVENT, { detail: { list, i: Math.max(0, Math.min(start, list.length - 1)) } }));
};

/** A link straight to a photo file (Supabase signed URLs keep the file name before the ?token). */
function isPhotoUrl(href: string) {
  try { return /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(new URL(href, location.href).pathname); } catch { return false; }
}

type Show = { list: ViewerPhoto[]; i: number };

/** Mounted once (TopBar). Tap outside, ×, or Esc to close. */
export function PhotoViewer() {
  const [p, setP] = useState<Show | null>(null);
  const [zoom, setZoom] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = (d: number) => { setZoom(false); setP((s) => (s && s.list.length > 1 ? { ...s, i: (s.i + d + s.list.length) % s.list.length } : s)); };
  useEffect(() => {
    const on = (e: Event) => { setZoom(false); setP((e as CustomEvent<Show>).detail); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setP(null);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    // CHRIS Nov 27 (v0.91.0): every photo link in the app (NTE and IR proofs, time-in photos, client photos, payment
    // proofs) opens here, over the page, instead of a new tab. Downloads and links marked data-newtab still leave.
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download") || a.dataset.newtab !== undefined) return;
      const img = a.querySelector("img");
      if (!img && !isPhotoUrl(a.href)) return;
      e.preventDefault();
      setZoom(false);
      setP({ list: [{ src: isPhotoUrl(a.href) || !img ? a.href : img.currentSrc || img.src, alt: img?.alt || a.textContent?.trim() || "Photo" }], i: 0 });
    };
    window.addEventListener(EVENT, on); window.addEventListener("keydown", key); document.addEventListener("click", click);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener("keydown", key); document.removeEventListener("click", click); };
  }, []);
  if (!p) return null;
  const cur = p.list[p.i];
  const many = p.list.length > 1;
  return (
    <div className={`photo-viewer${zoom ? " zoomed" : ""}`} role="dialog" aria-modal="true" aria-label={cur.alt ?? "Photo"} onClick={() => setP(null)}
      onTouchStart={(e) => { if (!zoom && e.touches.length === 1) touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => {
        const t = touch.current; touch.current = null;
        if (!t || zoom || !many) return;
        const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img key={cur.src} src={cur.src} alt={cur.alt ?? "Photo"} title={zoom ? "Tap to fit" : "Tap to zoom in"}
        onClick={(e) => { e.stopPropagation(); setZoom((z) => !z); }} />
      {(many || cur.alt) && (
        <div className="photo-viewer-cap" onClick={(e) => e.stopPropagation()}>
          {cur.alt && <span>{cur.alt}</span>}{many && <span className="photo-viewer-n">{p.i + 1} / {p.list.length}</span>}
        </div>
      )}
      {many && <button type="button" className="photo-viewer-nav prev" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); go(-1); }}>‹</button>}
      {many && <button type="button" className="photo-viewer-nav next" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); go(1); }}>›</button>}
      <button type="button" className="photo-viewer-x" aria-label="Close" onClick={() => setP(null)}>×</button>
    </div>
  );
}
