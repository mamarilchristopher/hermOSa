// CHRIS Nov 27: package records start at the earliest session logged. DEMO names only.
import { describe, expect, it } from "vitest";
import { allPackageRecords, packageRecord, type PackageLine } from "../../src/lib/packages";

const L = (client: string, session: number, date: string, amount = 0, service = "vc"): PackageLine => ({ client, service, session, date, amount, branch: null });

describe("package records", () => {
  it("starts at the first session logged and suggests the next", () => {
    const lines = [L("DEMO Ana", 3, "2026-11-20", 150000), L("DEMO Ana", 2, "2026-11-13", 150000), L("DEMO Bea", 1, "2026-11-10")];
    const r = packageRecord(lines, "  demo   ana ", "vc")!;
    expect(r).toMatchObject({ start: 2, startDate: "2026-11-13", done: [2, 3], last: 3, paid: 300000 });
    expect(packageRecord(lines, "DEMO Ana", "meso")).toBeNull();
    expect(packageRecord(lines, "DEMO Cara", "vc")).toBeNull();
  });
  it("lists every client per package, newest visit first", () => {
    const all = allPackageRecords([L("DEMO Ana", 2, "2026-11-13"), L("DEMO Bea", 1, "2026-11-25"), L("demo ana", 3, "2026-11-20")]);
    expect(all.map((r) => [r.client, r.start, r.lastDate])).toEqual([["DEMO Bea", 1, "2026-11-25"], ["DEMO Ana", 2, "2026-11-20"]]);
  });
});
