/** Save or copy a canvas drawn in the browser (promo images, client schedules): saved as JPEG, copied as PNG. */
export const COPY_FAIL = "This browser can't copy photos. Use Save as photo instead.";
export const fontsOf = async (serif: string) => {
  await document.fonts.load(`700 80px ${serif}`).catch(() => null);
  await document.fonts.ready;
  return { sans: getComputedStyle(document.body).fontFamily || "sans-serif", serif };
};
const pngOf = (c: HTMLCanvasElement) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/png"));
/** Saved photos (CHRIS Nov 27): high-quality JPEG at the exact Meta sizes (1080x1350 post, 1080x1920 story).
 *  Facebook and Instagram re-compress big PNGs harder, so a 95% JPEG keeps text and faces sharpest after upload. */
const jpgOf = (c: HTMLCanvasElement) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/jpeg", 0.95));
const jpgName = (name: string) => name.replace(/\.(png|jpe?g)$/i, "") + ".jpg";

/** A ready-to-save photo file, made ahead of the tap so iPhone keeps the tap "fresh" for the share sheet. */
export async function photoFile(c: HTMLCanvasElement | Promise<HTMLCanvasElement>, name: string): Promise<File> {
  return new File([await jpgOf(await c)], jpgName(name), { type: "image/jpeg" });
}

/** Phones and tablets (touch screens) get the share sheet, where "Save Image" puts the photo straight in Photos / Gallery. */
const phoneShare = (f: File) =>
  typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [f] })
  && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

function download(f: File) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(f);
  a.download = f.name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Save as photo: share sheet on phones (Save Image = Photos), a normal download on PC. Returns "cancelled" if the person closed the sheet. */
export async function savePhoto(f: File): Promise<"saved" | "cancelled"> {
  if (phoneShare(f)) {
    try { await navigator.share({ files: [f] }); return "saved"; }
    catch (e) {
      if ((e as Error)?.name === "AbortError") return "cancelled";
      // NotAllowedError (the tap went stale) or no share support: fall back to a download.
    }
  }
  download(f);
  return "saved";
}

export async function saveCanvas(c: Promise<HTMLCanvasElement>, name: string) {
  return savePhoto(await photoFile(c, name));
}
/** Safari needs the clipboard write to start right away, so it gets a promise of the image. */
export async function copyCanvas(c: Promise<HTMLCanvasElement>): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": c.then(pngOf) })]);
    return true;
  } catch { return false; }
}

