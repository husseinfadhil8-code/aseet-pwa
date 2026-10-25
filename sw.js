const CACHE_NAME = "waseet-static-v49-server-paging-20261025";
const STATIC_FILES = ["./", "./index.html", "./app.js", "./market-data.js", "./paging-utils.js", "./chat.js", "./release-ui.js", "./vendor/supabase-2.118.0.js", "./marketplace.css", "./manifest.json", "./assets/waseet-icon.svg"];
const STATIC_URLS = new Set(STATIC_FILES.map(path=>new URL(path,self.location.href).href));
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(STATIC_FILES)));
});
// The browser activates the new worker when existing clients close. Do not force
// a live client to mix cached scripts from different releases.
self.addEventListener("activate",event=>event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(key=>key.startsWith("waseet-static-") && key!==CACHE_NAME).map(key=>caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);url.search="";url.hash="";
  // Never cache Auth, REST, Storage, messages, signed URLs or other private data.
  if(!STATIC_URLS.has(url.href))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    try{
      const response=await fetch(event.request);
      if(response.ok)await cache.put(url.href,response.clone());
      return response;
    }catch(error){return await cache.match(url.href) || Response.error();}
  })());
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
    icon: payload.icon || new URL("./assets/waseet-icon.svg", self.location.href).href,
    image: payload.image || undefined,
    badge: new URL("./assets/waseet-icon.svg", self.location.href).href,
    data: { url: payload.url || "./" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const requested = new URL(event.notification.data?.url || "./", self.location.href);
  const target = requested.origin === self.location.origin ? requested.href : new URL("./",self.location.href).href;
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
