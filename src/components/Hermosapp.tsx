"use client";
// Hermosapp (v0.55, CHRIS Nov 26): installable app + phone notifications.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { VAPID_PUBLIC_KEY } from "@/lib/pushConfig";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallEvent; window.dispatchEvent(new Event("hermosapp-installable")); });
}

export function RegisterSW() {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}

const keyBytes = (s: string) => {
  const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
};
const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/** Turn on phone notifications for this device. Must run from a tap. */
async function subscribe(): Promise<string | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "This phone or browser can't show notifications.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications are blocked. Allow them for Hermosapp in your phone's Settings, then try again.";
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) as BufferSource }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const device = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Computer";
  const { data, error } = await createClient().rpc("push_subscribe", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_device: device });
  if (error || !data?.ok) return "Couldn't turn on notifications. Try again.";
  return null;
}

export function HermosappCard() {
  const [state, setState] = useState<{ standalone: boolean; ios: boolean; push: boolean; perm: string; installable: boolean; subscribed: boolean; phone: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const check = async () => {
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      // CHRIS Nov 26: offer "Install" on phones and tablets only, never on PCs.
      const phone = ios || /Android|Mobile/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
      const push = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      let subscribed = false;
      if (push && Notification.permission === "granted") {
        const reg = await navigator.serviceWorker.getRegistration("/");
        subscribed = !!(await reg?.pushManager.getSubscription());
      }
      setState({ standalone, ios, push, perm: push ? Notification.permission : "unsupported", installable: !!deferred, subscribed, phone });
    };
    void check();
    const on = () => void check();
    window.addEventListener("hermosapp-installable", on);
    const until = Number(ls.get("hermosapp-later") ?? 0);
    if (until > Date.now()) setHidden(true);
    return () => window.removeEventListener("hermosapp-installable", on);
  }, []);
  if (!state || hidden) return null;
  const needInstall = state.phone && !state.standalone && (state.installable || state.ios);
  // iPhones only allow notifications once Hermosapp is on the home screen.
  const canNotify = state.push && state.perm !== "denied" && !state.subscribed && (!state.ios || state.standalone);
  if (!needInstall && !canNotify) return null;

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const r = await deferred.userChoice; deferred = null;
    if (r.outcome === "accepted") setState({ ...state, installable: false, standalone: true });
  };
  const notify = async () => {
    setBusy(true); setMsg(null);
    const err = await subscribe().catch(() => "Couldn't turn on notifications. Try again.");
    setBusy(false);
    if (err) setMsg(err); else setState({ ...state, subscribed: true, perm: "granted" });
  };
  return (
    <div className="card hermosapp-card">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/app-icons/icon-192.png" alt="" className="hermosapp-icon" />
      <div className="hermosapp-text">
        {needInstall ? (
          <>
            <strong>Get Hermosapp on your phone</strong>
            {state.ios ? (
              <span className="small">In Safari, tap <b>Share</b> <span aria-hidden>⬆︎</span> at the bottom, then <b>Add to Home Screen</b>, then <b>Add</b>. Open Hermosapp from your home screen to turn on notifications.</span>
            ) : (
              <span className="small">One tap puts Hermosapp on your home screen. It opens full screen and can send you notifications.</span>
            )}
          </>
        ) : (
          <>
            <strong>Turn on phone notifications</strong>
            <span className="small">Get chat messages, urgent reminders and approvals on your phone, even when Hermosapp is closed.</span>
          </>
        )}
        {msg && <span className="small" style={{ color: "var(--bad)" }}>{msg}</span>}
        <div className="fill-row">
          {needInstall && !state.ios && <button type="button" className="small" onClick={install}>Install Hermosapp</button>}
          {!needInstall && canNotify && <button type="button" className="small" onClick={notify} disabled={busy}>{busy ? "Turning on…" : "Turn on notifications"}</button>}
          <button type="button" className="secondary small" onClick={() => { ls.set("hermosapp-later", String(Date.now() + 7 * 864e5)); setHidden(true); }}>Not now</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Timed-in staff must have phone notifications on (CHRIS Nov 26: "Red reminder only").
 * A red bar that can't be closed stays on every page until this device is subscribed.
 */
export function NotifyRequired() {
  const [s, setS] = useState<"ok" | "ask" | "denied" | "install" | "unsupported" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      const push = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!push) { setS(ios && !standalone ? "install" : "unsupported"); return; }
      if (Notification.permission === "denied") { setS("denied"); return; }
      if (Notification.permission === "granted") {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (await reg?.pushManager.getSubscription()) { setS("ok"); return; }
      }
      setS("ask");
    };
    void check();
    const on = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  if (!s || s === "ok") return null;
  const turnOn = async () => {
    setBusy(true); setMsg(null);
    const err = await subscribe().catch(() => "Couldn't turn on notifications. Try again.");
    setBusy(false);
    if (err) setMsg(err); else setS("ok");
  };
  return (
    <div className="notify-required" role="status">
      <span className="nr-text">
        <span aria-hidden>🔔</span> <b>Notifications are required while timed in.</b>{" "}
        {s === "denied" && "They're blocked: allow them in your phone's Settings › Notifications."}
        {s === "install" && <>Add Hermosapp to your Home Screen first (Safari › Share › Add to Home Screen).</>}
        {s === "unsupported" && "This phone can't get them. Update it or use Chrome."}
        {msg && <span className="nr-msg"> {msg}</span>}
      </span>
      {s === "ask" && <button type="button" className="small" onClick={turnOn} disabled={busy}>{busy ? "Turning on…" : "Turn on"}</button>}
    </div>
  );
}
