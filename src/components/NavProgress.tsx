"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// v0.106.8 (CHRIS Nov 28): Hermosa OS moves between pages like an app. The page you're on stays on screen while the
// next one loads, under a see-through veil with a progress bar, instead of a blank "Loading…" screen. Plain links and
// search / filter forms move without a full page reload too.

const FILE = /\.(png|jpe?g|webp|gif|heic|avif|svg|pdf|csv|xlsx?|docx?|txt|zip|mp4|mov|json)$/i;
const SKIP = /^\/(auth|api)\//;

/** The internal page an <a> click goes to, or null when the browser should handle it (new tab, file, other site…). */
function pageTarget(e: MouseEvent): URL | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a || !a.hasAttribute("href")) return null;
  if (a.target && a.target !== "_self") return null;
  if (a.hasAttribute("download") || a.hasAttribute("data-newtab") || a.querySelector("img")) return null;
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#") || /^(mailto|tel|sms|javascript):/i.test(href)) return null;
  let u: URL;
  try { u = new URL(href, location.href); } catch { return null; }
  if (u.origin !== location.origin || SKIP.test(u.pathname) || FILE.test(u.pathname)) return null;
  return u;
}
const samePage = (u: URL) => u.pathname === location.pathname && u.search === location.search;

export function NavProgress() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The new page arrived (or Back / Forward): lift the veil.
  useEffect(() => { setBusy(false); if (timer.current) clearTimeout(timer.current); }, [path, params]);

  useEffect(() => {
    const start = () => {
      setBusy(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setBusy(false), 20000); // never leave it stuck
    };
    // Capture: every internal page tap (Next links and plain links) shows the veil at once.
    const tapStart = (e: MouseEvent) => { const u = pageTarget(e); if (u && !samePage(u)) start(); };
    // Bubble: a plain <a> that nothing else handled moves in-app instead of reloading the whole page.
    const tapRoute = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const u = pageTarget(e);
      if (!u) return;
      e.preventDefault();
      if (samePage(u)) { if (u.hash) location.hash = u.hash; return; }
      router.push(u.pathname + u.search + u.hash);
    };
    // Search and filter forms (GET) move in-app too. Saving forms (server actions, POST) are left alone.
    const submit = (e: SubmitEvent) => {
      if (e.defaultPrevented) return;
      const f = e.target as HTMLFormElement;
      const method = (f.getAttribute("method") ?? "get").toLowerCase();
      const action = f.getAttribute("action") ?? "";
      if (method !== "get" || action.startsWith("javascript:") || (f.target && f.target !== "_self")) return;
      let u: URL;
      try { u = new URL(action || location.pathname, location.href); } catch { return; }
      if (u.origin !== location.origin || SKIP.test(u.pathname)) return;
      const data = new FormData(f, e.submitter ?? undefined);
      const q = new URLSearchParams();
      data.forEach((v, k) => { if (typeof v === "string") q.append(k, v); });
      e.preventDefault();
      const next = `${u.pathname}${q.toString() ? `?${q}` : ""}`;
      if (next !== location.pathname + location.search) start();
      router.push(next);
    };
    document.addEventListener("click", tapStart, true);
    document.addEventListener("click", tapRoute);
    document.addEventListener("submit", submit);
    return () => {
      document.removeEventListener("click", tapStart, true);
      document.removeEventListener("click", tapRoute);
      document.removeEventListener("submit", submit);
    };
  }, [router]);

  return (
    <div className={`nav-progress${busy ? " on" : ""}`} aria-hidden={!busy} role="status" aria-live="polite">
      <div className="nav-progress-bar" />
      <div className="nav-progress-veil"><span className="nav-progress-pill"><span className="page-spinner" aria-hidden />{busy ? "Loading…" : ""}</span></div>
    </div>
  );
}
