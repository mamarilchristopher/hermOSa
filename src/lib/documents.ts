/** Documents (update-0082, CHRIS Nov 26): the clinic's approved forms, every version kept. */
export type DocVersion = {
  id: string; doc_key: string; title: string; category: string; version: string; note: string | null;
  file_path: string; file_name: string; approved_on: string | null; created_at: string;
};
export type DocGroup = { key: string; title: string; category: string; current: DocVersion; old: DocVersion[] };

/** Category order on the page; anything new goes after these, A to Z. */
export const CATEGORY_ORDER = ["Client forms", "Staff forms", "Inventory"];

/** Oldest first: forms from before the app (no date), then by approval date, then by when they were added. */
export function versionOrder(a: DocVersion, b: DocVersion): number {
  const ad = a.approved_on ?? "", bd = b.approved_on ?? "";
  return ad.localeCompare(bd) || a.created_at.localeCompare(b.created_at);
}

/** One entry per document: the newest version is current; older ones newest first. */
export function groupDocs(rows: DocVersion[]): DocGroup[] {
  const by = new Map<string, DocVersion[]>();
  for (const r of rows) by.set(r.doc_key, [...(by.get(r.doc_key) ?? []), r]);
  const groups = [...by.entries()].map(([key, list]) => {
    const sorted = [...list].sort(versionOrder);
    const current = sorted[sorted.length - 1];
    return { key, title: current.title, category: current.category, current, old: sorted.slice(0, -1).reverse() };
  });
  const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
  return groups.sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

/** Built-in forms ship with the app ("static:/forms/x.pdf"); uploads live in the private "documents" folder. */
export const staticUrl = (path: string) => (path.startsWith("static:/") ? path.slice("static:".length) : null);

/** A short key for a new document's title: "Staff Contract" -> "staff-contract". */
export function keyFor(title: string): string {
  const k = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return k.length >= 2 ? k : `doc-${Date.now().toString(36)}`;
}

export const dateLabel = (d: string | null) =>
  d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "Before Nov 2026";
