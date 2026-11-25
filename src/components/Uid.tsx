/** A record's short UID (staff record ST-0001, login account AC-0001), update-0029. Select-all friendly for copying. */
export function Uid({ v, title }: { v: string | null | undefined; title?: string }) {
  if (!v) return null;
  return <span className="uid" title={title ?? (v.startsWith("AC-") ? "Login account UID" : "Staff record UID")}>{v}</span>;
}
