/**
 * Ad advisor research areas (v0.99.8, CHRIS Nov 28: "things like this should be automatically embedded in our system as
 * research areas for our adviser"). Studies come from src/data/adsResearch.json (synced from the ads playbook's
 * research.json, which every ads research thread updates). Open questions are found automatically in the playbook:
 * a benchmark or trend still marked pending, or an untapped idea being researched that has no study yet.
 */
import raw from "../data/adsResearch.json";
import { PLAYBOOK, type Playbook } from "./adsPlaybook";

export type Finding = { tier: number; text: string; source: string };
export type Area = {
  id: string; title: string; question: string; asked: string; asked_by: string; status: string; headline: string;
  findings: Finding[]; recommendation: string | null; next: string | null; links: { untapped?: string }; report: string | null;
};
export type OpenQuestion = { id: string; title: string; need: string; from: "benchmark" | "trend" | "untapped" };

export const AREAS = (raw as unknown as { areas: Area[] }).areas;

const ORDER: Record<string, number> = { researching: 0, testing: 1, queued: 2, done: 3, parked: 4 };
const LABEL: Record<string, string> = { researching: "Being researched", testing: "Testing", queued: "Queued", done: "Done", parked: "Parked" };
export const areaStatus = (s: string) => LABEL[s] ?? s;
/** Open work first, then finished studies, newest first inside each. */
export const sortAreas = (as: Area[] = AREAS) =>
  [...as].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.asked.localeCompare(a.asked));

/** Evidence tiers, strongest first (PH DATA RULE, CHRIS Nov 28). */
export const TIER: Record<number, string> = { 1: "Our data", 2: "PH competitors", 3: "PH sources", 0: "Meta rule" };

/** The study for an untapped idea, if one exists. */
export const areaFor = (service: string, as: Area[] = AREAS) => as.find((a) => a.links?.untapped === service) ?? null;

const isPending = (s: string | null | undefined) => !!s && /^pending\b/i.test(s.trim());

/** Questions the advisor can't answer yet, read from the playbook so new gaps show up without anyone listing them. */
export function openQuestions(pb: Playbook = PLAYBOOK, as: Area[] = AREAS): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (const b of pb.radar.benchmarks)
    if (isPending(b.source)) out.push({ id: `b:${b.campaign_type}:${b.metric}`, title: `${b.campaign_type}: ${b.metric}`, need: b.value, from: "benchmark" });
  for (const t of pb.radar.trends)
    if (isPending(t.source)) out.push({ id: `t:${t.title}`, title: t.title, need: `${t.detail} Needs ${t.source.replace(/^pending:?\s*/i, "")}.`, from: "trend" });
  for (const u of pb.radar.untapped)
    if (u.status === "research" && !areaFor(u.service, as)) out.push({ id: `u:${u.service}`, title: u.service, need: u.why, from: "untapped" });
  return out;
}
