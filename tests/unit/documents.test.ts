import { describe, expect, it } from "vitest";
import { groupDocs, keyFor, staticUrl, type DocVersion } from "../../src/lib/documents";

const v = (doc_key: string, version: string, approved_on: string | null, created_at: string, category = "Client forms"): DocVersion =>
  ({ id: `${doc_key}-${version}`, doc_key, title: doc_key, category, version, note: null, file_path: "", file_name: "", approved_on, created_at });

describe("documents", () => {
  it("newest version is current, older ones newest first, undated originals oldest", () => {
    const g = groupDocs([v("waiver", "Version 2", "2026-11-23", "2026-11-23T00:00:02Z"), v("waiver", "Original", null, "2026-11-23T00:00:01Z"),
      v("waiver", "Version 3", "2026-11-26", "2026-11-26T00:00:03Z")]);
    expect(g).toHaveLength(1);
    expect(g[0].current.version).toBe("Version 3");
    expect(g[0].old.map((x) => x.version)).toEqual(["Version 2", "Original"]);
  });
  it("same approval date: the one added later wins", () => {
    const g = groupDocs([v("a", "B", "2026-11-26", "2026-11-26T05:00:00Z"), v("a", "A", "2026-11-26", "2026-11-26T04:00:00Z")]);
    expect(g[0].current.version).toBe("B");
  });
  it("client forms before inventory, then A to Z", () => {
    const g = groupDocs([v("stock", "1", null, "x", "Inventory"), v("zeta", "1", null, "x"), v("alpha", "1", null, "x"), v("misc", "1", null, "x", "Other")]);
    expect(g.map((x) => x.key)).toEqual(["alpha", "zeta", "stock", "misc"]);
  });
  it("static files and keys", () => {
    expect(staticUrl("static:/forms/a.pdf")).toBe("/forms/a.pdf");
    expect(staticUrl("waiver/abc.pdf")).toBeNull();
    expect(keyFor("Staff Employment Contract!")).toBe("staff-employment-contract");
  });
});
