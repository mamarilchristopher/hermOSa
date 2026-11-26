import { KIND_TEXT, lineName, php, recordDate, recordRef, visitTotal, type ServiceRecord } from "./serviceRecord";

/** Draws a service record on a 1080-wide canvas in the Ivory Soft theme (browser only). */
export async function drawServiceRecord(r: ServiceRecord, logoSrc: string, font: string): Promise<HTMLCanvasElement> {
  const W = 1080, M = 64;
  const rows: [string, string][] = [
    ["Client", r.client], ["Date of service", recordDate(r.date)], ["Branch", r.branch],
    ["Service", lineName(r)], ["Payment", r.kind === "PAID" ? php(r.amount) : KIND_TEXT[r.kind] ?? r.kind],
    ...(r.priceNote ? [["Price note", r.priceNote] as [string, string]] : []),
    ...(r.doneBy ? [["Done by", r.doneBy] as [string, string]] : []),
    ...(r.assistedBy ? [["Assisted by", r.assistedBy] as [string, string]] : []),
    ["Status", r.status], ["Entered by", `${r.enteredBy} · ${r.enteredAt}`],
  ];
  const showVisit = r.visit.length > 1;
  const rowH = 92, visitH = showVisit ? 120 + r.visit.length * 64 + 80 : 0;
  const H = 220 + 60 + rows.length * rowH + 40 + visitH + 110;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const ink = "#2f241d", muted = "#8a776b", gold = "#b8914a", sand = "#f6eedf", line = "#eadcc2";
  const F = (w: number, s: number) => `${w} ${s}px ${font}`;
  const fit = (t: string, w: number, s: number, wt = 700) => { let z = s; g.font = F(wt, z); while (g.measureText(t).width > w && z > 18) { z -= 2; g.font = F(wt, z); } return z; };
  const rr = (x: number, y: number, w: number, h: number, rad: number, fill: string, shadow = false) => {
    g.save(); if (shadow) { g.shadowColor = "rgba(115,82,64,0.16)"; g.shadowBlur = 48; g.shadowOffsetY = 18; }
    g.beginPath(); g.roundRect(x, y, w, h, rad); g.fillStyle = fill; g.fill(); g.restore();
  };
  g.fillStyle = "#faf7f2"; g.fillRect(0, 0, W, H);
  g.fillStyle = sand; g.fillRect(0, 0, W, 260); g.fillStyle = line; g.fillRect(0, 260, W, 2);
  const logo = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = logoSrc; });
  const lw = 320, lh = (logo.height / logo.width) * lw;
  g.drawImage(logo, M, 130 - lh / 2, lw, lh);
  g.textAlign = "right";
  g.fillStyle = gold; g.font = F(700, 24); g.letterSpacing = "3px"; g.fillText("SERVICE RECORD", W - M, 112); g.letterSpacing = "0px";
  g.fillStyle = ink; g.font = F(800, 40); g.fillText(recordRef(r.id), W - M, 166);
  g.textAlign = "left";

  const cy = 220, ch = rows.length * rowH + 60;
  rr(M, cy, W - 2 * M, ch, 40, "#fff", true);
  rows.forEach(([k, v], i) => {
    const y = cy + 30 + i * rowH;
    if (i) { g.fillStyle = line; g.fillRect(M + 48, y, W - 2 * M - 96, 2); }
    g.fillStyle = muted; g.font = F(600, 26); g.fillText(k, M + 48, y + 56);
    g.fillStyle = ink; g.textAlign = "right"; g.font = F(k === "Payment" ? 800 : 700, fit(v, W - 2 * M - 400, k === "Payment" ? 36 : 30, k === "Payment" ? 800 : 700));
    g.fillText(v, W - M - 48, y + 58); g.textAlign = "left";
  });

  let y = cy + ch + 40;
  if (showVisit) {
    rr(M, y, W - 2 * M, visitH - 30, 36, "#fff", true);
    g.fillStyle = gold; g.font = F(700, 22); g.letterSpacing = "3px"; g.fillText("THIS VISIT", M + 48, y + 64); g.letterSpacing = "0px";
    r.visit.forEach((l, i) => {
      const ly = y + 120 + i * 64;
      g.fillStyle = ink; g.font = F(600, fit(lineName(l), W - 2 * M - 380, 28, 600)); g.fillText(lineName(l), M + 48, ly);
      g.textAlign = "right"; g.font = F(700, 28); g.fillText(l.kind === "PAID" ? php(l.amount) : KIND_TEXT[l.kind] ?? l.kind, W - M - 48, ly); g.textAlign = "left";
    });
    const ty = y + 120 + r.visit.length * 64 - 10;
    g.fillStyle = line; g.fillRect(M + 48, ty - 20, W - 2 * M - 96, 2);
    g.fillStyle = ink; g.font = F(800, 30); g.fillText("Total paid", M + 48, ty + 28);
    g.textAlign = "right"; g.fillText(php(visitTotal(r)), W - M - 48, ty + 28); g.textAlign = "left";
    y += visitH;
  }
  g.fillStyle = muted; g.font = F(600, 22); g.textAlign = "center";
  g.fillText("Hermosa Aesthetics · Hermosa OS service log", W / 2, H - 56);
  return c;
}
