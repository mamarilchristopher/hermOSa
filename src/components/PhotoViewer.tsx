"use client";
// CHRIS Nov 26: tapping a chat photo opens it right on the page (not a new tab), on every page.
// v0.100.6 (CHRIS Nov 28): several photos at once (an entry's waiver pages, proofs, before and after): ‹ › arrows, swipe
// or the arrow keys to go through them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
const MAX = 5;
const clamp = (z: number) => Math.min(MAX, Math.max(1, Math.round(z * 100) / 100));

/** Mounted once (TopBar). Tap outside, ×, or Esc to close.
 *  v0.100.7 (CHRIS Nov 28): a photo always opens fitted to the screen. Zoom with a tap (2.5×, tap again to fit),
 *  pinch on phones, Ctrl/trackpad pinch on PC, or the − / + buttons; drag or scroll to move around while zoomed. */
export function PhotoViewer() {
  const [p, setP] = useState<Show | null>(null);
  const [zoom, setZoomRaw] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const fit = useRef<{ w: number; h: number } | null>(null); // the photo's size when fitted
  const focus = useRef<{ rx: number; ry: number; cx: number; cy: number } | null>(null); // keep this point under the finger
  const touch = useRef<{ x: number; y: number; d?: number; z?: number } | null>(null);
  const zoomRef = useRef(1);
  const setZoom = (z: number, at?: { x: number; y: number }) => {
    const el = img.current, b = box.current;
    if (el && b && at) {
      const r = el.getBoundingClientRect();
      focus.current = { rx: (at.x - r.left) / r.width, ry: (at.y - r.top) / r.height, cx: at.x, cy: at.y };
    } else focus.current = null;
    if (zoomRef.current === 1 && el) { const r = el.getBoundingClientRect(); if (r.width) fit.current = { w: r.width, h: r.height }; }
    zoomRef.current = clamp(z); setZoomRaw(zoomRef.current);
  };
  const reset = () => { zoomRef.current = 1; setZoomRaw(1); focus.current = null; };
  const go = (d: number) => { reset(); setP((s) => (s && s.list.length > 1 ? { ...s, i: (s.i + d + s.list.length) % s.list.length } : s)); };

  useLayoutEffect(() => {
    const b = box.current, f = fit.current;
    if (!b || !f || zoom === 1) return;
    const W = f.w * zoom, H = f.h * zoom;
    const c = focus.current ?? { rx: 0.5, ry: 0.5, cx: b.clientWidth / 2, cy: b.clientHeight / 2 };
    const padX = Math.max(0, (b.clientWidth - W) / 2), padY = Math.max(0, (b.clientHeight - H) / 2);
    b.scrollLeft = padX + c.rx * W - c.cx;
    b.scrollTop = padY + c.ry * H - c.cy;
  }, [zoom]);

  useEffect(() => {
    const on = (e: Event) => { reset(); setP((e as CustomEvent<Show>).detail); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setP(null);
      else if (e.key === "ArrowRight" && zoomRef.current === 1) go(1);
      else if (e.key === "ArrowLeft" && zoomRef.current === 1) go(-1);
      else if (e.key === "+" || e.key === "=") setZoom(zoomRef.current * 1.5);
      else if (e.key === "-") setZoom(zoomRef.current / 1.5);
    };
    // CHRIS Nov 27 (v0.91.0): every photo link in the app (NTE and IR proofs, time-in photos, client photos, payment
    // proofs) opens here, over the page, instead of a new tab. Downloads and links marked data-newtab still leave.
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download") || a.dataset.newtab !== undefined) return;
      const im = a.querySelector("img");
      if (!im && !isPhotoUrl(a.href)) return;
      e.preventDefault();
      reset();
      setP({ list: [{ src: isPhotoUrl(a.href) || !im ? a.href : im.currentSrc || im.src, alt: im?.alt || a.textContent?.trim() || "Photo" }], i: 0 });
    };
    window.addEventListener(EVENT, on); window.addEventListener("keydown", key); document.addEventListener("click", click);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener("keydown", key); document.removeEventListener("click", click); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl + wheel (trackpad pinch on PC) zooms; needs a non-passive listener to stop the page itself zooming.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); setZoom(zoomRef.current * Math.exp(-e.deltaY / 200), { x: e.clientX, y: e.clientY }); };
    b.addEventListener("wheel", wheel, { passive: false });
    return () => b.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  if (!p) return null;
  const cur = p.list[p.i];
  const many = p.list.length > 1;
  const zoomed = zoom > 1 && !!fit.current;
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  return (
    <div ref={box} className={`photo-viewer${zoomed ? " zoomed" : ""}`} role="dialog" aria-modal="true" aria-label={cur.alt ?? "Photo"}
      onClick={() => { if (zoomRef.current === 1) setP(null); }}
      onTouchStart={(e) => {
        if (e.touches.length === 2) touch.current = { x: 0, y: 0, d: dist(e.touches), z: zoomRef.current };
        else if (e.touches.length === 1) touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchMove={(e) => {
        const t = touch.current;
        if (e.touches.length === 2 && t?.d) {
          const mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
          setZoom((t.z ?? 1) * (dist(e.touches) / t.d), mid);
        }
      }}
      onTouchEnd={(e) => {
        const t = touch.current;
        if (e.touches.length === 0) touch.current = null;
        if (!t || t.d || zoomRef.current > 1 || !many) return;
        const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      }}>
      <div className="photo-viewer-stage" style={zoomed ? { width: Math.max(fit.current!.w * zoom, box.current?.clientWidth ?? 0), height: Math.max(fit.current!.h * zoom, box.current?.clientHeight ?? 0) } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={img} key={cur.src} src={cur.src} alt={cur.alt ?? "Photo"} draggable={false} title={zoomed ? "Tap to fit the screen" : "Tap to zoom in"}
          style={zoomed ? { width: fit.current!.w * zoom, height: fit.current!.h * zoom, maxWidth: "none", maxHeight: "none" } : undefined}
          onClick={(e) => { e.stopPropagation(); if (zoomRef.current > 1) reset(); else setZoom(2.5, { x: e.clientX, y: e.clientY }); }} />
      </div>
      <div className="photo-viewer-cap" onClick={(e) => e.stopPropagation()}>
        {cur.alt && <span className="photo-viewer-alt">{cur.alt}</span>}{many && <span className="photo-viewer-n">{p.i + 1} / {p.list.length}</span>}
        <span className="photo-viewer-zoom">
          <button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(zoomRef.current / 1.5)}>−</button>
          <button type="button" className="fit" aria-label="Fit to screen" disabled={zoom <= 1} onClick={reset}>{zoom > 1 ? `${Math.round(zoom * 100)}%` : "Fit"}</button>
          <button type="button" aria-label="Zoom in" disabled={zoom >= MAX} onClick={() => setZoom(zoomRef.current * 1.5)}>+</button>
        </span>
      </div>
      {many && !zoomed && <button type="button" className="photo-viewer-nav prev" aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); go(-1); }}>‹</button>}
      {many && !zoomed && <button type="button" className="photo-viewer-nav next" aria-label="Next photo" onClick={(e) => { e.stopPropagation(); go(1); }}>›</button>}
      <button type="button" className="photo-viewer-x" aria-label="Close" onClick={(e) => { e.stopPropagation(); setP(null); }}>×</button>
    </div>
  );
}
