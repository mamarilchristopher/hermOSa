"use client";
// CHRIS Nov 26: show only the entries one staff member did (as Done by or Assisted by). Always starts at All staff.
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function StaffFilter({ choices, value }: { choices: { id: string; name: string }[]; value: string | null }) {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  return (
    <label className="staff-filter small">
      <span className="muted">Staff</span>
      <select value={value ?? ""} onChange={(e) => {
        const q = new URLSearchParams(params.toString());
        if (e.target.value) q.set("staff", e.target.value); else q.delete("staff");
        q.delete("entry");
        router.push(`${path}?${q.toString()}`, { scroll: false });
      }}>
        <option value="">All staff</option>
        {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}
