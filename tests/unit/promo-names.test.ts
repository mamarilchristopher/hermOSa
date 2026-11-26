import { describe, expect, it } from "vitest";
import { adName, adNameLong, captions } from "../../src/lib/promoRules";

// CHRIS Nov 27: internal Service log labels never reach a client-facing photo or caption.
describe("client-facing service names", () => {
  it("drops internal labels and reads like an ad", () => {
    expect(adName("Lux Queen Single Session")).toBe("Lux Queen Drip");
    expect(adName("Illumina (Single Session)")).toBe("Illumina Drip");
    expect(adName("Hifu Back Fat")).toBe("HIFU Back");
    expect(adName("Diode Underarms")).toBe("Diode Laser Underarm");
    expect(adName("Signature facial")).toBe("Signature Facial");
    expect(adName("Lux Queen 10+3")).toBe("Lux Queen Drip");
  });
  it("calls out best sellers", () => {
    expect(adNameLong("Lux Queen Single Session")).toBe("our best-selling Lux Queen Drip");
    expect(adNameLong("Hifu Tummy")).toBe("HIFU Tummy");
  });
  it("keeps internal labels out of captions", () => {
    const c = captions({ title: "Glow", items: [{ service_id: "a", name: "Lux Queen Single Session", unit: 300000, paid: 10, free: 3 }], price: 2000000, months: 3 });
    expect(c.story + c.feed).not.toMatch(/single session/i);
    expect(c.feed).toContain("10 + 3 FREE sessions of our best-selling Lux Queen Drip");
  });
});

import { defaultPrice, justify, vsChip } from "../../src/lib/promoRules";
// CHRIS Nov 27: discounts are measured against our current package prices, not the single price.
describe("promo price vs current packages", () => {
  const lux = { service_id: "lq", name: "Lux Queen Single Session", unit: 200000, paid: 10, free: 3 };
  const pkgs = [{ name: "Lux Queen 10+3", total: 2000000 }];
  it("prices a bundle about 5% under the package", () => {
    expect(defaultPrice([lux], pkgs)).toBe(1899900);
  });
  it("compares with the package, not the single price", () => {
    const j = justify([lux], 1899900, { pkgs });
    expect(Math.round(j.off * 100)).toBe(5);
    expect(j.deep).toBe(false);
    expect(j.headline).toMatch(/^5% below your Lux Queen 10\+3 price/);
    expect(vsChip(j.off, j.basis)).toBe("5% below Lux Queen 10+3");
  });
  it("still flags a deep cut", () => {
    expect(justify([lux], 1500000, { pkgs }).deep).toBe(true);
  });
  it("falls back to single prices with no package", () => {
    const j = justify([{ ...lux, name: "Hifu Arms", paid: 3, free: 1 }], 600000, {});
    expect(j.basis).toBe("single prices");
    expect(Math.round(j.off * 100)).toBe(25);
  });
});
