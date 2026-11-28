"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { DaySection } from "@/lib/gmDay";
import { EmojiIcon } from "@/components/IconText";

/** My day checklist: tick items as you go. Ticks stay on this device for today only (a reminder, not a record). */
export function DayList({ sections, today }: { sections: DaySection[]; today: string }) {
  const key = `myday:${today}`;
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setTicked(new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[])); } catch { /* private mode: start empty */ }
  }, [key]);
  const toggle = (k: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* not saved: fine */ }
    return next;
  });
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const done = sections.reduce((n, s) => n + s.items.filter((i) => ticked.has(i.key)).length, 0);
  return (
    <>
      <div className="myday-progress" aria-live="polite">
        <span className="myday-bar"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
        <span className="small"><strong>{done}</strong> of {total} checked today</span>
      </div>
      <div className="myday-grid">
        {sections.map((s) => (
          <section key={s.key} className="card myday-sec">
            <h2><EmojiIcon e={s.icon} size={22} className="ic-lead" />{s.title} <small>{s.when}</small></h2>
            <ul>
              {s.items.map((i) => {
                const on = ticked.has(i.key);
                return (
                  <li key={i.key} className={`myday-item ${i.tone}${on ? " done" : ""}`}>
                    <button type="button" className="myday-tick" aria-pressed={on} aria-label={`${on ? "Untick" : "Tick"}: ${i.title}`} onClick={() => toggle(i.key)}>{on ? "✓" : ""}</button>
                    <span className="myday-ico" aria-hidden><EmojiIcon e={i.icon} size={20} /></span>
                    <span className="myday-text">
                      <b>{i.title}</b>
                      <span>{i.note}</span>
                    </span>
                    {i.count !== undefined && i.count > 0 && <span className={`myday-count ${i.tone}`}>{i.count}</span>}
                    {i.href && <Link className="myday-go" href={i.href} aria-label={`Open: ${i.title}`}>›</Link>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
