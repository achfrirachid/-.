// Service Worker ديال "تتبع الطلبة"
// الهدف: يخلي التطبيق يخدم أوفلاين (بلا انترنت) ويولي قابل للتثبيت (Add to Home Screen) بشكل صحيح.
// ⚠️ بدّل هاد الرقم (CACHE_VERSION) كل مرة تبدل فيها index.html، باش الهاتف يجيب النسخة الجديدة
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'tatbi3-taliba-' + CACHE_VERSION;

// الملفات الأساسية لي خاصها تبقى محفوظة محليا باش يخدم التطبيق حتى بلا نت
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(()=>{})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// إستراتيجية: نجربو الشبكة أولا (باش نجيبو آخر نسخة إيلا كان نت)، وإيلا فشلت (أوفلاين)
// كنرجعو للنسخة المحفوظة محليا. هادشي كيخلي التطبيق يخدم فكلتا الحالتين.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(()=>{});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

// كي كنبعتو SKIP_WAITING من index.html (ملي تلقى نسخة جديدة)، نفعلوها مباشرة
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
