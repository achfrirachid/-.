// sw.js — Talaaba (تتبع دفوعات الطلبة)
// خاصو يكون فنفس المجلد ديال index.html و manifest.json والأيقونات

const CACHE_VERSION = 'talaaba-v1'; // بدّل هاد الرقم (v2, v3...) كل مرة كتبدل index.html باش تتحدث الكاش عند المستخدمين
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-180.png',
  './favicon-32.png'
];

// ---- INSTALL: نخزنو الملفات الأساسية فالكاش ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // نخبيو كل ملف على حدة باش إلا واحد منهم ماكاينش (404) ما يوقفش الباقي
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('SW: ماقدرتش نخبي', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// ---- ACTIVATE: نمسحو الكاش القديم ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ---- استقبال أمر SKIP_WAITING من index.html (كاين ديجا فالكود ديالك) ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---- FETCH: نتعاملو غير مع الملفات ديال نفس الموقع (same-origin) ----
// روابط Firebase / Google / Supabase كيخليوها تمشي للنت normal، وإلا ماكانش نت غادي تفشل وحدها
// (الكود ديال index.html ديجا كيتعامل مع هادشي بـ navigator.onLine و try/catch)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // غير GET requests، وغير same-origin
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      // Cache-first: إلا كاين فالكاش نعطيوه مباشرة (خفيف وسريع، وخدام بلا نت)
      const networkFetch = fetch(req)
        .then((res) => {
          // نحدثو الكاش بالنسخة الجديدة من النت (باش تبقى محينة)
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached); // إلا ماكانش نت، نرجعو للكاش

      return cached || networkFetch;
    })
  );
});
