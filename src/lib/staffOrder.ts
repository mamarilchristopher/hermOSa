// Owner's staff order (2026-11-24): Owners > Managers > Senior CMA > CMA > Trainee, then everyone else, then by name.
// Senior CMA and CMA share the CLINICIAN role; the position title tells them apart.

type Grant = { role_code: string; branch_id: string | null };

export function staffRank(grants: Grant[], position?: string | null): number {
  const roles = new Set(grants.map((g) => g.role_code));
  const pos = (position ?? "").toLowerCase().replace(/[\s.]/g, "");
  // Position titles as a fallback: some screens can't see other people's roles.
  if (roles.has("OWNER") || pos === "owner") return 0;
  if (pos.includes("generalmanager")) return 1;
  if (roles.has("MANAGER")) return grants.some((g) => g.role_code === "MANAGER" && g.branch_id === null) ? 1 : 2; // GM before branch managers
  if (pos.includes("manager")) return 2;
  if (pos.includes("seniorcma")) return 3;
  if (pos.includes("cma")) return 4;
  if (pos.includes("trainee")) return 5;
  if (roles.has("CLINICIAN")) return 6;
  return roles.size ? 7 : 8; // no role yet goes last
}

export const RANK_LABEL = ["Owners", "General Manager", "Managers", "Senior CMA", "CMA", "Trainees", "Clinicians", "Other staff", "No role yet"];

export function byRankThenName<T>(list: T[], rank: (x: T) => number, name: (x: T) => string): T[] {
  return [...list].sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
}
