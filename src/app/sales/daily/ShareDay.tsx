"use client";
import { useState } from "react";
import { dailyShareText, dailySummary, type ShareCell } from "@/lib/dailyShare";
import { drawDailyImage } from "@/lib/dailyImage";

/** "Send to Management Chat": makes the day's sales image and opens the phone's share sheet (Messenger > chat > Send). */
export function ShareDay({ dates, branches, cellOf, today }: {
  dates: string[]; branches: { id: string; name: string }[]; today: string;
  cellOf: (branch: string, date: string) => ShareCell | undefined;
}) {
  const filled = dates.filter((d) => d <= today && branches.some((b) => { const c = cellOf(b.id, d); return c?.cents != null || c?.mark; }));
  const [day, setDay] = useState(filled.at(-1) ?? dates.filter((d) => d <= today).at(-1) ?? dates[0]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function send() {
    setBusy(true); setNote(null);
    try {
      const s = dailySummary(day, branches, dates, cellOf);
      const font = getComputedStyle(document.body).fontFamily || "sans-serif";
      await document.fonts.ready;
      const canvas = await drawDailyImage(s, "/hermosa-logo-transparent.png", font);
      const blob = await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error("image"))), "image/png"));
      const file = new File([blob], `hermosa-daily-sales-${day}.png`, { type: "image/png" });
      const text = dailyShareText(day, branches, dates, cellOf);
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `Daily sales ${s.dateShort}` });
          setNote("Shared.");
        } catch (e) {
          if ((e as Error).name !== "AbortError") throw e;
        }
      } else {
        // Computers: download the image and copy the text, then paste both in the management chat.
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: the image is enough */ }
        setNote("Image downloaded. Attach it in the management chat on Messenger.");
      }
    } catch {
      setNote("Couldn't make the image. Try again.");
    }
    setBusy(false);
  }

  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return (
    <span className="share-day">
      <select aria-label="Day to send" value={day} onChange={(e) => setDay(e.target.value)}>
        {dates.filter((d) => d <= today).slice().reverse().map((d) => <option key={d} value={d}>{label(d)}</option>)}
      </select>
      <button type="button" className="small" onClick={send} disabled={busy}>{busy ? "Making image…" : "Send to Management Chat"}</button>
      {note && <span className="small muted">{note}</span>}
    </span>
  );
}
