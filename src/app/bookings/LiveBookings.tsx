"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

/** update-0081 (CHRIS Nov 26): Bookings is a live board. Whenever anyone changes a booking (Arrived, Done,
 *  Unresponsive, a new booking, a follow-up), every open Bookings page reloads its data by itself. */
export function LiveBookings() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [live, setLive] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const refresh = () => { if (t.current) clearTimeout(t.current); t.current = setTimeout(() => router.refresh(), 400); };
    const ch = supabase.channel("bookings-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, refresh)
      .subscribe((s) => setLive(s === "SUBSCRIBED"));
    // Back on the page after the phone slept: catch up at once.
    const wake = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", wake);
    return () => { document.removeEventListener("visibilitychange", wake); if (t.current) clearTimeout(t.current); void supabase.removeChannel(ch); };
  }, [supabase, router]);
  return <span className={`live-dot ${live ? "on" : ""}`} title={live ? "Updates by itself when anyone changes a booking" : "Connecting…"}>{live ? "Live" : "Connecting…"}</span>;
}
