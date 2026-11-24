import { describe, expect, it } from "vitest";
import { branchShort, mondayOf, timeLabel, weekDates, weekLabel } from "../../src/lib/schedule";

describe("schedule helpers", () => {
  it("finds the Monday of a week", () => {
    expect(mondayOf("2026-11-25")).toBe("2026-11-23");
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
    expect(mondayOf("2026-11-29")).toBe("2026-11-23");
    expect(weekDates("2026-11-30")[6]).toBe("2026-12-06");
    expect(weekLabel("2026-11-30")).toBe("Nov 30 – Dec 6");
  });
  it("labels times and branches", () => {
    expect(timeLabel("10:00:00")).toBe("10 AM");
    expect(timeLabel("19:00")).toBe("7 PM");
    expect(timeLabel("12:30")).toBe("12:30 PM");
    expect(branchShort("Quezon City Main (Sikatuna)")).toBe("QC Main");
    expect(branchShort("Sta. Maria Bulacan")).toBe("Sta. Maria");
  });
});

import { shortNames } from "../../src/lib/schedule";
describe("short names", () => {
  it("uses first names and adds a last initial only when two share one", () => {
    expect(shortNames([{ id: "a", name: "Ana Cruz" }, { id: "b", name: "Bea Reyes" }, { id: "c", name: "Ana Lopez" }]))
      .toEqual({ a: "Ana C.", b: "Bea", c: "Ana L." });
  });
});

import { parseCoords } from "../../src/lib/schedule";
describe("parseCoords", () => {
  it("reads coordinates from pasted numbers and Google Maps links", () => {
    expect(parseCoords("14.6507, 121.0494")).toEqual({ lat: 14.6507, lng: 121.0494 });
    expect(parseCoords("https://www.google.com/maps/place/X/@14.65,121.04,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d14.6507!4d121.0494")).toEqual({ lat: 14.6507, lng: 121.0494 });
    expect(parseCoords("https://maps.google.com/?q=14.7,121.1")).toEqual({ lat: 14.7, lng: 121.1 });
    expect(parseCoords("https://maps.app.goo.gl/abc123")).toBeNull();
    expect(parseCoords("hello")).toBeNull();
  });
});
