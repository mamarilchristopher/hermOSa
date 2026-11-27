import { describe, expect, it } from "vitest";
import {
  adRoas, adServiceOf, parseSourceLines, parseSpendLines, periodOptions, perMessage, roas, sourceOf, spent, spentK, summarize, summarizeSources, withVat,
  type SpendRow,
} from "../../src/lib/ads";

describe("money rule", () => {
  it("spent money carries 12% VAT and a *", () => {
    expect(withVat(100_000)).toBe(112_000);
    expect(spent(100_000)).toBe("₱1,120*");
    expect(spentK(36_696_428)).toBe("₱411K*");
    expect(spentK(100_000_000)).toBe("₱1.12M*");
  });
  it("ROAS and cost per chat use spend with VAT", () => {
    expect(roas({ spend: 100_000, sales: 560_000 })).toBe(5);
    expect(roas({ spend: 0, sales: 1 })).toBeNull();
    expect(perMessage({ spend: 100_000, messages: 28 })).toBe(4000);
  });
});

describe("ad lines", () => {
  it("sorts services into Hiko, Gluta (drips included) and other", () => {
    expect(adServiceOf("Hiko Deluxe Nose Thread")).toBe("HIKO");
    expect(adServiceOf("DEMO Lux Queen drip")).toBe("GLUTA");
    expect(adServiceOf("L-Carnitine")).toBe("GLUTA");
    expect(adServiceOf("Botox Jawtox")).toBe("OTHER");
  });
});

describe("periods", () => {
  it("year so far, last 3 full months, 12 months, then single months newest first", () => {
    const months = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-09", "2026-10", "2026-11"];
    const o = periodOptions(months, "2026-11");
    expect(o[0]).toEqual({ key: "ytd", label: "2026 so far", months: ["2026-01", "2026-02", "2026-09", "2026-10", "2026-11"] });
    expect(o[1]).toEqual({ key: "3m", label: "Feb–Oct", months: ["2026-02", "2026-09", "2026-10"] });
    expect(o[2].months).toHaveLength(7);
    expect(o.slice(3).map((p) => p.key)).toEqual(["2026-11", "2026-10", "2026-09", "2026-02", "2026-01", "2025-12"]);
    expect(periodOptions([], "2026-11")).toEqual([]);
  });
});

describe("summarize", () => {
  it("adds spend per branch and line, and splits branch sales by service share", () => {
    const rows: SpendRow[] = [
      { month: "2026-10-01", branch_id: "a", service: "HIKO", spend_cents: 100_000, messages: 30, through: null },
      { month: "2026-10-01", branch_id: "a", service: "GLUTA", spend_cents: 20_000, messages: 10, through: null },
      { month: "2026-09-01", branch_id: "a", service: "HIKO", spend_cents: 999_999, messages: 1, through: null },
      { month: "2026-10-01", branch_id: "zz", service: "HIKO", spend_cents: 5, messages: 1, through: null },
    ];
    const sales = new Map([["a", new Map([["2026-10", 1_000_000], ["2026-09", 1]])]]);
    const s = summarize(rows, ["2026-10"], sales, ["a"], new Map([["a", { HIKO: 0.6, GLUTA: 0.25, OTHER: 0.15 }]]));
    expect(s.branch.get("a")).toEqual({ spend: 120_000, messages: 40, sales: 1_000_000 });
    expect(s.line.get("a|HIKO")).toEqual({ spend: 100_000, messages: 30, sales: 600_000 });
    expect(s.line.get("a|GLUTA")?.sales).toBe(250_000);
    expect(s.line.get("a|OTHER")).toEqual({ spend: 0, messages: 0, sales: 150_000 });
    expect(s.total.spend).toBe(120_000);
  });
});

describe("sales sources", () => {
  const log = { id: "1", amount_paid_cents: 100, session_no: 1, promo_client_id: null, booking_id: "b" };
  it("a hand-set source wins, then package sessions, then the booking's channel", () => {
    expect(sourceOf(log, "REFERRAL", "FACEBOOK")).toEqual({ source: "REFERRAL", auto: false });
    expect(sourceOf({ ...log, session_no: 3 }, undefined, "FACEBOOK")).toEqual({ source: "RETURNING", auto: true });
    expect(sourceOf(log, undefined, "INSTAGRAM")).toEqual({ source: "AD", auto: true });
    expect(sourceOf(log, undefined, "WALK_IN")).toEqual({ source: "WALK_IN", auto: true });
    expect(sourceOf(log, undefined, "CALL")).toEqual({ source: null, auto: false });
  });
  it("ROAS from ad clients: exact when every source is known, estimated from the known part otherwise", () => {
    const all = summarizeSources([{ cents: 560_000, source: "AD", auto: true }, { cents: 440_000, source: "WALK_IN", auto: false }, { cents: 0, source: null, auto: false }]);
    expect(all).toMatchObject({ total: 1_000_000, known: 1_000_000, tagged: 440_000, auto: 560_000 });
    expect(adRoas(all, 100_000)).toEqual({ value: 5, coverage: 1, estimated: false });
    const half = summarizeSources([{ cents: 280_000, source: "AD", auto: false }, { cents: 220_000, source: "PAGE", auto: false }, { cents: 500_000, source: null, auto: false }]);
    expect(adRoas(half, 100_000)).toEqual({ value: 5, coverage: 0.5, estimated: true });
    expect(adRoas(summarizeSources([{ cents: 5, source: null, auto: false }]), 100)).toBeNull();
  });
  it("reads pasted SL numbers and source words, and lists what it couldn't read", () => {
    const r = parseSourceLines("SL-2611-0012 ad\nsl26110013, Walk-in\n  SL-2611-14 : referral \nSL-2611-0015 maybe\nhello\nSL-271126-001 ad\nsl 271126-12, returning\n\n");
    expect(r.rows).toEqual([
      { log_no: "SL-2611-0012", source: "AD" }, { log_no: "SL-2611-0013", source: "WALK_IN" }, { log_no: "SL-2611-0014", source: "REFERRAL" },
      { log_no: "SL-271126-001", source: "AD" }, { log_no: "SL-271126-012", source: "RETURNING" },
    ]);
    expect(r.bad).toEqual(["SL-2611-0015 maybe", "hello"]);
  });
});

describe("spend lines", () => {
  it("reads month, branch, service, pre-VAT pesos, chats and an optional last day", () => {
    const r = parseSpendLines("month, branch, service, pesos, chats\n2026-12, QC Main, Hiko, 95,000.50\n2026-1;FV;gluta;₱15000;400;2026-01-15\n2026-13, MK, Hiko, 1, 1\n2026-12, Mars, Hiko, 1, 1");
    expect(r.rows).toEqual([
      { month: "2026-12-01", branch: "QC_MAIN", service: "HIKO", spend_cents: 9_500_050, messages: 0, through: null },
      { month: "2026-01-01", branch: "FAIRVIEW", service: "GLUTA", spend_cents: 1_500_000, messages: 400, through: "2026-01-15" },
    ]);
    expect(r.bad).toHaveLength(2);
  });
});
