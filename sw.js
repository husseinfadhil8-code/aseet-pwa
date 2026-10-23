const CACHE_NAME = "waseet-static-v12-fixed-usernames";

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    return Response.error();
  }));
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : "لديك تحديث جديد في تطبيق وسيط" };
  }
  event.waitUntil(self.registration.showNotification(String(payload.title || "وسيط"), {
    body: String(payload.body || "لديك تحديث جديد"),
    dir: "rtl",
    lang: "ar",
    tag: String(payload.tag || "waseet-update"),
    icon: new URL("./assets/waseet-icon.svg", self.location.href).href,
    badge: new URL("./assets/waseet-icon.svg", self.location.href).href,
    data: { url: payload.url || "./" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.href).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        if ("navigate" in client && client.url !== target) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});