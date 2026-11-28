// v0.100.6 (CHRIS Nov 28): "I accidentally approved additional sales": entries that look logged twice.
// Same client (name, any spacing or capitals), same service, same session and same day, neither rejected.
// A client's different services on one visit, or a double dose (two package sessions), are not flagged.

export type DupRow = { id: string; client_name?: string | null; service_id?: string | null; session_no?: number | null; service_date: string; state: string; created_at: string; log_no?: string | null };
export type DupOf = { id: string; log_no: string | null; state: string; first: boolean };

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** For each entry that looks logged twice: the other matching entries (oldest first) and whether it is the first one. */
export function doubleEntries(rows: DupRow[]): Map<string, DupOf[]> {
  const groups = new Map<string, DupRow[]>();
  for (const r of rows) {
    if (r.state === "REJECTED" || !r.client_name || !r.service_id) continue;
    const name = norm(r.client_name);
    if (name.length < 2) continue;
    const k = `${r.service_date}|${r.service_id}|${r.session_no ?? 1}|${name}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = new Map<string, DupOf[]>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = g.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const r of sorted) out.set(r.id, sorted.filter((x) => x.id !== r.id).map((x) => ({ id: x.id, log_no: x.log_no ?? null, state: x.state, first: x.id === sorted[0].id })));
  }
  return out;
}
