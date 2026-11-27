"use client";
// CHRIS Nov 26: tapping a chat photo opens it right on the page (not a new tab), on every page.
import { useEffect, useState } from "react";

const EVENT = "hermosa:view-photo";
/** Opens the photo viewer over the current page. */
export const viewPhoto = (src: string, alt = "Photo") => window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, alt } }));

/** A link straight to a photo file (Supabase signed URLs keep the file name before the ?token). */
function isPhotoUrl(href: string) {
  try { return /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(new URL(href, location.href).pathname); } catch { return false; }
}

/** Mounted once (TopBar). Tap outside, ×, or Esc to close. */
export function PhotoViewer() {
  const [p, setP] = useState<{ src: string; alt: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<{ src: string; alt: string }>).detail);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setP(null); };
    // CHRIS Nov 27 (v0.91.0): every photo link in the app (NTE and IR proofs, time-in photos, client photos, payment
    // proofs) opens here, over the page, instead of a new tab. Downloads and links marked data-newtab still leave.
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download") || a.dataset.newtab !== undefined) return;
      const img = a.querySelector("img");
      if (!img && !isPhotoUrl(a.href)) return;
      e.preventDefault();
      setP({ src: isPhotoUrl(a.href) || !img ? a.href : img.currentSrc || img.src, alt: img?.alt || a.textContent?.trim() || "Photo" });
    };
    window.addEventListener(EVENT, on); window.addEventListener("keydown", key); document.addEventListener("click", click);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener("keydown", key); document.removeEventListener("click", click); };
  }, []);
  if (!p) return null;
  return (
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label={p.alt} onClick={() => setP(null)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.src} alt={p.alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="photo-viewer-x" aria-label="Close" onClick={() => setP(null)}>×</button>
    </div>
  );
}
