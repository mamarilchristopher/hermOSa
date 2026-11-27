"use client";
import { useState } from "react";
import type { LocationPick } from "@/lib/adsSteps";

/** The one location an ad set needs (CHRIS Nov 28): the clinic address to paste in "Search locations" and the radius. */
export function AddressBox({ pick, label }: { pick: LocationPick; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(pick.address); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
  };
  return (
    <div className="adv-bulk-box">
      <div className="adv-bulk-head">
        <span><b>{label}</b> <span className="muted">Paste in Locations › Search locations, then set the radius to <b>{pick.radius} mi</b></span></span>
        <button type="button" className="adv-ok adv-copy" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
      </div>
      <pre>{pick.address}</pre>
    </div>
  );
}
