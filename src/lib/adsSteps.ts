/**
 * Delegable ad fixes (v0.99.8, CHRIS Nov 28: "an advisor that can let me delegate these manual setting tasks to someone
 * with basic understanding of ads management"). Every move gets the exact values to type and numbered click-by-click
 * steps in Ads Manager, so a staff member can do it from the card or from the copied text.
 */
import { CLINIC_PIN, type Targeting } from "./adsAdvisor";
import { PLAYBOOK, type Playbook } from "./adsPlaybook";

const SHORT: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };
/** Public clinic addresses (CHRIS, Nov 23 2026), for dropping the map pin. */
export const CLINIC_ADDRESS: Record<string, string> = {
  QC_MAIN: "Regray Square Bldg., 30 Matino St., Sikatuna Village, Diliman, Quezon City",
  FAIRVIEW: "Cristina Bldg., Regalado Ave. cor. Coronet St., West Fairview, Quezon City",
  STA_MARIA: "JSP Building, Kanto Caypombo, Sta. Maria, Bulacan",
  MARIKINA: "GT1 Bldg., B.G. Molina St., Parang, Marikina City",
};
const BRANCH_WORD: [RegExp, string][] = [[/qc main|main qc/i, "QC_MAIN"], [/fairview/i, "FAIRVIEW"], [/sta\.? maria|smb/i, "STA_MARIA"], [/marikina/i, "MARIKINA"]];
export const branchIn = (s: string) => BRANCH_WORD.find(([re]) => re.test(s))?.[1] ?? null;

/** What to type in Ads Manager's "Search locations" box for each clinic (street first, so Meta drops the pin on it). */
export const CLINIC_SEARCH: Record<string, string> = {
  QC_MAIN: "30 Matino Street, Sikatuna Village, Quezon City",
  FAIRVIEW: "Regalado Avenue corner Coronet Street, West Fairview, Quezon City",
  STA_MARIA: "Kanto Caypombo, Santa Maria, Bulacan",
  MARIKINA: "B.G. Molina Street, Parang, Marikina City",
};
/** Location = ONE pin on the clinic + ONE radius (CHRIS Nov 28: "An address of the clinic + the best mile radius";
 *  Meta's bulk add turned town names into 10–25 mi circles and stray places). Best radius: as wide as possible while
 *  stopping at least half a mile short of every other Hermosa clinic, so branches don't serve each other's doorstep.
 *  Sta. Maria has no clinic within 12 mi, so it is capped at 7 mi (the Bulacan towns it serves). */
const RADIUS_CAP: Record<string, number> = { STA_MARIA: 7 };
const toRad = (x: number) => (x * Math.PI) / 180;
const milesBetween = (a: [number, number], b: [number, number]) => {
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
};
const milesIn = (g: string) => { const m = g.match(/(\d+(?:\.\d+)?)\s*mi\b/i); return m ? Number(m[1]) : null; };
/** Ads Manager's radius slider only takes whole miles, so plan values like 3.5 are rounded down. */
const whole = (mi: number) => Math.max(1, Math.floor(mi));
type Area = { branch: string; radius: number };
export type PlanGeo = { radius: number | null; include: Area[]; exclude: Area[] };
/** The location a playbook line sets: clinic addresses with radii ("QC Main clinic address, 10 mi radius") and areas
 *  left out ("Fairview clinic address, 1 mi radius"). The branch's own clinic comes first. */
export function geoOf(line: Playbook["lines"][number], branch: string): PlanGeo {
  const areas = (gs: string[]) => gs.flatMap((g) => { const c = branchIn(g), mi = milesIn(g); return c && mi !== null ? [{ branch: c, radius: mi }] : []; });
  const inc = areas(line.geo.include).sort((x, y) => Number(y.branch === branch) - Number(x.branch === branch));
  const own = inc.find((x) => x.branch === branch) ?? inc[0];
  return { radius: own ? own.radius : null, include: inc.map((x) => ({ ...x, radius: whole(x.radius) })), exclude: areas(line.geo.exclude).filter((x) => x.branch !== branch).map((x) => ({ ...x, radius: whole(x.radius) })) };
}
/** The plan's location for a branch's live service line. Reach is per service (CHRIS Nov 28: Hiko clients travel from
 *  Makati to QC Main; Gluta repeat sessions need a clinic close by), so that service's line wins; without one, the
 *  branch's first line. Proposed lines don't count until they launch. The plan is the one source. */
export function planGeo(branch: string, service?: string | null, pb: Playbook = PLAYBOOK): PlanGeo {
  const mine = pb.lines.filter((l) => l.branch === branch && l.status !== "proposed");
  const line = (service ? mine.find((l) => l.service === service) : null) ?? mine[0];
  return line ? geoOf(line, branch) : { radius: null, include: [], exclude: [] };
}
/** The radius the ads plan sets (as written, may be a half mile). */
export const planRadius = (branch: string, service?: string | null, pb: Playbook = PLAYBOOK) => planGeo(branch, service, pb).radius;
/** Plan radius first (whole miles); if the plan has none, the widest whole mile that stops half a mile short of every
 *  other clinic. */
export function bestRadius(branch: string, service?: string | null): number {
  const planned = planRadius(branch, service);
  if (planned) return whole(planned);
  return geoRadius(branch);
}
export function geoRadius(branch: string): number {
  const me = CLINIC_PIN[branch];
  if (!me) return 3;
  const nearest = Math.min(...Object.entries(CLINIC_PIN).filter(([k]) => k !== branch).map(([, p]) => milesBetween(me, p)));
  return Math.max(1, Math.min(RADIUS_CAP[branch] ?? 10, Math.floor(nearest - 0.5)));
}
/** The clinic a pin is nearest to. */
const nearestClinic = (p: { lat: number | null; lng: number | null }) => {
  if (p.lat === null || p.lng === null) return null;
  let best: string | null = null, bd = Infinity;
  for (const [c, pin] of Object.entries(CLINIC_PIN)) { const d = milesBetween([p.lat, p.lng], pin); if (d < bd) { bd = d; best = c; } }
  return best;
};
/** The clinic areas the plan wants for this service, own clinic first (at least the own clinic and its best radius). */
export const plannedAreas = (branch: string, service?: string | null) => {
  const g = planGeo(branch, service);
  return g.include.length ? g.include : [{ branch, radius: bestRadius(branch, service) }];
};
/** Does a place match one of the plan's clinic circles (same clinic, radius not wider)? */
export const plannedPlace = (branch: string, service: string | null | undefined, p: { lat: number | null; lng: number | null; radius: number | null }) =>
  plannedAreas(branch, service).some((a) => nearestClinic(p) === a.branch && (p.radius ?? 99) <= a.radius);
/** Is this ad set's location what the plan says: a pin on each planned clinic at the plan's radius (not wider, and not
 *  more than a mile smaller, since a smaller circle loses clients who travel for the service), nothing else, and the
 *  plan's left-out areas? */
export function locationOk(branch: string, t: Targeting | null, service?: string | null) {
  if (!t || t.cities.length) return false;
  const inc = plannedAreas(branch, service);
  if (t.places.length !== inc.length || t.nearest !== branch) return false;
  const fits = inc.every((a) => t.places.some((p) => nearestClinic(p) === a.branch && (p.radius ?? 99) <= a.radius && (p.radius ?? 0) >= a.radius - 1));
  return fits && planGeo(branch, service).exclude.every((x) => (t.excluded ?? []).some((p) => nearestClinic(p) === x.branch));
}
export type ClinicArea = { branch: string; address: string; radius: number };
/** Own clinic to include, other clinics to also include (e.g. NovoForm at Fairview also pulls from QC), areas to leave out. */
export type LocationPick = { address: string; radius: number; also: ClinicArea[]; exclude: ClinicArea[] };
const toArea = (x: Area): ClinicArea => ({ branch: x.branch, address: CLINIC_SEARCH[x.branch], radius: x.radius });
export function locationPick(branch: string, o: { max?: number | null; service?: string | null; line?: Playbook["lines"][number] } = {}): LocationPick {
  const g = o.line ? geoOf(o.line, branch) : planGeo(branch, o.service);
  const own = g.include.find((x) => x.branch === branch)?.radius ?? (o.line && g.radius ? whole(g.radius) : bestRadius(branch, o.service));
  return {
    address: CLINIC_SEARCH[branch], radius: Math.min(own, o.max ?? 99),
    also: g.include.filter((x) => x.branch !== branch).map(toArea), exclude: g.exclude.map(toArea),
  };
}
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** "QC Main clinic + 10 mi, minus 1 mi around the Fairview and Marikina clinics" */
export const locationText = (branch: string, loc: LocationPick) =>
  `Hermosa ${SHORT[branch]} clinic (${loc.address}) + ${loc.radius} mi${loc.also.map((x) => `, and the ${SHORT[x.branch]} clinic + ${x.radius} mi`).join("")}${loc.exclude.length ? `, minus ${loc.exclude[0].radius} mi around the ${list(loc.exclude.map((x) => SHORT[x.branch]))} clinic${loc.exclude.length > 1 ? "s" : ""}` : ""}`;

export type AudiencePlan = { ageMin: number; ageMax: number; genders: string; interests: string[] };
export type SetRow = { field: string; now: string; set: string; change: boolean };
export type SettingsPlan = { rows: SetRow[]; steps: string[]; location: LocationPick | null };

const OPEN = (what: string, name: string, button: string) =>
  `Tap "${button} ↗" on this card. Ads Manager opens on ${what} "${name}" (log in with the Hermosa account if asked). Check the name at the top matches.`;
const DONE = "Back in Hermosa OS, tap \"Done\" on this card so the owner knows it's finished.";

/** What the ad set should look like (location from the clinic, audience from the playbook line) and how to get it there. */
export function settingsPlan(o: {
  name: string; branch: string; service?: string | null; t: Targeting | null; plan: AudiencePlan | null; overlapFix?: number | null; locationFlag?: boolean; button?: string;
}): SettingsPlan {
  const { t, branch } = o;
  const p: AudiencePlan = o.plan ?? { ageMin: 21, ageMax: 54, genders: "women", interests: [] };
  const loc = locationPick(branch, { max: o.overlapFix, service: o.service });
  const nowLoc = t ? ([...t.places.map((x) => `${x.radius ?? "?"} mi around "${x.name}"`), ...t.cities].join(" + ") || "Not set")
    + (t.excluded ?? []).map((x) => ` minus ${x.radius ?? "?"} mi around "${x.name}"`).join("") : "Couldn't read";
  const locChange = !!o.locationFlag || !!o.overlapFix || !locationOk(branch, t, o.service);
  const nowAge = !t ? "Couldn't read" : t.advantage
    ? `${t.ageMin ?? 18}+${t.ageSuggest ? ` (suggested ${t.ageSuggest[0]}–${t.ageSuggest[1]})` : ""}`
    : `${t.ageMin ?? 18}–${t.ageMax ?? 65}`;
  const ageChange = !t || (t.ageMin ?? 18) !== p.ageMin || t.advantage || (t.ageMax ?? 65) !== p.ageMax;
  const nowGender = !t ? "Couldn't read" : t.genders === "women" ? (t.advantage ? "Women, but only a suggestion (Advantage+ on)" : "Women") : t.genders === "men" ? "Men" : "All genders";
  const genderChange = !t || t.genders !== "women" || t.advantage;

  const rows: SetRow[] = [
    { field: "Audience", now: !t ? "Couldn't read" : t.advantage ? "Advantage+ audience" : "Original audience", set: "Original audience options", change: !t || t.advantage },
    { field: "Location", now: nowLoc, set: locationText(branch, loc), change: locChange },
    { field: "Age", now: nowAge, set: `${p.ageMin}–${p.ageMax}`, change: ageChange },
    { field: "Gender", now: nowGender, set: "Women", change: genderChange },
  ];

  const steps: string[] = [OPEN("ad set", o.name, o.button ?? "Fix settings")];
  steps.push("Scroll down to the Audience section.");
  if (!t || t.advantage) steps.push(`Click "Switch to original audience options" (under Advantage+ audience) and confirm. This makes age and gender hard limits.`);
  if (locChange) {
    steps.push(`In Locations, remove every location now listed${t && nowLoc !== "Not set" ? ` (${nowLoc})` : ""}: click the x next to each.`);
    steps.push(`Click in "Search locations", paste the clinic address (Copy on this card): "${loc.address}". Pick the result that matches the clinic.`);
    steps.push(`Click the small arrow next to the added location and set the radius to ${loc.radius} mi.${loc.also.length ? "" : " That should be the only included location."}`);
    for (const x of loc.also)
      steps.push(`Also add the ${SHORT[x.branch]} clinic: paste "${x.address}" in "Search locations", pick the matching result and set its radius to ${x.radius} mi.`);
    for (const x of loc.exclude)
      steps.push(`Leave out the ${SHORT[x.branch]} clinic's area (its own ads cover it): click "Include" next to the search box and change it to "Exclude", paste "${x.address}", pick the matching result and set its radius to ${x.radius} mi.`);
  }
  if (ageChange) steps.push(`Set Age to ${p.ageMin} – ${p.ageMax}.`);
  if (genderChange) steps.push(`Set Gender to "Women".`);
  if (t && t.interests.length === 0 && p.interests.length) steps.push(`Optional: in Detailed targeting, add ${p.interests.slice(0, 4).map((x) => `"${x}"`).join(", ")}.`);
  steps.push("Don't change the budget, placements or ads.");
  steps.push(`Click "Publish" (bottom right). Meta restarts learning for a few days after an audience change; that's expected.`);
  steps.push(DONE);
  return { rows, steps, location: locChange ? loc : null };
}

/** Budget moves: the field to change, before VAT (what you type in Ads Manager). */
export function budgetSteps(o: { name: string; level: "adset" | "campaign" | "none"; from: number; to: number; off?: boolean }) {
  const peso = (p: number) => `₱${Math.round(p).toLocaleString("en-US")}`;
  if (o.off) return [OPEN(o.level === "campaign" ? "campaign" : "ad set", o.name, "Turn off"), `Turn the On/Off switch next to "${o.name}" to Off.`, DONE];
  return [
    OPEN(o.level === "campaign" ? "campaign" : "ad set", o.name, o.from > 0 ? "Change budget" : "Open ad sets"),
    `${o.level === "campaign" ? "In the campaign's Budget section" : "In Budget & schedule"}, change Daily budget from ${o.from > 0 ? peso(o.from) : "₱0 (off)"} to ${peso(o.to)}. Type the number as is; Meta adds VAT on the bill.`,
    ...(o.from > 0 ? [] : [`If the ad set is off, turn its switch On.`]),
    `Click "Publish" (bottom right).`,
    "Don't change it again for 7 days, so Meta can learn.",
    DONE,
  ];
}

export const pauseSteps = (ad: string) => [OPEN("ad", ad, "Pause ad"), `Turn the On/Off switch next to ad "${ad}" to Off. Leave its ad set and the other ads on.`, DONE];

export const remakeSteps = (ad: string) => [
  OPEN("ad", ad, "Open ad"), `Turn the On/Off switch next to ad "${ad}" to Off.`,
  "Send the owner a note: \"Paused for a remake: new first 3 seconds, shorter (15–30s), same offer.\" The new version is made and OK'd before it goes live.", DONE,
];

export const versionSteps = (ad: string) => [
  OPEN("ad set's ads", ad, "Add versions"),
  `Tick ad "${ad}", click "Duplicate", and keep it in the same ad set.`,
  "In the copy, change only the first line of text, or swap in a new video from the Hermosa ad library. Name it the same with \" v2\" at the end.",
  `Click "Publish". Keep the original running next to it.`, DONE,
];
