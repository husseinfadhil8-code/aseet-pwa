const CACHE_NAME = 'site-cache-v1';
const assets = [
  '/',
  '/index.html'
];

// تثبيت الـ Service Worker
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      cache.addAll(assets);
    })
  );
});

// جلب الملفات
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(response => {
      return response || fetch(e.request);
    })
  );
});
