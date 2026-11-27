/**
 * CHRIS Nov 27: clients' package records. A package (bundle) has no preset price per session; the record of a client
 * starts at the earliest session logged in Hermosapp (session 2 if they did session 1 before) and follows it onward.
 */
export const clientKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** CHRIS Nov 27: one line of a client's package record (bundle sessions already in the Service log). */
export type PackageLine = { client: string; service: string; session: number; date: string; amount: number; branch: string | null };
/** A client's record for one package: from the earliest session logged (the baseline) onward. */
export function packageRecord(lines: PackageLine[], client: string, service: string) {
  const key = clientKey(client);
  if (key.length < 2 || !service) return null;
  const mine = lines.filter((l) => l.service === service && clientKey(l.client) === key)
    .sort((a, b) => a.session - b.session || a.date.localeCompare(b.date));
  if (!mine.length) return null;
  const done = [...new Set(mine.map((l) => l.session))];
  return { lines: mine, start: mine[0].session, startDate: mine[0].date, done, last: Math.max(...done), paid: mine.reduce((t, l) => t + l.amount, 0) };
}

/** Every client's record per package, for the Packages page: newest activity first. */
export function allPackageRecords(lines: PackageLine[]) {
  const by = new Map<string, PackageLine[]>();
  for (const l of lines) {
    const k = `${l.service}|${clientKey(l.client)}`;
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  return [...by.values()].map((ls) => ({ client: ls[0].client.trim(), service: ls[0].service, lastDate: ls.reduce((m, l) => (l.date > m ? l.date : m), ""), ...packageRecord(ls, ls[0].client, ls[0].service)! }))
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate));
}
