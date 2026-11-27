/**
 * Promo images drawn in the browser (update-0086): a story (1080x1920) and a feed post (1080x1350).
 * Brand (hard rules): official logo with the wordmark untouched, satin ivory with a gold band, never a brown background,
 * and never a "regular price": only the promo price, the session count and the price per session.
 */
import { adName, BRANCH_LINE, mechanic, peso, sessionsOf, type PromoItem } from "./promoRules";

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
  return items.map((i) => `${i.paid + i.free} × ${adName(i.name)}`);
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
    const band = single ? `${mechanic(a.items)} ${adName(a.items[0].name)}` : `${n} sessions · ${a.months} months`;
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

  // Feed (CHRIS Nov 27, "fix alignment"): the same centered layout as the story, sized for a 4:5 post.
  // Laid out from the bottom up: footer, button, price, (program list), gold band, title; the photo gets the rest.
  const ts = fitSize(g, (sz) => R(700, sz), a.title, W - 160, 2, 84, 52);
  g.font = R(700, ts); const titleLines = wrap(g, a.title, W - 160);
  g.font = S(500, 32); const tagLines = a.tagline ? wrap(g, a.tagline, W - 200).slice(0, 1) : [];
  const all = single ? [] : itemLines(a.items);
  const list = all.length > 3 ? [...all.slice(0, 2), `+ ${all.length - 2} more`] : all;
  const priceBase = H - 236, priceTop = priceBase - 88;
  const listTop = priceTop - 30 - list.length * 40;
  const bandTop = (list.length ? listTop - 22 : priceTop - 40) - 112;
  const textH = titleLines.length * ts * 1.08 + tagLines.length * 42;
  const textTop = bandTop - 44 - textH;
  const PH = Math.max(360, textTop - 40);
  if (photo) cover(g, photo, 0, 0, W, PH, 0.5, PH < 560 ? 0.24 : 0.3); // short photo: keep the whole face in
  const fade = g.createLinearGradient(0, PH - 200, 0, PH);
  fade.addColorStop(0, "rgba(251,248,244,0)"); fade.addColorStop(1, "rgba(251,248,244,1)");
  g.fillStyle = fade; g.fillRect(0, PH - 200, W, 202);
  satin(g, 0, PH, W, H - PH);
  if (logo) { const lw = 260, lh = (logo.height / logo.width) * lw; g.drawImage(logo, (W - lw) / 2, PH - lh + 24, lw, lh); }
  g.textAlign = "center"; g.fillStyle = INK; g.font = R(700, ts);
  let y = textTop + ts * 0.85;
  for (const l of titleLines) { g.fillText(l, W / 2, y); y += ts * 1.08; }
  g.font = S(500, 32); g.fillStyle = INK2;
  for (const l of tagLines) { g.fillText(l, W / 2, y - ts * 0.1 + 8); y += 42; }
  goldBand(g, 0, bandTop, W, 112);
  g.fillStyle = "#fff";
  const band = single ? `${mechanic(a.items)} ${adName(a.items[0].name)}` : `${n} sessions · ${a.months} months`;
  const bs = fitSize(g, (sz) => S(800, sz), band.toUpperCase(), W - 120, 1, 56, 32);
  g.font = S(800, bs); g.fillText(band.toUpperCase(), W / 2, bandTop + 56 + bs * 0.36);
  g.font = S(500, 30); g.fillStyle = INK2;
  list.forEach((l, i) => g.fillText(l, W / 2, listTop + 30 + i * 40));
  g.fillStyle = INK; g.font = R(700, 116); g.fillText(peso(a.price), W / 2, priceBase);
  g.font = S(600, 32); g.fillStyle = GOLD_DARK; g.fillText(per, W / 2, priceBase + 50);
  pill(g, W / 2, H - 148, "Message us to book", S(700, 30));
  g.font = S(500, 24); g.fillStyle = INK2; g.fillText(`${untilText(a.endsOn)} · ${BRANCH_LINE}`, W / 2, H - 34);
  return c;
}

/** The client's schedule as a photo to send on Messenger (update-0087): every visit grouped by month, ticks on the ones done. */
export type ScheduleArt = {
  title: string; client: string; ends: string;
  visits: { d: string; items: { name: string; n: number; of: number; done: boolean }[] }[];
};
export async function drawSchedule(a: ScheduleArt, f: Fonts): Promise<HTMLCanvasElement> {
  const W = 1080, M = 70, colW = (W - M * 2 - 40) / 2, rowH = 44, monthH = 64;
  const S = (w: number, s: number) => `${w} ${s}px ${f.sans}`;
  const R = (w: number, s: number) => `${w} ${s}px ${f.serif}`;
  const months: { label: string; rows: ScheduleArt["visits"] }[] = [];
  for (const v of a.visits) {
    const label = new Date(`${v.d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
    if (months.at(-1)?.label !== label) months.push({ label, rows: [] });
    months.at(-1)!.rows.push(v);
  }
  // Two columns, split at a month so each month stays together.
  // Each visit's text, wrapped to the column; a long visit takes two lines.
  const meas = document.createElement("canvas").getContext("2d")!;
  meas.font = S(500, 26);
  const textOf = (v: ScheduleArt["visits"][number]) => v.items.map((i) => `${i.name} ${i.n}/${i.of}`).join(" + ");
  const linesOf = (v: ScheduleArt["visits"][number]) => wrap(meas, textOf(v), colW - 120).slice(0, 2);
  const rowSize = (v: ScheduleArt["visits"][number]) => rowH + (linesOf(v).length - 1) * 32;
  const size = (m: (typeof months)[number]) => monthH + m.rows.reduce((s, v) => s + rowSize(v), 0);
  const total = months.reduce((s, m) => s + size(m), 0);
  const cols: (typeof months)[] = [[], []];
  let acc = 0;
  for (const m of months) { (m === months[0] || acc + size(m) / 2 <= total / 2 ? cols[0] : cols[1]).push(m); acc += size(m); }
  const colH = Math.max(...cols.map((c) => c.reduce((s, m) => s + size(m), 0)));
  const top = 560, H = Math.max(1350, top + colH + 220);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  satin(g, 0, 0, W, H);
  const logo = await load("/hermosa-logo-transparent.png");
  if (logo) { const lw = 280, lh = (logo.height / logo.width) * lw; g.drawImage(logo, (W - lw) / 2, 50, lw, lh); }
  g.textAlign = "center"; g.fillStyle = INK;
  const ts = fitSize(g, (s) => R(700, s), a.title, W - 160, 1, 76, 44);
  g.font = R(700, ts); g.fillText(a.title, W / 2, 250);
  g.font = S(600, 34); g.fillStyle = INK2; g.fillText("Your recommended schedule", W / 2, 306);
  g.font = S(700, 38); g.fillStyle = INK; g.fillText(a.client, W / 2, 362);
  goldBand(g, 0, 400, W, 96);
  const sessions = a.visits.reduce((s, v) => s + v.items.length, 0);
  const ends = new Date(`${a.ends}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  g.fillStyle = "#fff"; g.font = S(800, 34);
  g.fillText(`${a.visits.length} VISITS · ${sessions} SESSIONS · UNTIL ${ends.toUpperCase()}`, W / 2, 460);
  g.textAlign = "left";
  cols.forEach((col, k) => {
    let y = top, x = M + k * (colW + 40);
    for (const m of col) {
      g.font = R(700, 34); g.fillStyle = GOLD_DARK; g.fillText(m.label, x, y + 40); y += monthH;
      for (const v of m.rows) {
        const day = new Date(`${v.d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", day: "numeric", timeZone: "UTC" });
        const allDone = v.items.every((i) => i.done);
        g.font = S(700, 26); g.fillStyle = allDone ? GOLD : INK; g.fillText(allDone ? `✓ ${day}` : day, x, y + 30);
        g.font = S(500, 26); g.fillStyle = allDone ? "#9a8b80" : INK2;
        linesOf(v).forEach((t, k) => g.fillText(t, x + 120, y + 30 + k * 32));
        y += rowSize(v);
      }
    }
  });
  g.textAlign = "center"; g.font = S(600, 28); g.fillStyle = INK;
  g.fillText("Message us a day before each visit to confirm your slot.", W / 2, H - 120);
  g.font = S(500, 24); g.fillStyle = INK2;
  g.fillText(`You can move a date; just keep the spacing. ${BRANCH_LINE}`, W / 2, H - 76);
  return c;
}
