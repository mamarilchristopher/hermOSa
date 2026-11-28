"use client";
import { useState } from "react";
import type { AddonIdea } from "@/lib/gmDay";
import { IconBulb } from "@/components/Icons";
import { IconText } from "@/components/IconText";

/** Today's add-on idea: the offer, why, and a ready message to ask the owners (CHRIS Nov 27). */
export function AddonCard({ idea }: { idea: AddonIdea }) {
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(idea.ask); setNote("Copied. Paste it in Chat to the owners."); } catch { setNote("Could not copy. Select the text below instead."); setOpen(true); }
  }
  return (
    <section className={`card myday-addon ${idea.day}`}>
      <div className="myday-addon-head">
        <IconBulb size={34} className="e" />
        <div>
          <span className="label">Today&apos;s add-on idea · ask the owners first</span>
          <h2>{idea.title}</h2>
        </div>
      </div>
      <div className="myday-addon-chips">{idea.chips.map((c) => <span key={c}><IconText text={c} /></span>)}</div>
      <p className="myday-addon-offer">{idea.offer}</p>
      <details className="myday-addon-why">
        <summary>Why this works today</summary>
        <ul>{idea.why.map((w) => <li key={w}>{w}</li>)}</ul>
      </details>
      <div className="row-buttons">
        <button type="button" className="small" onClick={copy}>Copy message for the owners</button>
        <button type="button" className="secondary small" onClick={() => setOpen((x) => !x)}>{open ? "Hide message" : "See message"}</button>
      </div>
      {open && <p className="small myday-addon-ask">{idea.ask}</p>}
      {note && <span className="small">{note}</span>}
    </section>
  );
}
