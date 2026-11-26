"use client";
// CHRIS Nov 26: tapping a chat photo opens it right on the page (not a new tab), on every page.
import { useEffect, useState } from "react";

const EVENT = "hermosa:view-photo";
/** Opens the photo viewer over the current page. */
export const viewPhoto = (src: string, alt = "Photo") => window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, alt } }));

/** Mounted once (TopBar). Tap outside, ×, or Esc to close. */
export function PhotoViewer() {
  const [p, setP] = useState<{ src: string; alt: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<{ src: string; alt: string }>).detail);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setP(null); };
    window.addEventListener(EVENT, on); window.addEventListener("keydown", key);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener("keydown", key); };
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
