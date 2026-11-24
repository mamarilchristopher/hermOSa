import type { DailySummary } from "./dailyShare";

/**
 * Draws the daily sales image on a 1080 x 1350 canvas in the app's Ivory Soft theme:
 * ivory page, a warm sand header band with the transparent logo, a white day total card, and soft tiles.
 * Browser only. `font` is the page's font family so the image matches the app.
 */
export async function drawDailyImage(s: DailySummary, logoSrc: string, font: string): Promise<HTMLCanvasElement> {
  const W = 1080, H = 1350, M = 64;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const ink = "#2f241d", ink2 = "#5b4a3f", muted = "#8a776b", gold = "#b8914a", sand = "#f6eedf", sandLine = "#eadcc2", tile = "#faf4ea";
  const F = (w: number, size: number) => `${w} ${size}px ${font}`;
  const rr = (x: number, y: number, w: number, h: number, r: number, fill: string, shadow = false) => {
    g.save();
    if (shadow) { g.shadowColor = "rgba(115, 82, 64, 0.16)"; g.shadowBlur = 48; g.shadowOffsetY = 18; }
    g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill();
    g.restore();
  };
  const fit = (text: string, w: number, size: number, weight = 800) => {
    let sz = size;
    g.font = F(weight, sz);
    while (g.measureText(text).width > w && sz > 20) { sz -= 2; g.font = F(weight, sz); }
    return sz;
  };
  const label = (text: string, x: number, y: number, size = 24, color = muted) => {
    g.fillStyle = color; g.font = F(700, size); g.letterSpacing = "3px"; g.fillText(text.toUpperCase(), x, y); g.letterSpacing = "0px";
  };

  // Page and header band.
  g.fillStyle = "#faf7f2"; g.fillRect(0, 0, W, H);
  g.fillStyle = sand; g.fillRect(0, 0, W, 300);
  g.fillStyle = sandLine; g.fillRect(0, 300, W, 2);

  const logo = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = logoSrc; });
  const lw = 340, lh = (logo.height / logo.width) * lw;
  g.drawImage(logo, M, 150 - lh / 2, lw, lh);

  // Date pill on the right of the band.
  g.font = F(800, 40);
  const dw = g.measureText(s.dateShort).width + 72;
  rr(W - M - dw, 132, dw, 84, 42, "#fff", true);
  g.textAlign = "right"; label("Daily sales", W - M - 8, 112, 22, gold);
  g.fillStyle = ink; g.font = F(800, 40); g.fillText(s.dateShort, W - M - 36, 188);
  g.textAlign = "left";

  // Day total card, floating over the band edge.
  rr(M, 250, W - 2 * M, 250, 44, "#fff", true);
  label(s.missing ? `Day total · ${s.missing} branch${s.missing === 1 ? "" : "es"} not in yet` : "Day total, all branches", M + 56, 326, 24, s.missing ? "#8a5a00" : muted);
  g.fillStyle = ink; g.font = F(800, fit(s.dayTotal, W - 2 * M - 112, 116)); g.fillText(s.dayTotal, M + 56, 448);

  // Branch tiles, 2 x 2 in the owner's branch order.
  const gap = 24, tw = (W - 2 * M - gap) / 2, th = 216, ty = 548;
  s.branches.slice(0, 4).forEach((b, i) => {
    const x = M + (i % 2) * (tw + gap), y = ty + Math.floor(i / 2) * (th + gap);
    rr(x, y, tw, th, 32, tile);
    g.fillStyle = gold; g.beginPath(); g.arc(x + 48, y + 64, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink2; g.font = F(700, fit(b.name, tw - 110, 30, 700)); g.fillText(b.name, x + 70, y + 74);
    const money = b.cents != null;
    g.fillStyle = money ? ink : muted;
    g.font = F(800, money ? fit(b.value, tw - 80, 60) : 40); g.fillText(b.value, x + 40, y + 162);
  });

  // Month to date and daily average, in one white card.
  const fy = ty + 2 * (th + gap) + 16, fh = 176;
  rr(M, fy, W - 2 * M, fh, 36, "#fff", true);
  g.fillStyle = sandLine; g.fillRect(W / 2 - 1, fy + 34, 2, fh - 68);
  [[`${s.monthLong} to date`, s.monthToDate], ["Daily average", s.dailyAverage]].forEach(([lab, value], i) => {
    const x = M + 56 + i * (W / 2 - M);
    label(lab, x, fy + 66, 22);
    g.fillStyle = ink; g.font = F(800, fit(value, W / 2 - M - 112, 52)); g.fillText(value, x, fy + 132);
  });

  g.fillStyle = muted; g.font = F(600, 22); g.textAlign = "center";
  g.fillText("Hermosa OS · declared sales (cash and online)", W / 2, H - 52);
  return c;
}
