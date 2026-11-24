"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

type Person = { name: string; last_seen: string };

/**
 * Checks this person in about once a minute while the app is open and in view. For owners and managers it
 * also shows a strip on every page: "Online now: Geraldine, Jesel" (or "none"), refreshed every 30 seconds.
 */
export function OnlineNow({ show }: { show: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [people, setPeople] = useState<Person[] | null>(null);

  useEffect(() => {
    let stop = false;
    const visible = () => document.visibilityState === "visible";
    const touch = () => { if (visible()) supabase.rpc("touch_presence").then(() => undefined, () => undefined); };
    const load = async () => {
      if (!show || !visible()) return;
      const { data, error } = await supabase.rpc("online_now");
      if (!stop && !error && Array.isArray(data)) setPeople(data as Person[]);
    };
    touch(); load();
    const a = setInterval(touch, 60_000);
    const b = setInterval(load, 30_000);
    const onVis = () => { if (visible()) { touch(); load(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(a); clearInterval(b); document.removeEventListener("visibilitychange", onVis); };
  }, [supabase, show]);

  if (!show || people === null) return null;
  return (
    <div className="online-strip" role="status" aria-live="polite">
      <span className={`online-dot ${people.length ? "on" : ""}`} aria-hidden />
      <strong>Online now:</strong>
      {people.length === 0 ? <span className="muted">none</span> : people.map((p) => <span key={p.name} className="online-name">{p.name}</span>)}
    </div>
  );
}
