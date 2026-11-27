/**
 * Delegable ad fixes (v0.99.8, CHRIS Nov 28: "an advisor that can let me delegate these manual setting tasks to someone
 * with basic understanding of ads management"). Every move gets the exact values to type and numbered click-by-click
 * steps in Ads Manager, so a staff member can do it from the card or from the copied text.
 */
import type { Targeting } from "./adsAdvisor";

const SHORT: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };
/** Public clinic addresses (CHRIS, Nov 23 2026), for dropping the map pin. */
export const CLINIC_ADDRESS: Record<string, string> = {
  QC_MAIN: "Regray Square Bldg., 30 Matino St., Sikatuna Village, Diliman, Quezon City",
  FAIRVIEW: "Cristina Bldg., Regalado Ave. cor. Coronet St., West Fairview, Quezon City",
  STA_MARIA: "JSP Building, Kanto Caypombo, Sta. Maria, Bulacan",
  MARIKINA: "GT1 Bldg., B.G. Molina St., Parang, Marikina City",
};
/** Circle size when the playbook doesn't say. */
const DEFAULT_RADIUS: Record<string, number> = { QC_MAIN: 4, FAIRVIEW: 5, STA_MARIA: 4, MARIKINA: 4 };
const BRANCH_WORD: [RegExp, string][] = [[/qc main|main qc/i, "QC_MAIN"], [/fairview/i, "FAIRVIEW"], [/sta\.? maria|smb/i, "STA_MARIA"], [/marikina/i, "MARIKINA"]];
const branchIn = (s: string) => BRANCH_WORD.find(([re]) => re.test(s))?.[1] ?? null;

export type AudiencePlan = { ageMin: number; ageMax: number; genders: string; interests: string[]; include: string[]; exclude: string[] };
export type SetRow = { field: string; now: string; set: string; change: boolean };
export type SettingsPlan = { rows: SetRow[]; steps: string[] };

const OPEN = (what: string, name: string, button: string) =>
  `Tap "${button} ↗" on this card. Ads Manager opens on ${what} "${name}" (log in with the Hermosa account if asked). Check the name at the top matches.`;
const DONE = "Back in Hermosa OS, tap \"Done\" on this card so the owner knows it's finished.";

function pinPlace(branch: string, miles: number) {
  return { label: `Pin on Hermosa ${SHORT[branch]} (${CLINIC_ADDRESS[branch]}), ${miles} mi`, branch, miles };
}

/** What the ad set should look like, from the playbook line, and how to get it there. */
export function settingsPlan(o: {
  name: string; branch: string; t: Targeting | null; plan: AudiencePlan | null; overlapFix?: number | null; locationFlag?: boolean; button?: string;
}): SettingsPlan {
  const { t, branch } = o;
  const p: AudiencePlan = o.plan ?? { ageMin: 21, ageMax: 54, genders: "women", interests: [], include: [], exclude: [] };
  // Location: a pin on our clinic with the playbook's circle, or the playbook's list of towns.
  const inc = p.include.map((s) => ({ s, mi: s.match(/(\d+(?:\.\d+)?)\s*mi\b/i), b: branchIn(s) }));
  const own = inc.find((x) => x.mi && (x.b === branch || x.b === null));
  let radius = own ? Number(own.mi![1]) : DEFAULT_RADIUS[branch] ?? 4;
  if (o.overlapFix) radius = Math.min(radius, o.overlapFix);
  const towns = inc.filter((x) => !x.mi).map((x) => x.s.replace(/\s*\(.*?\)\s*$/, "").trim()).filter(Boolean);
  const usePin = !!own || towns.length === 0;
  const pin = pinPlace(branch, radius);
  const setLoc = usePin ? [pin.label, ...towns].join(" + ") : towns.join(", ");
  const nowLoc = t ? [...t.places.map((x) => `${x.radius ?? "?"} mi around "${x.name}"`), ...t.cities].join(" + ") || "Not set" : "Couldn't read";
  const tooWide = !!t && t.places.some((x) => (x.radius ?? 0) > radius + 0.01);
  const locChange = !!o.locationFlag || !!o.overlapFix || tooWide || (!!t && t.nearest !== null && t.nearest !== branch);
  const excl = p.exclude.map((s) => ({ s, mi: Number(s.match(/(\d+(?:\.\d+)?)\s*mi\b/i)?.[1] ?? 2), b: branchIn(s) })).filter((x) => x.b);
  const setExcl = excl.map((x) => `${x.mi} mi around Hermosa ${SHORT[x.b!]}`).join(", ");

  const nowAge = !t ? "Couldn't read" : t.advantage
    ? `${t.ageMin ?? 18}+${t.ageSuggest ? ` (suggested ${t.ageSuggest[0]}–${t.ageSuggest[1]})` : ""}`
    : `${t.ageMin ?? 18}–${t.ageMax ?? 65}`;
  const ageChange = !t || (t.ageMin ?? 18) !== p.ageMin || t.advantage || (t.ageMax ?? 65) !== p.ageMax;
  const nowGender = !t ? "Couldn't read" : t.genders === "women" ? (t.advantage ? "Women, but only a suggestion (Advantage+ on)" : "Women") : t.genders === "men" ? "Men" : "All genders";
  const genderChange = !t || t.genders !== "women" || t.advantage;

  const rows: SetRow[] = [
    { field: "Audience", now: !t ? "Couldn't read" : t.advantage ? "Advantage+ audience" : "Original audience", set: "Original audience options", change: !t || t.advantage },
    { field: "Location", now: nowLoc, set: setLoc, change: locChange },
    ...(setExcl ? [{ field: "Exclude", now: "–", set: setExcl, change: locChange }] : []),
    { field: "Age", now: nowAge, set: `${p.ageMin}–${p.ageMax}`, change: ageChange },
    { field: "Gender", now: nowGender, set: "Women", change: genderChange },
  ];

  const steps: string[] = [OPEN("ad set", o.name, o.button ?? "Fix settings")];
  steps.push("Scroll down to the Audience section.");
  if (!t || t.advantage) steps.push(`Click "Switch to original audience options" (under Advantage+ audience) and confirm. This makes age and gender hard limits.`);
  if (locChange) {
    steps.push(`In Locations, click "Edit" and remove every location now listed${t && nowLoc !== "Not set" ? ` (${nowLoc})` : ""}.`);
    if (usePin) {
      steps.push(`Click "Drop Pin" and type "${CLINIC_ADDRESS[branch]}" in the search box (or drag the pin onto the Hermosa ${SHORT[branch]} clinic). Set the circle to ${radius} mi.`);
      if (towns.length) steps.push(`Also type and add: ${towns.join(", ")}. Pick the Philippine one each time.`);
    } else {
      steps.push(`Type and add each of these, picking the one in ${branch === "STA_MARIA" ? "Bulacan" : "Metro Manila"}: ${towns.join(", ")}.`);
    }
    for (const x of excl) steps.push(`Switch the dropdown from "Include" to "Exclude", drop a pin on "${CLINIC_ADDRESS[x.b!]}" (Hermosa ${SHORT[x.b!]}) and set it to ${x.mi} mi.`);
  }
  if (ageChange) steps.push(`Set Age to ${p.ageMin} – ${p.ageMax}.`);
  if (genderChange) steps.push(`Set Gender to "Women".`);
  if (t && t.interests.length === 0 && p.interests.length) steps.push(`Optional: in Detailed targeting, add ${p.interests.slice(0, 4).map((x) => `"${x}"`).join(", ")}.`);
  steps.push("Don't change the budget, placements or ads.");
  steps.push(`Click "Publish" (bottom right). Meta restarts learning for a few days after an audience change; that's expected.`);
  steps.push(DONE);
  return { rows, steps };
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
