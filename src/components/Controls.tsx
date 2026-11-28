// v0.98.1 (CHRIS Nov 27): one look for every page, taken from the Service log he likes:
//   page title + one line of help → a control bar card (branch tabs left, date / month nav right) → stat cards →
//   actions as real buttons. "Add …" panels open from a button, never a row that looks like an empty field.
// Server-safe (no "use client"): plain links, GET forms and <details>.
import Link from "next/link";
import type { ReactNode } from "react";
import { IconCheck, IconPlus } from "./Icons";

/** The card that holds the branch tabs and the period nav, side by side on PC, stacked on phones. */
export function ControlBar({ children }: { children: ReactNode }) {
  return <div className="periods card control-bar">{children}</div>;
}

export type Tab = { href: string; label: string; on: boolean };
/** Branch (or any) choice. v0.106.10 (CHRIS Nov 28: "These branch buttons are not really looking like buttons"): each one is a
 *  separate raised button; the picked one turns gold with a check. "(Sikatuna)"-style suffixes are dropped to keep them short. */
export function Tabs({ tabs, label = "Branch" }: { tabs: Tab[]; label?: string }) {
  if (tabs.length < 2) return null;
  return (
    <div className="segmented tab-chips" role="tablist" aria-label={label}>
      {tabs.map((t) => <Link key={t.href} href={t.href} role="tab" aria-selected={t.on} className={t.on ? "on" : ""}>{t.on && <IconCheck size={16} />}<span>{t.label.replace(/ \(.*\)$/, "")}</span></Link>)}
    </div>
  );
}

/** ← label → with an optional "Today" / "This month" button. `next` null = no later period. */
export function PeriodNav({ prev, next, label, reset, prevLabel = "Previous", nextLabel = "Next" }: {
  prev: string; next: string | null; label: ReactNode; reset?: { href: string; label: string } | null; prevLabel?: string; nextLabel?: string;
}) {
  return (
    <div className="day-nav period-nav">
      <Link className="button secondary small" href={prev} aria-label={prevLabel}>←</Link>
      <strong className="period-label">{label}</strong>
      {next ? <Link className="button secondary small" href={next} aria-label={nextLabel}>→</Link>
        : <span className="button secondary small is-off" aria-hidden>→</span>}
      {reset && <Link className="button secondary small" href={reset.href}>{reset.label}</Link>}
    </div>
  );
}

/** ← [date picker] Go → Today, as on the Service log. `keep` = other query params to carry along. */
export function DayPicker({ name, value, max, prev, next, today, keep = {} }: {
  name: string; value: string; max?: string; prev: string; next: string | null; today?: string | null; keep?: Record<string, string>;
}) {
  return (
    <form className="day-nav">
      {Object.entries(keep).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Link className="button secondary small" href={prev} aria-label="Previous day">←</Link>
      <input type="date" name={name} defaultValue={value} max={max} aria-label="Date" />
      <button type="submit" className="secondary small">Go</button>
      {next && <Link className="button secondary small" href={next} aria-label="Next day">→</Link>}
      {today && <Link className="button secondary small" href={today}>Today</Link>}
    </form>
  );
}

/** A row of stat cards. The first can be the gold-lined hero. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="grid stats-row">{children}</div>;
}
export function Stat({ label, value, note, hero = false, tone }: { label: ReactNode; value: ReactNode; note?: ReactNode; hero?: boolean; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className={`card stat${hero ? " hero" : ""}${tone ? ` tone-${tone}` : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

/** "+ Add …" that looks like a button and opens its form under it. */
export function AddPanel({ title, hint, open = false, id, children }: { title: string; hint?: string; open?: boolean; id?: string; children: ReactNode }) {
  return (
    <details className="card add-panel" id={id} open={open || undefined}>
      <summary>
        <span className="add-btn"><IconPlus />{title}</span>
        {hint && <span className="small muted add-hint">{hint}</span>}
      </summary>
      <div className="add-body">{children}</div>
    </details>
  );
}
