import { expect, it } from "vitest";
import { sortServices } from "../../src/lib/serviceOrder";
it("lists services in CHRIS's order; new ones after, A to Z", () => {
  const got = sortServices([{ name: "Zeta New" }, { name: "Barbie Arms Trio" }, { name: "hiko pro" }, { name: "Alpha New" }, { name: "Hiko Deluxe" }, { name: "Ultra VLift" }, { name: "Fillers" }]);
  expect(got.map((x) => x.name)).toEqual(["Hiko Deluxe", "hiko pro", "Ultra VLift", "Barbie Arms Trio", "Fillers", "Alpha New", "Zeta New"]);
});
