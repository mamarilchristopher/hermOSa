"use client";
import { useState } from "react";
import type { BulkBlock } from "@/lib/adsSteps";

/** Paste-ready text for Ads Manager › Locations › "Add locations in bulk" (CHRIS Nov 28): the settings to pick in the
 *  dialog, and the lines to paste, with one-tap copy. */
export function BulkBox({ blocks }: { blocks: BulkBlock[] }) {
  const [copied, setCopied] = useState<number | null>(null);
  const copy = async (i: number) => {
    try { await navigator.clipboard.writeText(blocks[i].lines.join("\n")); setCopied(i); setTimeout(() => setCopied(null), 2500); } catch { setCopied(null); }
  };
  return (
    <div className="adv-bulk">
      {blocks.map((b, i) => (
        <div key={i} className={`adv-bulk-box${b.exclude ? " ex" : ""}`}>
          <div className="adv-bulk-head">
            <span><b>Box {i + 1} · {b.label}</b> <span className="muted">Location type: {b.type} · Default radius: {b.radius} mi{b.exclude ? " · then set to Exclude" : ""}</span></span>
            <button type="button" className="adv-ok adv-copy" onClick={() => copy(i)}>{copied === i ? "✓ Copied" : "Copy"}</button>
          </div>
          <pre>{b.lines.join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}
