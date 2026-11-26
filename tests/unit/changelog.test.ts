import { describe, expect, it } from "vitest";
import { parseChangelog, releaseText } from "../../src/lib/changelog";

describe("parseChangelog", () => {
  const md = `| Version | Date (Manila) | Needs SQL | What changed |
| --- | --- | --- | --- |
| 0.2.0 | Nov 26, 2026 | update-0002 | Bookings open to everyone (all branches; read only), by visit date; costs P300 |
| 0.1.0 | Nov 25, 2026 | none | First release |`;
  it("reads each version and splits points on '; ' outside brackets", () => {
    const r = parseChangelog(md);
    expect(r.map((x) => x.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(r[0].items).toEqual(["Bookings open to everyone (all branches; read only), by visit date", "Costs ₱300"]);
    expect(releaseText(r[1])).toBe("Hermosa OS v0.1.0 (Nov 25, 2026)\n• First release");
  });
  it("reads the real CHANGELOG", async () => {
    const fs = await import("node:fs");
    const r = parseChangelog(fs.readFileSync("CHANGELOG.md", "utf8"));
    expect(r.length).toBeGreaterThan(80);
    expect(r[0].items.length).toBeGreaterThan(0);
  });
});
