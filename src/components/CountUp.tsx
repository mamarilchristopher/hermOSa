"use client";
import { useEffect, useRef, useState } from "react";

/** A peso figure that counts up when the page opens (CHRIS Nov 27: a livelier dashboard). The server renders the final
 *  text, so it reads correctly without JavaScript and for screen readers; reduced motion skips the animation. */
export function CountUp({ cents, compact = false }: { cents: number; compact?: boolean }) {
  const fmt = (c: number) => {
    const p = c / 100;
    if (compact && p >= 1_000_000) return `₱${(p / 1_000_000).toFixed(p >= 10_000_000 ? 0 : 1)}M`;
    if (compact && p >= 1_000) return `₱${Math.round(p / 1_000)}K`;
    return `₱${Math.round(p).toLocaleString("en-PH")}`;
  };
  const [shown, setShown] = useState(cents);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || cents <= 0 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    done.current = true;
    const t0 = performance.now(), dur = 900;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setShown(Math.round(cents * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return <span aria-label={fmt(cents)}>{fmt(shown)}</span>;
}
