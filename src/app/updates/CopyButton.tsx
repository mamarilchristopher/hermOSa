"use client";
import { useState } from "react";

/** Copies text for pasting into the management chat; falls back to a selectable box when the phone blocks copying. */
export function CopyButton({ text, label = "Copy", className = "secondary" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "manual">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState("done"); setTimeout(() => setState("idle"), 1600); }
    catch { setState("manual"); }
  };
  return (
    <>
      <button type="button" className={`${className} copy-btn`} onClick={copy}>{state === "done" ? "Copied ✓" : label}</button>
      {state === "manual" && <textarea className="copy-manual" readOnly value={text} rows={6} onFocus={(e) => e.currentTarget.select()} autoFocus />}
    </>
  );
}
