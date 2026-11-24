/**
 * Reads when a JPEG photo was taken from its EXIF data (DateTimeOriginal, else DateTime), as an ISO time.
 * Phones store local time with no zone unless OffsetTimeOriginal is set; we assume Manila (+08:00) then.
 * Returns null for anything that isn't a JPEG with a readable date. Never throws.
 */
export function photoTakenAt(buf: ArrayBuffer, defaultOffset = "+08:00"): string | null {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      const marker = v.getUint16(p);
      if ((marker & 0xff00) !== 0xff00) return null;
      const size = v.getUint16(p + 2);
      if (marker === 0xffe1 && size >= 8 && v.getUint32(p + 4) === 0x45786966) return readTiff(v, p + 10, defaultOffset); // "Exif"
      if (marker === 0xffda) return null; // image data starts: no EXIF
      p += 2 + size;
    }
    return null;
  } catch {
    return null;
  }
}

function readTiff(v: DataView, t: number, defaultOffset: string): string | null {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o: number) => v.getUint16(t + o, le);
  const u32 = (o: number) => v.getUint32(t + o, le);
  const ascii = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) { const c = v.getUint8(t + o + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  };
  const tags = (ifd: number) => {
    const out = new Map<number, string | number>();
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2) out.set(tag, ascii(count <= 4 ? e + 8 : u32(e + 8), count));
      else if (type === 4) out.set(tag, u32(e + 8));
    }
    return out;
  };
  const ifd0 = tags(u32(4));
  const exifPtr = ifd0.get(0x8769);
  const exif = typeof exifPtr === "number" ? tags(exifPtr) : new Map<number, string | number>();
  const raw = (exif.get(0x9003) ?? ifd0.get(0x0132)) as string | undefined;
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return null;
  const off = exif.get(0x9011);
  const zone = typeof off === "string" && /^[+-]\d{2}:\d{2}$/.test(off) ? off : defaultOffset;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

/** Minutes between the server's time-in and the photo's own time, or null if the photo had none. */
export function photoGapMinutes(punchedAt: string, takenAt: string | null): number | null {
  if (!takenAt) return null;
  return Math.round(Math.abs(Date.parse(punchedAt) - Date.parse(takenAt)) / 60000);
}
