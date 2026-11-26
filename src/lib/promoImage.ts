/**
 * Promo images drawn in the browser (update-0086): a story (1080x1920) and a feed post (1080x1350).
 * Brand (hard rules): official logo with the wordmark untouched, satin ivory with a gold band, never a brown background,
 * and never a "regular price": only the promo price, the session count and the price per session.
 */
import { BRANCH_LINE, mechanic, peso, sessionsOf, type PromoItem } from "./promoRules";

export type PromoArt = { title: string; tagline: string; items: PromoItem[]; price: number; months: number; endsOn?: string | null; photo: string };
export type Fonts = { sans: string; serif: string };

const INK = "#2f241d", INK2 = "#5b4a3f", GOLD = "#b8914a", GOLD_DARK = "#9a7536", IVORY = "#fbf8f4";

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function load(src: string) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; }));
  }
  return imgCache.get(src)!;
}

/** Draw an image to fill the box, cropped around a focus point (fx, fy from 0 to 1). */
function cover(g: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, fx = 0.5, fy = 0.35) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s, sh = h / s;
  const sx = Math.min(img.width - sw, Math.max(0, img.width * fx - sw / 2));
  const sy = Math.min(img.height - sh, Math.max(0, img.height * fy - sh / 2));
  g.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const t = line ? `${line} ${word}` : word;
    if (g.measureText(t).width > max && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

/** Largest font size (from max down) that fits the text in at most `lines` lines. */
function fitSize(g: CanvasRenderingContext2D, font: (s: number) => string, text: string, width: number, lines: number, max: number, min: number) {
  for (let s = max; s > min; s -= 2) { g.font = font(s); if (wrap(g, text, width).length <= lines) return s; }
  return min;
}

function satin(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const bg = g.createLinearGradient(x, y, x + w, y + h);
  bg.addColorStop(0, "#fdfaf5"); bg.addColorStop(0.45, "#f6eee2"); bg.addColorStop(0.7, "#fbf6ee"); bg.addColorStop(1, "#f1e6d4");
  g.fillStyle = bg; g.fillRect(x, y, w, h);
  // soft satin sheen
  const sh = g.createLinearGradient(x, y + h, x + w, y);
  sh.addColorStop(0.3, "rgba(255,255,255,0)"); sh.addColorStop(0.5, "rgba(255,255,255,0.55)"); sh.addColorStop(0.7, "rgba(255,255,255,0)");
  g.fillStyle = sh; g.fillRect(x, y, w, h);
}

function goldBand(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const b = g.createLinearGradient(x, y, x + w, y);
  b.addColorStop(0, GOLD_DARK); b.addColorStop(0.35, "#d4b06a"); b.addColorStop(0.6, GOLD); b.addColorStop(1, GOLD_DARK);
  g.fillStyle = b; g.fillRect(x, y, w, h);
  g.fillStyle = "rgba(255,255,255,0.35)"; g.fillRect(x, y + 4, w, 2); g.fillRect(x, y + h - 6, w, 2);
}

function pill(g: CanvasRenderingContext2D, cx: number, y: number, text: string, font: string) {
  g.font = font;
  const w = g.measureText(text).width + 80, h = 72;
  g.fillStyle = INK; g.beginPath(); g.roundRect(cx - w / 2, y, w, h, h / 2); g.fill();
  g.fillStyle = IVORY; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, cx, y + h / 2 + 2);
  g.textBaseline = "alphabetic";
}

const untilText = (endsOn?: string | null) =>
  endsOn ? `Until ${new Date(`${endsOn}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", timeZone: "UTC" })} only` : "Limited slots";

function itemLines(items: PromoItem[]) {
  return items.map((i) => `${i.paid + i.free} × ${i.name}`);
}

export async function drawPromo(kind: "story" | "feed", a: PromoArt, f: Fonts): Promise<HTMLCanvasElement> {
  const W = 1080, H = kind === "story" ? 1920 : 1350;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const [photo, logo] = await Promise.all([load(a.photo), load("/hermosa-logo-transparent.png")]);
  const S = (w: number, s: number) => `${w} ${s}px ${f.sans}`;
  const R = (w: number, s: number) => `${w} ${s}px ${f.serif}`;
  const n = sessionsOf(a.items);
  const per = `${peso(Math.round(a.price / Math.max(1, n)))} per session`;
  const single = a.items.length === 1;
  satin(g, 0, 0, W, H);

  if (kind === "story") {
    // Laid out from the bottom up so nothing overlaps: footer, button, price, (program list), gold band, title; the photo gets the rest.
    const ts = fitSize(g, (sz) => R(700, sz), a.title, W - 160, 2, 96, 56);
    g.font = R(700, ts); const titleLines = wrap(g, a.title, W - 160);
    g.font = S(500, 36); const tagLines = a.tagline ? wrap(g, a.tagline, W - 200).slice(0, 2) : [];
    const list = single ? [] : itemLines(a.items).slice(0, 5);
    const priceBase = H - 330, priceTop = priceBase - 100;
    const listTop = priceTop - 40 - list.length * 44;
    const bandTop = (list.length ? listTop - 30 : priceTop - 50) - 140;
    const textH = titleLines.length * ts * 1.08 + tagLines.length * 46;
    const textTop = bandTop - 70 - textH;
    const PH = Math.min(1060, textTop - 40);
    if (photo) cover(g, photo, 0, 0, W, PH, 0.5, 0.3);
    const fade = g.createLinearGradient(0, PH - 240, 0, PH);
    fade.addColorStop(0, "rgba(251,248,244,0)"); fade.addColorStop(1, "rgba(251,248,244,1)");
    g.fillStyle = fade; g.fillRect(0, PH - 240, W, 242);
    satin(g, 0, PH, W, H - PH);
    if (logo) { const lw = 300, lh = (logo.height / logo.width) * lw; g.drawImage(logo, (W - lw) / 2, PH - lh + 20, lw, lh); }
    g.textAlign = "center"; g.fillStyle = INK; g.font = R(700, ts);
    let y = textTop + ts * 0.85;
    for (const l of titleLines) { g.fillText(l, W / 2, y); y += ts * 1.08; }
    g.font = S(500, 36); g.fillStyle = INK2;
    for (const l of tagLines) { g.fillText(l, W / 2, y - ts * 0.1 + 10); y += 46; }
    goldBand(g, 0, bandTop, W, 140);
    g.fillStyle = "#fff";
    const band = single ? `${mechanic(a.items)} ${a.items[0].name}` : `${n} sessions · ${a.months} months`;
    const bs = fitSize(g, (sz) => S(800, sz), band.toUpperCase(), W - 120, 1, 62, 34);
    g.font = S(800, bs); g.fillText(band.toUpperCase(), W / 2, bandTop + 70 + bs * 0.36);
    g.font = S(500, 32); g.fillStyle = INK2;
    list.forEach((l, i) => g.fillText(l, W / 2, listTop + 32 + i * 44));
    g.fillStyle = INK; g.font = R(700, 132); g.fillText(peso(a.price), W / 2, priceBase);
    g.font = S(600, 36); g.fillStyle = GOLD_DARK; g.fillText(per, W / 2, priceBase + 62);
    pill(g, W / 2, H - 200, "Message us to book", S(700, 34));
    g.font = S(500, 26); g.fillStyle = INK2; g.fillText(`${untilText(a.endsOn)} · ${BRANCH_LINE}`, W / 2, H - 70);
    return c;
  }

  // Feed: photo on the right, the offer on an ivory panel on the left, the gold band across both.
  const PX = 500;
  if (photo) cover(g, photo, PX, 0, W - PX, H, 0.5, 0.35);
  const edge = g.createLinearGradient(PX, 0, PX + 140, 0);
  edge.addColorStop(0, "rgba(251,248,244,1)"); edge.addColorStop(1, "rgba(251,248,244,0)");
  g.fillStyle = edge; g.fillRect(PX - 1, 0, 141, H);
  const M = 64, TW = 450;
  if (logo) { const lw = 300; g.drawImage(logo, M, 64, lw, (logo.height / logo.width) * lw); }
  let y = 64 + (logo ? (logo.height / logo.width) * 300 : 0) + 110;
  g.textAlign = "left"; g.fillStyle = INK;
  const ts = fitSize(g, (s) => R(700, s), a.title, TW, 3, 84, 50);
  g.font = R(700, ts);
  for (const l of wrap(g, a.title, TW)) { g.fillText(l, M, y); y += ts * 1.08; }
  if (a.tagline) {
    g.font = S(500, 30); g.fillStyle = INK2;
    for (const l of wrap(g, a.tagline, TW - 20).slice(0, 2)) { g.fillText(l, M, y + 4); y += 40; }
  }
  y += 30;
  goldBand(g, 0, y, PX + 160, 120);
  g.fillStyle = "#fff";
  const band = single ? mechanic(a.items) : `${n} sessions`;
  const bs = fitSize(g, (s) => S(800, s), band.toUpperCase(), PX + 60, 1, 64, 34);
  g.font = S(800, bs); g.fillText(band.toUpperCase(), M, y + 60 + bs * 0.36);
  y += 120 + 70;
  g.fillStyle = INK2; g.font = S(600, 30);
  const all = single ? [a.items[0].name] : itemLines(a.items);
  const lines = all.length > 4 ? [...all.slice(0, 3), `+ ${all.length - 3} more`] : all;
  for (const l of lines) { for (const w of wrap(g, l, TW - 20).slice(0, 2)) { g.fillText(w, M, y); y += 38; } }
  y = Math.min(y + 100, H - 230);
  g.fillStyle = INK; g.font = R(700, 112); g.fillText(peso(a.price), M, y);
  g.font = S(600, 32); g.fillStyle = GOLD_DARK; g.fillText(per, M, y + 54);
  g.font = S(500, 24); g.fillStyle = INK2;
  g.fillText(untilText(a.endsOn), M, H - 120);
  g.fillText(BRANCH_LINE, M, H - 82);
  g.font = S(700, 26); g.fillStyle = INK; g.fillText("Message us to book", M, H - 44);
  return c;
}
