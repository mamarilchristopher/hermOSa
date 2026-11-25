import type { Ir } from "./incidents";

/**
 * Draws an IR as an A4 page (1240 x 1754 px, 150 dpi) in black and white, for "Save as photo" and the stored PDF.
 * Browser only. `font` is the page's font family so the image matches the app.
 */
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => `${MO[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
const time = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const stamp = (ts: string | null) => ts ? new Date(ts).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }) : "";

export async function drawIrImage(r: Ir, logoSrc: string, font: string): Promise<HTMLCanvasElement> {
  const W = 1240, H = 1754, M = 90;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const F = (w: number, size: number) => `${w} ${size}px ${font}`;
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#000"; g.strokeStyle = "#000";
  let y = M;

  // Wraps text into the given width; returns the y after the last line.
  const para = (text: string, x: number, w: number, size = 24, weight = 400, lh = 1.45) => {
    g.font = F(weight, size);
    for (const block of text.split(/\n/)) {
      let line = "";
      for (const word of block.split(/\s+/)) {
        const test = line ? `${line} ${word}` : word;
        if (g.measureText(test).width > w && line) { g.fillText(line, x, y); y += size * lh; line = word; } else line = test;
      }
      if (line) { g.fillText(line, x, y); y += size * lh; }
    }
  };
  const heading = (t: string) => { y += 18; g.font = F(800, 26); g.fillText(t.toUpperCase(), M, y); y += 14; g.fillRect(M, y, W - 2 * M, 2); y += 38; };
  const blank = (lines = 3) => { for (let i = 0; i < lines; i++) { g.fillRect(M, y + 10, W - 2 * M, 1); y += 44; } };

  // Header: logo, title, IR number.
  try {
    const logo = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = logoSrc; });
    const lw = 300, lh = (logo.height / logo.width) * lw;
    g.filter = "grayscale(1) contrast(1.2)";
    g.drawImage(logo, M, y - 10, lw, lh);
    g.filter = "none";
  } catch { /* the IR is still complete without the logo */ }
  g.textAlign = "right";
  g.font = F(800, 44); g.fillText("INCIDENT REPORT", W - M, y + 36);
  g.font = F(500, 24); g.fillText(`IR no. ${r.ir_no} · Tardiness`, W - M, y + 74);
  g.textAlign = "left";
  y += 130; g.fillRect(M, y, W - 2 * M, 4); y += 50;

  // Fields table.
  const rows: [string, string, string, string][] = [
    ["Employee", r.name, "Position", r.position ?? ""],
    ["Branch", r.branch ?? "", "Date issued", r.issued_at ? day(r.issued_at.slice(0, 10)) : "Not issued yet"],
    ["Covered period", r.basis === "LATE_NTE" ? `${MO[Number(r.period_start.slice(5, 7)) - 1]} ${r.period_start.slice(0, 4)}` : `${day(r.period_start)} to ${day(r.period_end)}`, "Issued by", r.issued_by ?? ""],
  ];
  const cw = (W - 2 * M) / 4;
  for (const row of rows) {
    g.strokeRect(M, y - 34, W - 2 * M, 54);
    row.forEach((t, i) => { g.font = F(i % 2 ? 500 : 800, 22); g.fillText(t.length > 34 ? `${t.slice(0, 33)}…` : t, M + 14 + i * cw, y); });
    y += 54;
  }
  y += 10;

  heading("Incident");
  para(r.basis === "LATE_NTE"
    ? `Late ${r.late_days} time${r.late_days === 1 ? "" : "s"} this month (more than the grace period after the shift start), ${r.late_minutes} minutes in total. A Late NTE was issued for each. Times are from the Hermosa OS time clock.`
    : `Late ${r.late_days} time${r.late_days === 1 ? "" : "s"} in this cutoff, ${r.late_minutes} minutes in total. The limit is ${r.limit_minutes} minutes per cutoff. Times are from the Hermosa OS time clock.`,
    M, W - 2 * M);
  y += 10;

  // Late days table.
  const nte = r.basis === "LATE_NTE";
  const cols = nte ? [["Date", 0], ["NTE no.", 0.2], ["Branch", 0.32], ["Shift start", 0.55], ["Time in", 0.7], ["Min. late", 0.85]] as const
    : [["Date", 0], ["Branch", 0.24], ["Shift start", 0.5], ["Time in", 0.67], ["Min. late", 0.84]] as const;
  const tw = W - 2 * M;
  g.font = F(800, 21);
  cols.forEach(([t, f]) => g.fillText(t, M + 10 + f * tw, y));
  y += 12; g.fillRect(M, y, tw, 2); y += 32;
  for (const d of r.details.slice(0, 14)) {
    g.font = F(400, 21);
    const vals = nte ? [day(d.date), d.nte_no ? `#${d.nte_no}` : "", d.branch ?? "", time(d.start), time(d.time_in), String(d.late_min)]
      : [day(d.date), d.branch ?? "", time(d.start), time(d.time_in), String(d.late_min)];
    vals.forEach((v, i) => g.fillText(v, M + 10 + cols[i][1] * tw, y));
    y += 34;
    if (nte && d.explanation) { g.font = F(400, 19); const x0 = y; para(`NTE explanation: ${d.explanation}`, M + 30, tw - 40, 19, 400, 1.35); y = Math.max(y, x0); }
    g.fillRect(M, y - 22, tw, 1); y += 8;
  }
  if (r.details.length > 14) { para(`…and ${r.details.length - 14} more (see Hermosa OS).`, M, tw, 19); }
  g.font = F(800, 21); g.fillText("Total minutes late", M + 10, y + 4); g.textAlign = "right"; g.fillText(String(r.late_minutes), W - M - 10, y + 4); g.textAlign = "left";
  y += 30;

  if (r.issue_note) { heading("Note from management"); para(r.issue_note, M, tw); }

  heading("Employee acknowledgement and response");
  if (r.acknowledged_at || r.explanation) {
    if (r.acknowledged_at) para(`Acknowledged online by ${r.name} on ${stamp(r.acknowledged_at)}.`, M, tw, 21, 700);
    para(r.explanation ?? "", M, tw);
  } else blank(3);

  heading("Action taken");
  if (r.action_taken) { para(r.action_taken, M, tw); para(`${r.closed_by ?? ""} · ${stamp(r.closed_at)}`, M, tw, 19); } else blank(2);

  // Signatures at the bottom.
  const sy = Math.max(y + 60, H - 190);
  g.fillRect(M, sy, 460, 2); g.fillRect(W - M - 460, sy, 460, 2);
  g.font = F(500, 20);
  g.fillText("Employee signature over printed name", M, sy + 32);
  g.fillText(`Issued by${r.issued_by ? `: ${r.issued_by}` : ""}`, W - M - 460, sy + 32);
  g.font = F(400, 16); g.fillStyle = "#444";
  g.fillText(`Hermosa Aesthetics · Hermosa OS · IR no. ${r.ir_no} · saved ${stamp(new Date().toISOString())}`, M, H - 60);
  return c;
}

/** A one-page A4 PDF holding a JPEG (the drawn IR). Built by hand so no PDF library is needed. */
export function pdfFromJpeg(jpeg: Uint8Array, wPx: number, hPx: number): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; parts.push(u); len += u.length; };
  const obj = (n: number, body: () => void) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };
  const PW = 595.28, PH = 841.89; // A4 in points
  const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); push(jpeg); push("\nendstream"); });
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
