/** A round profile picture, or the person's initials when they have no approved photo yet. */
export function Avatar({ name, url, size = 36, className = "" }: { name: string; url?: string | null; size?: number; className?: string }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.34)) };
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img className={`avatar photo ${className}`} src={url} alt="" style={style} /> : <span className={`avatar ${className}`} style={style} aria-hidden>{initials}</span>;
}
