"use client";
import { useEffect, useState } from "react";

const KEY = (id: string) => `adv-done:${id}`;

/** Delegating a fix (CHRIS Nov 28): copy the link, the values and the numbered steps to send to whoever does it,
 *  and tick Done on this device once it's finished. */
export function TaskChip({ id, text }: { id: string; text: string }) {
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    try { setDone(localStorage.getItem(KEY(id)) === "1"); } catch { /* private mode */ }
  }, [id]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
  };
  const tick = () => {
    const next = !done;
    setDone(next);
    try { if (next) localStorage.setItem(KEY(id), "1"); else localStorage.removeItem(KEY(id)); } catch { /* private mode */ }
  };
  return (
    <>
      <button type="button" className="adv-ok adv-copy" onClick={copy} title="Copies the link, the settings and the numbered steps, ready to send">{copied ? "✓ Copied" : "Copy steps"}</button>
      <button type="button" className={`adv-ok adv-done${done ? " on" : ""}`} onClick={tick} aria-pressed={done}>{done ? "✓ Done" : "Done"}</button>
    </>
  );
}
