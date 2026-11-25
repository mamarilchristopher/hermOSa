// Hermosapp service worker (v0.55): phone notifications only. Pages are never cached here, so every open gets the
// latest version of the app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const title = d.title || "Hermosapp";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "/app-icons/icon-192.png",
    badge: "/app-icons/icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || "/me" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/me", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); if ("navigate" in c) await c.navigate(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});
