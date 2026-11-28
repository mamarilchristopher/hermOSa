import { describe, expect, it } from "vitest";
import { doubleEntries, type DupRow } from "../../src/lib/doubleEntries";

const row = (id: string, p: Partial<DupRow> = {}): DupRow => ({
  id, client_name: "Demo Client", service_id: "svc-a", session_no: 1, service_date: "2026-11-27", state: "APPROVED", created_at: `2026-11-27T0${id.length}:00:00Z`, log_no: `SL-DEMO-${id}`, ...p,
});

describe("doubleEntries", () => {
  it("flags the same client, service, session and day (any spacing or capitals)", () => {
    const d = doubleEntries([row("a"), row("bb", { client_name: "  demo   CLIENT ", state: "PENDING" })]);
    expect(d.get("bb")).toEqual([{ id: "a", log_no: "SL-DEMO-a", state: "APPROVED", first: true }]);
    expect(d.get("a")?.[0].id).toBe("bb");
  });
  it("ignores rejected entries, other services, other days and double-dose sessions", () => {
    const d = doubleEntries([
      row("a"), row("b", { state: "REJECTED" }), row("c", { service_id: "svc-b" }), row("d", { service_date: "2026-11-26" }), row("e", { session_no: 2 }),
      row("f", { client_name: null }), row("g", { client_name: "Other Demo", service_id: "svc-b" }),
    ]);
    expect(d.size).toBe(0);
  });
  it("lists every other copy when logged three times", () => {
    const d = doubleEntries([row("a"), row("bb"), row("ccc")]);
    expect(d.get("ccc")?.map((x) => x.id)).toEqual(["a", "bb"]);
  });
});
