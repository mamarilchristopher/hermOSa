import { expect, it } from "vitest";
import { testResult, testProblems, TEST_OK } from "../../src/lib/serviceTest";
import { isTestService, sortServices } from "../../src/lib/serviceOrder";
const full = [{ kind: "BEFORE" }, { kind: "AFTER" }, { kind: "WAIVER" }, { kind: "WAIVER" }];
it("passes a complete Solo test for commission-based staff", () => {
  expect(testResult({ kind: "PAID", cents: 10000, type: "SOLO", eligible: true, photos: full, photosDue: false })).toBe(TEST_OK);
});
it("passes for non-commission staff whatever the type", () => {
  expect(testResult({ kind: "PAID", cents: 10000, type: "SOLO", eligible: false, photos: full, photosDue: false })).toBe(TEST_OK);
  expect(testResult({ kind: "PAID", cents: 10000, type: "NONCOMMI", eligible: false, photos: full, photosDue: false })).toBe(TEST_OK);
});
it("lists what's missing", () => {
  expect(testProblems({ kind: "PAID", cents: 5000, type: "LEAD", eligible: true, photos: [{ kind: "WAIVER" }], photosDue: false }))
    .toEqual(["enter 100 as the amount paid", "choose Solo commission (you're commission-based)", "add a before photo", "add an after photo", "add both waiver pages"]);
});
it("TEST Service is first and recognised", () => {
  expect(sortServices([{ name: "Hiko Deluxe" }, { name: "TEST Service" }])[0].name).toBe("TEST Service");
  expect(isTestService("Test service")).toBe(true);
  expect(isTestService("Hiko Deluxe")).toBe(false);
});
