import { describe, expect, it } from "vitest";
import { photoGapMinutes, photoTakenAt } from "../../src/lib/exif";

/** A minimal JPEG: SOI + APP1 Exif (IFD0 -> Exif IFD with DateTimeOriginal [+ OffsetTimeOriginal]) + SOS. */
function jpeg(date: string, opts: { be?: boolean; offset?: string } = {}): ArrayBuffer {
  const le = !opts.be;
  const tiff: number[] = [];
  const u16 = (n: number) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n: number) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const str = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const entries = opts.offset ? 2 : 1;
  const ifd0 = 8, exifIfd = ifd0 + 2 + 12 + 4, data = exifIfd + 2 + 12 * entries + 4;
  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0));
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfd), ...u32(0));
  tiff.push(...u16(entries), ...u16(0x9003), ...u16(2), ...u32(20), ...u32(data));
  if (opts.offset) tiff.push(...u16(0x9011), ...u16(2), ...u32(7), ...u32(data + 20));
  tiff.push(...u32(0), ...str(date));
  if (opts.offset) tiff.push(...str(opts.offset));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const bytes = [0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2];
  return new Uint8Array(bytes).buffer;
}

describe("photo taken time", () => {
  it("reads DateTimeOriginal as Manila time", () => {
    expect(photoTakenAt(jpeg("2026:11:25 09:58:30"))).toBe("2026-11-25T01:58:30.000Z");
  });
  it("reads big-endian files and an explicit offset", () => {
    expect(photoTakenAt(jpeg("2026:11:25 09:58:30", { be: true, offset: "+00:00" }))).toBe("2026-11-25T09:58:30.000Z");
  });
  it("returns null for non-JPEGs, missing or blank dates", () => {
    expect(photoTakenAt(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
    expect(photoTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeNull();
    expect(photoTakenAt(jpeg("0000:00:00 00:00:00"))).toBeNull();
  });
  it("measures the gap to the server time", () => {
    expect(photoGapMinutes("2026-11-25T02:00:00Z", "2026-11-25T01:58:30Z")).toBe(2);
    expect(photoGapMinutes("2026-11-25T02:00:00Z", null)).toBeNull();
  });
});
