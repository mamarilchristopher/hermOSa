/**
 * The ads playbook (update-0099): recommended set-up per branch × service, library videos to use, and the market radar
 * (untapped services, retargeting, trends, benchmarks). Kept by the ads work in src/data/adsPlaybook.json and shipped
 * with the app; the live numbers it's checked against come from the daily Meta feed.
 */
import raw from "../data/adsPlaybook.json";

export type PlayCreative = { v: string | null; ad_name?: string; role: string; why: string };
export type PlayLine = {
  branch: string; service: string; service_name: string; ad_set_name: string; status: string; daily_budget_pre_vat: number;
  objective: string; placements: string; rationale: string; review_after_days: number;
  audience: { mode: string; age_min: number; age_max: number; genders: string; interests: string[]; behaviors: string[]; note?: string };
  geo: { include: string[]; exclude: string[] };
  creatives: PlayCreative[];
  proposed_change?: { daily_budget_pre_vat: number; why: string; status?: string } | null;
  kpis: { target_cost_per_chat_vat: number; scale_if_weekly_real_roas_at_least: number; trim_if_real_roas_below_for_2_weeks: number };
};
export type Untapped = { service: string; why: string; evidence: string[]; setup: string; budget_day_pre_vat: number; creative_brief: string };
export type ServiceGap = {
  service: string; nov1_24_sales_php: number; new_clients: number; typical_ticket_php: number; ad_spend_share_last30d: string;
  by_branch: string; break_even_close_rate_for_5x: string; assumed_cost_per_chat_vat: number | string; verdict: string;
};
export type Playbook = {
  updated: string; version?: string | number | null; proposed_note?: string | null; master_plan: string; catalog_sheet: string; month_total_pre_vat: number;
  december: { base_pre_vat: number; reserve_pre_vat: number; reserve_rule: string; daily_shape: string };
  rules: string[];
  refresh_rule?: { principle: string; evidence: string[]; baseline: string; states: { state: string; test: string; action: string }[]; cadence: string[]; sales_and_foot_traffic: string[] } | null;
  lines: PlayLine[];
  radar: {
    note: string;
    untapped: Untapped[];
    retargeting: { setup: string; audiences: string[]; budget_day_pre_vat: number; creative_plan: string; benchmarks: { metric: string; value: string; source: string }[] };
    trends: { title: string; detail: string; source: string }[];
    benchmarks: { tier?: number; campaign_type: string; metric: string; value: string; source: string }[];
    benchmarks_note?: string | null;
    service_gaps?: ServiceGap[] | null; service_gaps_note?: string | null;
    growth_signals?: { updated: string; source: string; findings: string[]; actions: { what: string; budget_day_pre_vat: number; status?: string }[]; emerging_service_rule?: string } | null;
  };
  videos: Record<string, { title: string; kind?: string | null; cpc?: string | number | null; running?: string | null; sec?: number | null }>;
};

export const PLAYBOOK = raw as unknown as Playbook;

/** A branch's running ad line (not an all-branch ad set, and not a new one still waiting for CHRIS's OK). */
const isBranchLine = (l: PlayLine) => l.branch !== "ALL" && l.status !== "proposed";
/** Plan per "BRANCH|SERVICE" for the advisor. */
export const planMap = (pb: Playbook = PLAYBOOK) =>
  new Map(pb.lines.filter(isBranchLine).map((l) => [`${l.branch}|${l.service}`, {
    budget: l.daily_budget_pre_vat, status: l.status, reviewDays: l.review_after_days, targetCpc: l.kpis?.target_cost_per_chat_vat ?? null,
    proposedChange: l.proposed_change ? { budget: l.proposed_change.daily_budget_pre_vat, why: l.proposed_change.why, status: l.proposed_change.status } : null,
  }]));
export const playLine = (branch: string, service: string, pb: Playbook = PLAYBOOK) => pb.lines.find((l) => isBranchLine(l) && l.branch === branch && l.service === service) ?? null;
/** All-branch ad sets and proposed new ones, proposed first. */
export const newAdSets = (pb: Playbook = PLAYBOOK) => pb.lines.filter((l) => !isBranchLine(l)).sort((a, b) => Number(b.status === "proposed") - Number(a.status === "proposed"));
/** Daily budget of the agreed plan (proposals not counted until CHRIS OKs them). */
export const planPerDay = (pb: Playbook = PLAYBOOK) => pb.lines.filter((l) => l.status !== "proposed").reduce((s, l) => s + (l.daily_budget_pre_vat || 0), 0);
export const proposedPerDay = (pb: Playbook = PLAYBOOK) => pb.lines.filter((l) => l.status === "proposed").reduce((s, l) => s + (l.daily_budget_pre_vat || 0), 0);

const STATUS: Record<string, string> = {
  keep: "Keep", keep_untouched: "Keep, don't touch", keep_and_refresh: "Keep, add fresh ads", rebuild: "Rebuild the ads", off: "Off", start: "Start", proposed: "Waiting for your OK", hold: "On hold",
};
export const statusLabel = (s: string) => STATUS[s] ?? s.replace(/_/g, " ");
/** Source strings may hold several URLs split by " ; ", each optionally followed by a note ("https://x.ph/a (PH agency)"). */
export const links = (s: string) => s.split(/\s*;\s*/).filter(Boolean).map((x) => {
  const m = x.match(/^(https?:\/\/\S+)\s*(.*)$/);
  if (!m) return { href: null, label: x };
  let host = m[1];
  try { host = new URL(m[1]).hostname.replace(/^www\./, ""); } catch { /* keep the raw text */ }
  return { href: m[1], label: m[2] ? `${host} ${m[2]}` : host };
});
