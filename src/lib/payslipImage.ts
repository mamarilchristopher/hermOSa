import { peso, periodLabel, shortDate, longDate, maskId, ROLE_TEXT, type Payslip, type PayLine } from "./payroll";

/**
 * Draws a payslip as A4 pages (1240 x 1754 px each), browser only. Used for "Save as photo", "Copy as photo" and the PDF.
 * Page 1: employment details, attendance, earnings and deductions, net pay and signatures (like the paper slip).
 * Page 2 onward: every commission behind the Commission line, with the total on the last page.
 */
const W = 1240, H = 1754, M = 90, TW = W - 2 * M;
const GOLD = "#f3d978", SOFT = "#fbf3d6", INK = "#111", MUTED = "#6b6459", RULE = "#d9d2c3";

type G = CanvasRenderingContext2D;

function newPage(): { c: HTMLCanvasElement; g: G } {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";
  return { c, g };
}

/** Splits text into lines no wider than max. */
function wrap(g: G, text: string, max: number): string[] {
  const out: string[] = []; let ln = "";
  for (const w of text.split(" ")) {
    const t = ln ? `${ln} ${w}` : w;
    if (g.measureText(t).width > max && ln) { out.push(ln); ln = w; } else ln = t;
  }
  if (ln) out.push(ln);
  return out;
}

/** Cuts text to fit max, with an ellipsis. */
function fit(g: G, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 2 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

export async function drawPayslipPages(p: Payslip, logoSrc: string, font: string): Promise<HTMLCanvasElement[]> {
  const F = (w: number, size: number) => `${w} ${size}px ${font}`;
  let logo: HTMLImageElement | null = null;
  try {
    logo = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = logoSrc; });
  } catch { /* draw without the logo */ }

  // Commission pages: how many rows fit on each.
  const ROW = 38, TABLE_TOP = 330, TABLE_BOTTOM = H - 190;
  const perPage = Math.floor((TABLE_BOTTOM - TABLE_TOP - ROW) / ROW) - 1; // header row + total row room
  const commPages: (typeof p.commissions)[] = [];
  for (let i = 0; i < p.commissions.length; i += perPage) commPages.push(p.commissions.slice(i, i + perPage));
  const pages = 1 + commPages.length;
  const draft = p.state === "DRAFT";

  const footer = (g: G, n: number) => {
    g.fillStyle = RULE; g.fillRect(M, H - 82, TW, 1);
    g.font = F(400, 17); g.fillStyle = MUTED; g.textAlign = "left";
    g.fillText(`Hermosa Aesthetics · ${p.slip_no}${draft ? " · DRAFT, not final" : ""}`, M, H - 50);
    g.textAlign = "right"; g.fillText(`Page ${n} of ${pages}`, W - M, H - 50); g.textAlign = "left";
  };
  const watermark = (g: G) => {
    if (!draft) return;
    g.save(); g.translate(W / 2, H / 2); g.rotate(-Math.PI / 6);
    g.font = F(800, 190); g.fillStyle = "rgba(0,0,0,0.045)"; g.textAlign = "center"; g.fillText("DRAFT", 0, 60);
    g.restore(); g.textAlign = "left";
  };

  // ---------- Page 1 ----------
  const { c, g } = newPage();
  watermark(g);
  let y = M - 20;
  if (logo) g.drawImage(logo, M, y, 300, (logo.height / logo.width) * 300);
  // Right side of the header: slip number and period.
  g.textAlign = "right"; g.fillStyle = INK;
  g.font = F(800, 26); g.fillText(p.slip_no, W - M, y + 44);
  g.font = F(500, 21); g.fillStyle = MUTED; g.fillText(`Pay period ${periodLabel(p.period_start)}`, W - M, y + 78);
  g.fillText(draft ? "Draft, not final" : "Final", W - M, y + 108);
  g.textAlign = "left"; g.fillStyle = INK;
  y += 150;
  g.fillStyle = GOLD; g.fillRect(M, y, TW, 70);
  g.fillStyle = INK; g.font = F(800, 40); g.textAlign = "center"; g.fillText("PAY SLIP", W / 2, y + 50); g.textAlign = "left";
  y += 112;

  const section = (t: string) => {
    g.font = F(800, 22); g.fillStyle = INK; g.fillText(t.toUpperCase(), M, y); y += 14;
    g.fillStyle = INK; g.fillRect(M, y, TW, 2); y += 38;
  };

  // Employment details: two columns of label / value.
  section("Employee details");
  const half = TW / 2, LW = 175;
  const pair = (label: string, value: string, x: number, yy: number) => {
    g.font = F(500, 20); g.fillStyle = MUTED; g.fillText(label, x, yy);
    g.font = F(600, 22); g.fillStyle = INK; g.fillText(fit(g, value || "—", half - LW - 20), x + LW, yy);
  };
  const left: [string, string][] = [
    ["Employee", p.name], ["Employee ID", p.uid ?? "—"], ["Position", p.position ?? "—"], ["Branch", p.branch ?? "—"], ["Date hired", longDate(p.hire_date)],
  ];
  const right: [string, string][] = [
    ["Payslip no.", p.slip_no], ["Pay period", periodLabel(p.period_start)],
    ["Pay basis", `${peso(p.rate_cents)} ${p.basis === "MONTHLY" ? "a month" : "a day"}`],
    ["Daily rate", p.attendance.daily_rate ? peso(p.attendance.daily_rate) : "—"], ["Paid by", "Cash"],
  ];
  left.forEach(([l, v], i) => pair(l, v, M, y + i * 40));
  right.forEach(([l, v], i) => pair(l, v, M + half + 10, y + i * 40));
  y += 5 * 40 + 6;
  // Government numbers (last 4 digits only).
  g.fillStyle = SOFT; g.fillRect(M, y - 6, TW, 70);
  const gov: [string, string][] = [["TIN", maskId(p.gov?.tin)], ["SSS", maskId(p.gov?.sss)], ["PhilHealth", maskId(p.gov?.philhealth)], ["Pag-IBIG", maskId(p.gov?.pagibig)]];
  gov.forEach(([l, v], i) => {
    const x = M + 20 + (i * (TW - 40)) / 4;
    g.font = F(500, 17); g.fillStyle = MUTED; g.fillText(l, x, y + 22);
    g.font = F(600, 21); g.fillStyle = INK; g.fillText(v, x, y + 52);
  });
  y += 112;

  // Attendance boxes.
  section("Attendance this cutoff");
  const a = p.attendance;
  const boxes: [string, string][] = [
    ["Days worked", String(a.worked ?? 0)], ["Paid leave", String(a.paid_leave ?? 0)], ["Unpaid leave", String(a.unpaid_leave ?? 0)],
    ["Absences", String(a.absent ?? 0)], ["Late (min)", String(a.late_min ?? 0)],
  ];
  const bw = (TW - 4 * 16) / 5;
  boxes.forEach(([l, v], i) => {
    const x = M + i * (bw + 16);
    g.strokeStyle = RULE; g.lineWidth = 2; g.strokeRect(x, y - 10, bw, 92);
    g.textAlign = "center";
    g.font = F(800, 34); g.fillStyle = INK; g.fillText(v, x + bw / 2, y + 34);
    g.font = F(500, 18); g.fillStyle = MUTED; g.fillText(l, x + bw / 2, y + 66);
    g.textAlign = "left";
  });
  y += 136;

  // Earnings and deductions side by side.
  const colW = (TW - 40) / 2;
  const column = (x: number, title: string, lines: PayLine[], totalLabel: string, total: number, note?: string) => {
    let yy = y;
    g.font = F(800, 22); g.fillStyle = INK; g.fillText(title.toUpperCase(), x, yy); yy += 14;
    g.fillRect(x, yy, colW, 2); yy += 38;
    const list = lines.length ? lines : [{ label: "None", amount: 0 }];
    for (const l of list) {
      g.font = F(400, 21);
      const rows = wrap(g, l.label, colW - 190);
      rows.forEach((r, i) => { g.fillStyle = INK; g.fillText(r, x + 8, yy + i * 28); });
      g.textAlign = "right"; g.fillText(peso(l.amount), x + colW - 8, yy); g.textAlign = "left";
      yy += rows.length * 28 + 10;
    }
    if (note) { g.font = F(400, 17); g.fillStyle = MUTED; g.fillText(note, x + 8, yy - 4); yy += 26; }
    return { yy, draw: (ty: number) => {
      g.fillStyle = RULE; g.fillRect(x, ty - 30, colW, 1);
      g.font = F(800, 22); g.fillStyle = INK; g.fillText(totalLabel, x + 8, ty);
      g.textAlign = "right"; g.fillText(peso(total), x + colW - 8, ty); g.textAlign = "left";
    } };
  };
  const commNote = p.commissions.length ? `Commission details: page${commPages.length > 1 ? `s 2–${pages}` : " 2"}` : undefined;
  const e = column(M, "Earnings", p.earnings, "Total salary", p.gross_cents, commNote);
  const d = column(M + colW + 40, "Less deductions", p.deductions, "Total deductions", p.deductions_cents);
  const ty = Math.max(e.yy, d.yy) + 26;
  e.draw(ty); d.draw(ty);
  y = ty + 40;

  // Net pay band.
  g.fillStyle = GOLD; g.fillRect(M, y, TW, 84);
  g.fillStyle = INK; g.font = F(800, 28); g.fillText("NET SALARY", M + 24, y + 54);
  g.font = F(800, 38); g.textAlign = "right"; g.fillText(peso(p.net_cents), W - M - 24, y + 56); g.textAlign = "left";
  y += 84;

  // Signatures and the paper slip's note, kept above the footer.
  const sigY = H - 300;
  const sw = (TW - 2 * 50) / 3;
  ["Prepared by", "Approved by", "Received by (signature and date)"].forEach((l, i) => {
    const x = M + i * (sw + 50);
    g.fillStyle = INK; g.fillRect(x, sigY, sw, 2);
    g.font = F(500, 18); g.fillStyle = MUTED; g.fillText(l, x, sigY + 28);
  });
  g.font = F(400, 17); g.fillStyle = "#333";
  const foot = "Full details of your pay for this covered period are given above. Please check carefully and any questions concerning the accuracy of this statement should be taken up with the office.";
  wrap(g, foot, TW).forEach((ln, i) => g.fillText(ln, M, H - 170 + i * 25));
  footer(g, 1);
  const out = [c];

  // ---------- Commission pages ----------
  const cols: { t: string; x: number; right?: boolean }[] = [
    { t: "#", x: 0 }, { t: "Date", x: 0.06 }, { t: "Service", x: 0.16 }, { t: "Role", x: 0.58 },
    { t: "Amount paid", x: 0.83, right: true }, { t: "Commission", x: 1, right: true },
  ];
  let n = 0;
  commPages.forEach((rows, k) => {
    const { c, g } = newPage();
    watermark(g);
    let y = M - 20;
    if (logo) g.drawImage(logo, M, y, 220, (logo.height / logo.width) * 220);
    g.textAlign = "right"; g.fillStyle = INK; g.font = F(800, 24); g.fillText(p.slip_no, W - M, y + 34);
    g.font = F(500, 20); g.fillStyle = MUTED;
    g.fillText(`${p.name}${p.uid ? ` (${p.uid})` : ""}`, W - M, y + 66);
    g.fillText(`Pay period ${periodLabel(p.period_start)}`, W - M, y + 94);
    g.textAlign = "left";
    y += 140;
    g.fillStyle = GOLD; g.fillRect(M, y, TW, 60);
    g.fillStyle = INK; g.font = F(800, 30); g.textAlign = "center";
    g.fillText(`COMMISSION DETAILS${commPages.length > 1 ? ` (${k + 1} of ${commPages.length})` : ""}`, W / 2, y + 41); g.textAlign = "left";
    y = TABLE_TOP;
    g.font = F(800, 19); g.fillStyle = INK;
    const cell = (t: string, col: { x: number; right?: boolean }, yy: number) => {
      const x = M + 10 + col.x * (TW - 20);
      if (col.right) { g.textAlign = "right"; g.fillText(t, x, yy); g.textAlign = "left"; } else g.fillText(t, x, yy);
    };
    cols.forEach((col) => cell(col.t, col, y));
    y += 12; g.fillRect(M, y, TW, 2); y += ROW - 6;
    rows.forEach((it, i) => {
      n += 1;
      if (i % 2 === 1) { g.fillStyle = SOFT; g.fillRect(M, y - 26, TW, ROW); }
      g.fillStyle = INK; g.font = F(400, 19);
      cell(String(n), cols[0], y);
      cell(shortDate(it.date), cols[1], y);
      cell(fit(g, it.service, (cols[3].x - cols[2].x) * (TW - 20) - 16), cols[2], y);
      cell(ROLE_TEXT[it.role] ?? it.role, cols[3], y);
      cell(peso(it.paid), cols[4], y);
      cell(peso(it.amount), cols[5], y);
      y += ROW;
    });
    if (k === commPages.length - 1) {
      const total = p.commissions.reduce((s, it) => s + Number(it.amount), 0);
      g.fillStyle = INK; g.fillRect(M, y - 22, TW, 2); y += 16;
      g.font = F(800, 21);
      g.fillText(`Total commission (${p.commissions.length})`, M + 10, y);
      g.textAlign = "right"; g.fillText(peso(total), W - M - 10, y); g.textAlign = "left";
    } else {
      g.font = F(400, 18); g.fillStyle = MUTED; g.fillText("Continued on the next page.", M + 10, y + 6);
    }
    footer(g, k + 2);
    out.push(c);
  });
  return out;
}
