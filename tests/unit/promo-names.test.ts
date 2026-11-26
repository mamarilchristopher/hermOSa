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
