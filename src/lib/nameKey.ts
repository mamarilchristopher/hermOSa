/** Same rule as private.name_key in the database: "Ma. Lea R. Cruz" and "Lea Cruz" both become "lea cruz". */
export function nameKey(name: string | null | undefined): string {
  let a = (name ?? "").toLowerCase().replace(/[^a-zñ ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (a.length > 2 && (a[0] === "ma" || a[0] === "maria")) a = a.slice(1);
  return a.length < 2 ? (a[0] ?? "") : `${a[0]} ${a[a.length - 1]}`;
}

type U = { id: string; uid: string | null; display_name: string; email?: string | null; join_status?: string | null; active?: boolean | null };

/** Approved accounts that look like the same person as a join request (same first and last name). */
export function sameNameAccounts<T extends U>(who: U, all: T[]): T[] {
  const k = nameKey(who.display_name);
  if (!k.includes(" ")) return [];
  return all.filter((x) => x.id !== who.id && x.join_status !== "PENDING" && x.join_status !== "REJECTED" && nameKey(x.display_name) === k);
}
