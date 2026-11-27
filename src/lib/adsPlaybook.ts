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
  kpis: { target_cost_per_chat_vat: number; scale_if_weekly_real_roas_at_least: number; trim_if_real_roas_below_for_2_weeks: number };
};
export type Untapped = { service: string; why: string; evidence: string[]; setup: string; budget_day_pre_vat: number; creative_brief: string };
export type Playbook = {
  updated: string; master_plan: string; catalog_sheet: string; month_total_pre_vat: number;
  december: { base_pre_vat: number; reserve_pre_vat: number; reserve_rule: string; daily_shape: string };
  rules: string[];
  lines: PlayLine[];
  radar: {
    note: string;
    untapped: Untapped[];
    retargeting: { setup: string; audiences: string[]; budget_day_pre_vat: number; creative_plan: string; benchmarks: { metric: string; value: string; source: string }[] };
    trends: { title: string; detail: string; source: string }[];
    benchmarks: { campaign_type: string; metric: string; value: string; source: string }[];
  };
  videos: Record<string, { title: string; kind?: string | null; cpc?: string | number | null; running?: string | null; sec?: number | null }>;
};

export const PLAYBOOK = raw as unknown as Playbook;

/** Plan per "BRANCH|SERVICE" for the advisor (branch lines only; the ALL lines are new ad sets). */
export const planMap = (pb: Playbook = PLAYBOOK) =>
  new Map(pb.lines.filter((l) => l.branch !== "ALL").map((l) => [`${l.branch}|${l.service}`, { budget: l.daily_budget_pre_vat, status: l.status, reviewDays: l.review_after_days }]));
export const playLine = (branch: string, service: string, pb: Playbook = PLAYBOOK) => pb.lines.find((l) => l.branch === branch && l.service === service) ?? null;
export const newAdSets = (pb: Playbook = PLAYBOOK) => pb.lines.filter((l) => l.branch === "ALL");
export const planPerDay = (pb: Playbook = PLAYBOOK) => pb.lines.reduce((s, l) => s + (l.daily_budget_pre_vat || 0), 0);

const STATUS: Record<string, string> = {
  keep: "Keep", keep_untouched: "Keep, don't touch", keep_and_refresh: "Keep, add fresh ads", rebuild: "Rebuild the ads", off: "Off", start: "Start",
};
export const statusLabel = (s: string) => STATUS[s] ?? s.replace(/_/g, " ");
/** Source strings may hold several URLs split by " ; ". */
export const links = (s: string) => s.split(/\s*;\s*/).filter(Boolean).map((x) => ({ href: /^https?:\/\//.test(x) ? x : null, label: /^https?:\/\//.test(x) ? new URL(x).hostname.replace(/^www\./, "") : x }));
