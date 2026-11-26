/** The version log (CHANGELOG.md, read at build time) as plain-language rows for the Updates page (CHRIS Nov 26). */
export type Release = { version: string; date: string; items: string[] };

export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  for (const line of md.split("\n")) {
    const m = /^\| (\d+\.\d+\.\d+) \| ([^|]+) \| ([^|]+) \| (.+) \|$/.exec(line.trim());
    if (!m) continue;
    const text = m[4].trim().replace(/\bP(\d[\d,]*)/g, "₱$1");
    // "; " separates points, except inside brackets.
    const items: string[] = [];
    let depth = 0, cur = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "(") depth++;
      if (c === ")") depth = Math.max(0, depth - 1);
      if (c === ";" && depth === 0 && text[i + 1] === " ") { items.push(cur.trim()); cur = ""; i++; continue; }
      cur += c;
    }
    if (cur.trim()) items.push(cur.trim());
    out.push({ version: m[1], date: m[2].trim(), items: items.filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)) });
  }
  return out;
}

export const releaseText = (r: Release) => `Hermosa OS v${r.version} (${r.date})\n${r.items.map((i) => `• ${i}`).join("\n")}`;
export const releasesText = (title: string, rs: Release[]) => `${title}\n\n${rs.map(releaseText).join("\n\n")}`;
