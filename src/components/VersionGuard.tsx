"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

const MINE = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";
const KEY = "hermosa-reloaded-at";

/** Reload at most once a minute, so a broken deploy can't cause a reload loop. */
function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* no storage: still reload */ }
  window.location.reload();
}

async function check() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return;
    const { sha } = (await r.json()) as { sha?: string };
    if (sha && MINE !== "dev" && sha !== MINE) reloadOnce();
  } catch { /* offline or signed out: try again next time */ }
}

/**
 * When Hermosa OS is updated while a page is open, moving around the app can load the new pages
 * with the old page's files, and the screen loses its styling (plain blue links, giant logo).
 * This checks for a new version when you move to another page or come back to the app, and reloads
 * the page cleanly when there is one. A styling or script file that fails to load also triggers one reload.
 */
export function VersionGuard() {
  const path = usePathname();
  useEffect(() => { void check(); }, [path]);
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") void check(); };
    const onError = (e: Event) => {
      const t = e.target as HTMLElement | null;
      const url = t instanceof HTMLLinkElement ? t.href : t instanceof HTMLScriptElement ? t.src : "";
      if (url.includes("/_next/")) reloadOnce();
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("error", onError, true);
    return () => { document.removeEventListener("visibilitychange", onShow); window.removeEventListener("error", onError, true); };
  }, []);
  return null;
}
