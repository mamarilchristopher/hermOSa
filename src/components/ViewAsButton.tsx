"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Person = { id: string; name: string; position: string | null };

/** Small "View as" button in the top strip (desktop and phone): pick someone to see their Home, read only. */
export function ViewAsButton({ people }: { people: Person[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (people.length === 0) return null;
  return (
    <div className="view-as-btn" ref={box}>
      <button type="button" className="secondary small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
        </svg>
        View as
      </button>
      {open && (
        <div className="view-as-menu" role="menu">
          <span className="small muted">See someone&apos;s Home and pending work (read only)</span>
          {people.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="view-as-item" onClick={() => { setOpen(false); router.push(`/me/view?u=${p.id}`); }}>
              <strong>{p.name}</strong>{p.position && <span className="small muted">{p.position}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
