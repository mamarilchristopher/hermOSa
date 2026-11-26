// Service order in every service list (CHRIS, Nov 26): his price-list order, best sellers first.
// Services not on this list (added later) come after, A to Z.
const ORDER = [
  "TEST Service", // staff phone test, Nov 26 (CHRIS will delete it later)
  "Hiko Deluxe", "Hiko Pro", "Ultra Max Hiko", "Diamond Tip (No Alartox)", "Diamond Tip (with Alartox)", "Additional per Thread",
  "Alar Botox", "Fox Eye", "Hexalift", "Ultra VLift", "Barbie Arms Trio",
  "Additional Mono Thread (20pcs)", "Additional Mono Thread (30pcs)", "Additional Mono Thread (50pcs)", "Fillers", "Signature facial",
  "Diamond Peel", "Acne Control", "Glass Skin Hydrafacial", "Carbon Laser Face", "Acne Control + PDT", "Acne Control + PDT + Kanolone",
  "Kanolone", "Hifu Face and Neck", "Hifu Arms", "Hifu Tummy", "Hifu Back Fat", "Microshading", "Lip Blushing", "BB Glow",
  "BB Glow with BB Blush", "Warts Removal Face", "Warts Removal Face and Neck", "Warts Removal Whole Body", "Skin tag Face",
  "Skin Tag Face and Neck", "Skin Tag Whole Body", "VContour", "Mesolipo Arms/Tummy/Love Handle/ Backfat", "Mesolipo (Double Dose)", "Sweatox", "Jawtox",
  "Barbie Shoulder", "RF Face Single Session", "RF Body Single Session", "Face Botox Package",
  "Botox: Forehead/Crowsfeet/Frownline/Nasal Fold (PER UNIT)", "Botox: Undereye (PER UNIT)", "UA Whitening Single session",
  "UA Carbon Laser", "Lemon Bottle Face Single Session", "Lemon Bottle Arms/Love Handle/Backfat/Love Handle Single Session", "Lemon Bottle (Double Dose)",
  "Lux Queen Single Session", "Lux Queen 10+3", "Lux Queen 5+1", "Illumina Single Session", "Illumina 10+3", "Illumina 5+1",
  "Brilliant Single Session", "Brilliant 10+3", "Brilliant 5+1", "L-Carnitine",
  "Diode Upper Lip (Male)", "Diode Upper Lip (Female)", "Diode Lower Lip (Male)", "Diode Lower Lip (Female)", "Diode Full Face",
  "Diode Underarms", "Diode Arms", "Diode Half Leg", "Diode Full Legs", "Diode Bikini Line", "Diode Beard (Male)", "Diode Upper Neck (Male)",
];
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const RANK = new Map(ORDER.map((n, i) => [key(n), i]));

export function sortServices<T extends { name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ra = RANK.get(key(a.name)) ?? Infinity, rb = RANK.get(key(b.name)) ?? Infinity;
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });
}

/** The temporary phone-test service (CHRIS, Nov 26). */
export const isTestService = (name: string | null | undefined) => !!name && key(name).startsWith("testservice");
