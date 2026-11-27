"use client";
import { useEffect, useState } from "react";

const KEY = (id: string) => `adv-ok:${id}`;

/** One-tap OK on an advisor move (CHRIS Nov 27: actionable dashboards). It copies the OK so it can be pasted to the ads
 *  chat, and remembers the tick on this device. Nothing changes in Meta until CHRIS OKs the preview there. */
export function ApproveChip({ id, text }: { id: string; text: string }) {
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    try { setOk(localStorage.getItem(KEY(id)) === "1"); } catch { /* private mode */ }
  }, [id]);
  const tap = async () => {
    const next = !ok;
    setOk(next);
    try { if (next) localStorage.setItem(KEY(id), "1"); else localStorage.removeItem(KEY(id)); } catch { /* private mode */ }
    if (next) {
      try { await navigator.clipboard.writeText(`OK: ${text}`); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
    }
  };
  return (
    <button type="button" className={`adv-ok${ok ? " on" : ""}`} onClick={tap} aria-pressed={ok}
      title="Copies your OK to paste in the ads chat. Meta changes only after you OK the preview there.">
      {ok ? (copied ? "✓ OK copied" : "✓ OK'd") : "Approve"}
    </button>
  );
}
