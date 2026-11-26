/** Save or copy a canvas drawn in the browser as a PNG (promo images, client schedules). */
export const COPY_FAIL = "This browser can't copy photos. Use Save as photo instead.";
export const fontsOf = async (serif: string) => {
  await document.fonts.load(`700 80px ${serif}`).catch(() => null);
  await document.fonts.ready;
  return { sans: getComputedStyle(document.body).fontFamily || "sans-serif", serif };
};
const pngOf = (c: HTMLCanvasElement) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/png"));
export async function saveCanvas(c: Promise<HTMLCanvasElement>, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await pngOf(await c));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/** Safari needs the clipboard write to start right away, so it gets a promise of the image. */
export async function copyCanvas(c: Promise<HTMLCanvasElement>): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": c.then(pngOf) })]);
    return true;
  } catch { return false; }
}

