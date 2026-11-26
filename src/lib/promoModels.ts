/**
 * Approved AI model photos for promos (CHRIS Nov 24-26: every promo uses the best-fitting APPROVED model).
 * Copied from the Canva masterfile's local set (M-numbers match the masterfile), resized to 1000 px, in public/promo-models/.
 */
export type PromoModel = { m: string; tag: string; w: number; h: number };

export const PROMO_MODELS: PromoModel[] = [
  { m: "M01", tag: "Hiko", w: 800, h: 1000 },
  { m: "M02", tag: "Glow / Gluta", w: 800, h: 1000 },
  { m: "M03", tag: "Ultra V Lift", w: 800, h: 1000 },
  { m: "M04", tag: "Barkada", w: 800, h: 1000 },
  { m: "M05", tag: "Hiko", w: 800, h: 1000 },
  { m: "M06", tag: "Hiko", w: 800, h: 1000 },
  { m: "M07", tag: "Hiko", w: 800, h: 1000 },
  { m: "M08", tag: "Hiko", w: 800, h: 1000 },
  { m: "M09", tag: "Hiko", w: 480, h: 600 },
  { m: "M10", tag: "Hiko", w: 480, h: 600 },
  { m: "M11", tag: "Hiko", w: 480, h: 600 },
  { m: "M12", tag: "Ultra V Lift", w: 480, h: 600 },
  { m: "M13", tag: "Carbon Laser", w: 480, h: 600 },
  { m: "M14", tag: "NovoForm", w: 480, h: 600 },
  { m: "M15", tag: "Hiko", w: 480, h: 600 },
  { m: "M16", tag: "Gluta", w: 480, h: 600 },
  { m: "M17", tag: "Ultra V Lift", w: 480, h: 600 },
  { m: "M18", tag: "Hiko (him)", w: 480, h: 600 },
  { m: "M19", tag: "Hydrafacial", w: 480, h: 600 },
  { m: "M20", tag: "Barbie Arms", w: 480, h: 600 },
  { m: "M21", tag: "Botox", w: 480, h: 600 },
  { m: "M22", tag: "Barkada", w: 480, h: 600 },
  { m: "M23", tag: "Carbon Laser", w: 480, h: 600 },
  { m: "M24", tag: "Slimming", w: 480, h: 600 },
  { m: "M25", tag: "Hiko Ultra Max", w: 480, h: 600 },
  { m: "M26", tag: "Gluta", w: 480, h: 600 },
  { m: "M27", tag: "Hiko", w: 480, h: 600 },
  { m: "M28", tag: "Mother & daughter", w: 480, h: 600 },
  { m: "M29", tag: "Ultra V Lift", w: 480, h: 600 },
  { m: "M30", tag: "NovoForm", w: 480, h: 600 },
  { m: "M31", tag: "Gluta (him)", w: 480, h: 600 },
  { m: "M32", tag: "Acne Control", w: 480, h: 600 },
  { m: "M33", tag: "Underarm", w: 480, h: 600 },
  { m: "M34", tag: "Ultra V Lift (him)", w: 480, h: 600 },
  { m: "M35", tag: "Signature Facial", w: 480, h: 600 },
  { m: "M36", tag: "Hiko (him)", w: 480, h: 600 },
  { m: "M37", tag: "Underarm", w: 480, h: 600 },
  { m: "M38", tag: "Gluta", w: 806, h: 1000 },
  { m: "M39", tag: "Hiko", w: 806, h: 1000 },
  { m: "M40", tag: "Mother & daughter", w: 800, h: 1000 },
  { m: "M41", tag: "Gluta", w: 800, h: 1000 },
  { m: "M42", tag: "Hiko (him)", w: 800, h: 1000 },
  { m: "M43", tag: "Ultra V Lift", w: 800, h: 1000 },
  { m: "M44", tag: "Facial · backup", w: 800, h: 1000 },
  { m: "M45", tag: "Mother & son", w: 800, h: 1000 },
  { m: "M46", tag: "Ultra V Lift", w: 800, h: 1000 },
  { m: "M47", tag: "Signature Facial", w: 800, h: 1000 },
  { m: "M48", tag: "Holiday", w: 800, h: 1000 },
  { m: "M49", tag: "Couple", w: 800, h: 1000 },
  { m: "M50", tag: "Free Consult", w: 800, h: 1000 },
  { m: "M51", tag: "Hiko", w: 800, h: 1000 },
  { m: "M52", tag: "Gluta", w: 800, h: 1000 },
  { m: "M53", tag: "Hiko", w: 800, h: 1000 },
  { m: "M54", tag: "Hiko", w: 800, h: 1000 },
  { m: "M55", tag: "NovoForm", w: 800, h: 1000 },
  { m: "M56", tag: "Carbon Laser", w: 800, h: 1000 },
  { m: "M57", tag: "Hiko", w: 800, h: 1000 },
  { m: "M58", tag: "Hiko", w: 800, h: 1000 },
  { m: "M59", tag: "Hiko", w: 800, h: 1000 },
  { m: "M60", tag: "Ultra V Lift", w: 800, h: 1000 },
  { m: "M61", tag: "Acne Control · backup", w: 800, h: 1000 },
  { m: "M62", tag: "Hiko Ultra Max", w: 800, h: 1000 },
  { m: "M63", tag: "Gluta", w: 800, h: 1000 },
  { m: "M64", tag: "Botox", w: 800, h: 1000 },
  { m: "M65", tag: "Hiko", w: 800, h: 1000 },
  { m: "M66", tag: "Mother & daughter", w: 800, h: 1000 },
  { m: "M67", tag: "Hiko (him)", w: 800, h: 1000 },
];

export const modelSrc = (m: string) => `/promo-models/${m}.jpg`;

// Which model tags fit a service (by words in the service name), best first. Falls back to glow / facial shots.
const FIT: [RegExp, string[]][] = [
  [/ultra ?max/i, ["Hiko Ultra Max", "Hiko"]],
  [/hiko|thread|diamond tip|alar|fox eye|hexalift/i, ["Hiko", "Hiko Ultra Max"]],
  [/v ?lift/i, ["Ultra V Lift"]],
  [/hifu|\brf\b|jawtox|v ?contour|mesolipo|lemon bottle|slim|tummy|back ?fat|love handle/i, ["Slimming", "Ultra V Lift", "Barbie Arms"]],
  [/barbie|arms|shoulder/i, ["Barbie Arms", "Slimming"]],
  [/underarm|\bua\b|sweatox/i, ["Underarm"]],
  [/diode/i, ["Underarm", "Glow / Gluta"]],
  [/gluta|lux queen|illumina|brilliant|drip|l-carnitine/i, ["Gluta", "Glow / Gluta"]],
  [/carbon/i, ["Carbon Laser"]],
  [/acne|kanolone|pdt|peel/i, ["Acne Control", "Acne Control · backup", "Signature Facial"]],
  [/hydra/i, ["Hydrafacial", "Signature Facial"]],
  [/facial|bb glow|glass skin/i, ["Signature Facial", "Hydrafacial", "Facial · backup"]],
  [/botox|filler/i, ["Botox"]],
  [/novoform/i, ["NovoForm", "Slimming"]],
];

/** Models that fit the given service names (and season), best first, then every other model so there's always a choice. */
export function modelsFor(names: string[], season?: string): PromoModel[] {
  const tags: string[] = [];
  if (season && /christmas|holiday|new year/i.test(season)) tags.push("Holiday");
  if (season && /mother/i.test(season)) tags.push("Mother & daughter", "Mother & son");
  if (season && /valentine/i.test(season)) tags.push("Couple");
  if (season && /barkada|graduation/i.test(season)) tags.push("Barkada");
  for (const n of names) for (const [re, t] of FIT) if (re.test(n)) tags.push(...t);
  tags.push("Glow / Gluta", "Signature Facial");
  const seen = new Set<string>();
  const out: PromoModel[] = [];
  for (const t of tags) for (const m of PROMO_MODELS) if (m.tag === t && !seen.has(m.m)) { seen.add(m.m); out.push(m); }
  for (const m of PROMO_MODELS) if (!seen.has(m.m) && !/backup/i.test(m.tag)) { seen.add(m.m); out.push(m); }
  return out;
}
