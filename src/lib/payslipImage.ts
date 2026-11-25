import { peso, periodLabel, shortDate, ROLE_TEXT, type Payslip } from "./payroll";

/**
 * Draws a payslip as an A4 page (1240 x 1754 px) laid out like the paper slip: PAY SLIP band, earnings, deductions,
 * net pay, then the commission breakdown. Browser only. Used for "Save as photo" (PNG) and the PDF.
 */
export async function drawPayslip(p: Payslip, logoSrc: string, font: string): Promise<HTMLCanvasElement> {
  const W = 1240, H = 1754, M = 90, tw = W - 2 * M;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const F = (w: number, size: number) => `${w} ${size}px ${font}`;
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  let y = M;

  try {
    const logo = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = logoSrc; });
    g.drawImage(logo, M, y - 10, 280, (logo.height / logo.width) * 280);
  } catch { /* complete without the logo */ }
  y += 120;
  g.fillStyle = "#f3d978"; g.fillRect(M, y, tw, 70);
  g.fillStyle = "#000"; g.font = F(800, 40); g.textAlign = "center"; g.fillText("PAY SLIP", W / 2, y + 50); g.textAlign = "left";
  y += 120;

  const field = (label: string, value: string, x: number) => { g.font = F(800, 22); g.fillText(label, x, y); g.font = F(500, 22); g.fillText(value, x + 150, y); };
  field("No.", p.slip_no, M); field("Period", periodLabel(p.period_start), M + tw / 2); y += 42;
  field("Employee", p.name + (p.uid ? ` (${p.uid})` : ""), M); field("Position", p.position ?? "", M + tw / 2); y += 42;
  field("Rate", `${peso(p.rate_cents)} ${p.basis === "MONTHLY" ? "a month" : "a day"}`, M); y += 30;
  g.fillRect(M, y, tw, 2); y += 46;

  const line = (label: string, amount: string, bold = false, indent = 0) => {
    g.font = F(bold ? 800 : 400, 23);
    let t = label;
    while (g.measureText(t).width > tw - 260 - indent && t.length > 4) t = t.slice(0, -2);
    g.fillText(t === label ? t : `${t}…`, M + 10 + indent, y);
    g.textAlign = "right"; g.fillText(amount, W - M - 10, y); g.textAlign = "left";
    y += 38;
  };
  const heading = (t: string) => { g.font = F(800, 24); g.fillText(t.toUpperCase(), M, y); y += 12; g.fillRect(M, y, tw, 1); y += 34; };

  heading("Earnings");
  for (const l of p.earnings) line(l.label, peso(l.amount), false, 20);
  line("Total salary", peso(p.gross_cents), true);
  y += 16;
  heading("Less deductions");
  if (p.deductions.length === 0) line("None", peso(0), false, 20);
  for (const l of p.deductions) line(l.label, peso(l.amount), false, 20);
  line("Total deductions", peso(p.deductions_cents), true);
  y += 10;
  g.fillStyle = "#f3d978"; g.fillRect(M, y - 4, tw, 62); g.fillStyle = "#000";
  y += 40; line("NET SALARY", peso(p.net_cents), true); y += 24;

  if (p.commissions.length > 0) {
    heading(`Commission details (${p.commissions.length})`);
    const cols: [string, number][] = [["Date", 0], ["Service", 0.14], ["Role", 0.56], ["Paid", 0.68], ["Commission", 0.86]];
    g.font = F(800, 20); cols.forEach(([t, f]) => g.fillText(t, M + 10 + f * tw, y)); y += 32;
    const room = Math.floor((H - 260 - y) / 30);
    for (const it of p.commissions.slice(0, room)) {
      g.font = F(400, 20);
      const svc = it.service.length > 34 ? `${it.service.slice(0, 33)}…` : it.service;
      [shortDate(it.date), svc, ROLE_TEXT[it.role] ?? it.role, peso(it.paid), peso(it.amount)].forEach((v, i) => g.fillText(v, M + 10 + cols[i][1] * tw, y));
      y += 30;
    }
    if (p.commissions.length > room) { g.font = F(400, 19); g.fillText(`…and ${p.commissions.length - room} more in Hermosa OS.`, M + 10, y); y += 30; }
  }

  g.font = F(400, 18); g.fillStyle = "#333";
  const foot = "Full details of your pay for this covered period are given above. Please check carefully and any questions concerning the accuracy of this statement should be taken up with the office.";
  let fy = H - 150, ln = "";
  for (const w of foot.split(" ")) { const t = ln ? `${ln} ${w}` : w; if (g.measureText(t).width > tw && ln) { g.fillText(ln, M, fy); fy += 26; ln = w; } else ln = t; }
  if (ln) g.fillText(ln, M, fy);
  g.font = F(400, 16); g.fillStyle = "#666";
  g.fillText(`Hermosa Aesthetics · Hermosa OS · ${p.slip_no}${p.state === "DRAFT" ? " · DRAFT, not final" : ""}`, M, H - 50);
  return c;
}
