"use client";
import { useRef, useState } from "react";
import { KIND_TEXT, decidedRow, lineName, php, recordDate, recordRef, visitTotal, type ServiceRecord } from "@/lib/serviceRecord";
import { drawServiceRecord } from "@/lib/serviceRecordImage";

/** CHRIS Nov 26: Details of one service log entry, savable as a photo for the client or management. Open to all staff. */
export function EntryDetails({ r }: { r: ServiceRecord }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    setBusy(true); setNote(null);
    try {
      await document.fonts.ready;
      const canvas = await drawServiceRecord(r, "/hermosa-logo-transparent.png", getComputedStyle(document.body).fontFamily || "sans-serif");
      const blob = await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error("image"))), "image/png"));
      const file = new File([blob], `hermosa-service-${r.date}-${recordRef(r.id)}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `Service record ${recordRef(r.id)}` }); setNote("Shared."); }
        catch (e) { if ((e as Error).name !== "AbortError") throw e; }
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        setNote("Photo saved to your Downloads.");
      }
    } catch {
      setNote("Couldn't make the photo. Try again.");
    }
    setBusy(false);
  }

  const rows: [string, string][] = [
    ["Client", r.client], ["Date of service", recordDate(r.date)], ["Branch", r.branch], ["Service", lineName(r)],
    ["Payment", r.kind === "PAID" || (r.kind === "BACKJOB" && r.amount > 0) ? php(r.amount) + (r.kind === "BACKJOB" ? " (backjob)" : "") : KIND_TEXT[r.kind] ?? r.kind],
    ...((r.kind === "PAID" || r.kind === "BACKJOB") && r.paidTo ? [["Paid to", r.paidTo] as [string, string]] : []),
    ...(r.priceNote ? [["Price note", r.priceNote] as [string, string]] : []),
    ...(r.doneBy ? [["Done by", r.doneBy] as [string, string]] : []),
    ...(r.assistedBy ? [["Assisted by", r.assistedBy] as [string, string]] : []),
    ["Status", r.status], ["Entered by", `${r.enteredBy} · ${r.enteredAt}`], ...decidedRow(r),
  ];
  return (
    <>
      <button type="button" className="secondary small details-btn" onClick={() => { setNote(null); ref.current?.showModal(); }}>Details</button>
      <dialog ref={ref} className="sheet record-sheet">
        <div className="record-head"><span className="small muted">Service record</span><strong>{recordRef(r.id)}</strong></div>
        <dl className="record-list">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {r.visit.length > 1 && (
          <div className="record-visit">
            <span className="small muted">This visit</span>
            {r.visit.map((l, i) => <div key={i}><span>{lineName(l)}</span><span>{l.kind === "PAID" || (l.kind === "BACKJOB" && l.amount > 0) ? php(l.amount) : KIND_TEXT[l.kind] ?? l.kind}</span></div>)}
            <div className="record-total"><span>Total paid</span><span>{php(visitTotal(r))}</span></div>
          </div>
        )}
        <div className="row-buttons" style={{ marginTop: 16 }}>
          <button type="button" onClick={save} disabled={busy}>{busy ? "Making photo…" : "Save as photo"}</button>
          <button type="button" className="secondary" onClick={() => ref.current?.close()}>Close</button>
        </div>
        {note && <p className="small muted" style={{ marginBottom: 0 }}>{note}</p>}
      </dialog>
    </>
  );
}
