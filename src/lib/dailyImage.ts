import type { DailySummary } from "./dailyShare";

/**
 * Draws the daily sales image (design B: big day total, a tile per branch) on a 1080 x 1350 canvas.
 * Browser only. `font` is the page's font family so the image matches the app.
 */
export async function drawDailyImage(s: DailySummary, logoSrc: string, font: string): Promise<HTMLCanvasElement> {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const ink = "#2b2019", ink2 = "#5b4a3f", muted = "#8a7a6e", gold = "#b8924a", goldLine = "#e2cfa6", goldSoft = "#f6ecd8", line = "#eee4d7";
  const F = (w: number, size: number) => `${w} ${size}px ${font}`;
  const rr = (x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, lw = 2) => {
    g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill();
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
  };
  const fit = (text: string, w: number, size: number, weight = 800) => {
    let sz = size;
    g.font = F(weight, sz);
    while (g.measureText(text).width > w && sz > 20) { sz -= 2; g.font = F(weight, sz); }
    return sz;
  };

  const bg = g.createLinearGradient(0, 0, W * 0.5, H);
  bg.addColorStop(0, "#fffdf9"); bg.addColorStop(1, "#f7efe3");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // Header: full logo with wordmark, and the date.
  const logo = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = logoSrc; });
  const lw = 360, lh = (logo.height / logo.width) * lw;
  g.globalCompositeOperation = "multiply"; g.drawImage(logo, 64, 70, lw, lh); g.globalCompositeOperation = "source-over";
  g.textAlign = "right"; g.fillStyle = gold; g.font = F(800, 28);
  g.letterSpacing = "4px"; g.fillText("DAILY SALES", W - 64, 122); g.letterSpacing = "0px";
  g.fillStyle = ink; g.font = F(800, 44); g.fillText(s.dateShort, W - 64, 176);
  g.textAlign = "left";

  // Day total.
  rr(64, 262, W - 128, 258, 36, "#fff", goldLine, 3);
  g.fillStyle = muted; g.font = F(700, 30); g.letterSpacing = "3px";
  g.fillText(s.missing ? `DAY TOTAL (${s.missing} BRANCH${s.missing === 1 ? "" : "ES"} NOT IN YET)` : "DAY TOTAL, ALL BRANCHES", 122, 340);
  g.letterSpacing = "0px";
  g.fillStyle = ink; g.font = F(800, fit(s.dayTotal, W - 250, 110)); g.fillText(s.dayTotal, 122, 455);

  // Branch tiles, 2 x 2 in the owner's branch order.
  const tw = (W - 128 - 28) / 2, th = 208;
  s.branches.slice(0, 4).forEach((b, i) => {
    const x = 64 + (i % 2) * (tw + 28), y = 562 + Math.floor(i / 2) * (th + 30);
    rr(x, y, tw, th, 30, "#fff", line);
    g.fillStyle = ink2; g.font = F(700, fit(b.name, tw - 84, 30, 700)); g.fillText(b.name, x + 42, y + 68);
    const money = b.cents != null;
    g.fillStyle = money ? ink : muted;
    g.font = F(800, money ? fit(b.value, tw - 84, 58) : 44); g.fillText(b.value, x + 42, y + 150);
  });

  // Month to date and daily average.
  const fy = 562 + 2 * (th + 30);
  [["", `${s.monthLong} to date`, s.monthToDate], ["", "Daily average", s.dailyAverage]].forEach(([, label, value], i) => {
    const x = 64 + i * (tw + 28);
    rr(x, fy, tw, 164, 30, goldSoft, goldLine);
    g.fillStyle = ink2; g.font = F(700, 28); g.fillText(label, x + 42, fy + 60);
    g.fillStyle = ink; g.font = F(800, fit(value, tw - 84, 48)); g.fillText(value, x + 42, fy + 122);
  });

  g.fillStyle = muted; g.font = F(600, 22); g.textAlign = "center";
  g.fillText("Hermosa OS · declared sales (cash and online)", W / 2, H - 56);
  return c;
}
