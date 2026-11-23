"use client";
import { useEffect, useState, type ReactNode } from "react";

/** Keeps a confidential figure covered until tapped, and covers it again after 30 seconds. */
export function Reveal({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 30_000);
    return () => clearTimeout(t);
  }, [shown]);
  return (
    <button type="button" className="reveal" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
      <div className="label">{label}</div>
      {shown ? <div className="value">{children}</div> : <div className="value hidden" aria-label="Hidden">₱ • • • • •</div>}
      <div className="hint">{shown ? "Tap to hide" : "Tap to show"}</div>
      {shown && note ? <div className="note">{note}</div> : null}
    </button>
  );
}
