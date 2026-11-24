"use client";
import { useRouter } from "next/navigation";

/** Owners and the general manager pick someone to see their Home (read only). */
export function ViewAsPicker({ people }: { people: { id: string; name: string; position: string | null }[] }) {
  const router = useRouter();
  if (people.length === 0) return null;
  return (
    <div className="card view-as">
      <div className="card-head">
        <h2>View as</h2>
        <select aria-label="View someone's Home" defaultValue="" onChange={(e) => e.target.value && router.push(`/me/view?u=${e.target.value}`)}>
          <option value="" disabled>Choose a staff member…</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.position ? ` · ${p.position}` : ""}</option>)}
        </select>
      </div>
      <p className="small muted" style={{ margin: 0 }}>See their Home and pending work exactly as the to-dos tell them. Read only.</p>
    </div>
  );
}
