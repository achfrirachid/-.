// Service Worker ديال "تتبع الطلبة"
// الهدف: يخلي التطبيق يخدم أوفلاين (بلا انترنت) ويولي قابل للتثبيت (Add to Home Screen) بشكل صحيح.
// ⚠️ بدّل هاد الرقم (CACHE_VERSION) كل مرة تبدل فيها index.html، باش الهاتف يجيب النسخة الجديدة
const CACHE_VERSION = 'v2';
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

// ==================================================================
// ---- مزامنة من الخلفية (Background Sync) — كتخدم حتى لو التطبيق مسكر بالكامل ----
// المبدأ: index.html كيسجل طلب "مزامنة" (registration.sync.register) فكل مرة تتبدل
// فيها بيانات الطلبة. نظام أندرويد كيخزن هاد الطلب، وبمجرد ما الهاتف يرجع يتصل بالنت
// (فأي مكان، حتى ولو التطبيق مسكر من زمان) كيوقظ هاد الملف (sw.js) وحدو ويخلينا
// نصيفطو البيانات. هادشي كيخدم غير فـ Chrome/أندرويد (Safari/آيفون ماكيدعمهاش بعد).
// ⚠️ Service Worker ماكيقدرش يقرا localStorage خالص، غير IndexedDB — لهذا index.html
// كيحط نسخة مبسطة من التوكنات فـ IndexedDB (مفتاح cloudSyncConfigV1) قبل كل عملية حفظ.
// ⚠️ Firebase وGoogle Drive/Sheet/Gmail ماشي هنا: التوكن ديالهم كيعتمد على تسجيل دخول
// Google اللي محتاج التطبيق يكون مفتوح باش يتجدد — هادوك كيبقاو يتصيفطو غير ملي
// تفتح التطبيق ورانا متصلين بالنت (بحال قبل).
const CLOUD_SYNC_IDB_NAME = 'studentTrackerDB';
const CLOUD_SYNC_IDB_STORE = 'kv';
const CLOUD_SYNC_CFG_KEY = 'cloudSyncConfigV1';

function cloudSyncIdbGet(key){
  return new Promise((resolve) => {
    try{
      const req = indexedDB.open(CLOUD_SYNC_IDB_NAME);
      req.onsuccess = () => {
        const db = req.result;
        try{
          if(!db.objectStoreNames.contains(CLOUD_SYNC_IDB_STORE)){ resolve(null); return; }
          const tx = db.transaction(CLOUD_SYNC_IDB_STORE, 'readonly');
          const r = tx.objectStore(CLOUD_SYNC_IDB_STORE).get(key);
          r.onsuccess = () => {
            if(!r.result){ resolve(null); return; }
            try{ resolve(JSON.parse(r.result)); }catch(_){ resolve(null); }
          };
          r.onerror = () => resolve(null);
        }catch(e){ resolve(null); }
      };
      req.onerror = () => resolve(null);
    }catch(e){ resolve(null); }
  });
}

function utf8ToB64Sw(str){
  return btoa(unescape(encodeURIComponent(str)));
}

async function backgroundCloudSync(){
  const cfg = await cloudSyncIdbGet(CLOUD_SYNC_CFG_KEY);
  if(!cfg || !cfg.profileKey) return;
  const students = await cloudSyncIdbGet(cfg.profileKey);
  if(!Array.isArray(students) || students.length === 0) return;

  const jobs = [];
  const jsonPretty = JSON.stringify(students, null, 2);

  // Supabase — توكن عام ثابت، بلا تسجيل دخول
  if(cfg.supabase && cfg.supabase.uid){
    jobs.push(fetch(`${cfg.supabase.url}/rest/v1/backup?on_conflict=uid`, {
      method: 'POST',
      headers: {
        'apikey': cfg.supabase.key,
        'Authorization': 'Bearer ' + cfg.supabase.key,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ uid: cfg.supabase.uid, data: JSON.stringify(students) })
    }).catch(() => {}));
  }

  // Telegram — بوت توكن ثابت
  if(cfg.telegram && cfg.telegram.botToken && cfg.telegram.chatId){
    const fd = new FormData();
    fd.append('chat_id', cfg.telegram.chatId);
    fd.append('document', new Blob([jsonPretty], { type: 'application/json' }), 'backup-talaba-auto.json');
    fd.append('caption', '🔄 مزامنة تلقائية من الخلفية (بلا فتح التطبيق)');
    jobs.push(fetch('https://api.telegram.org/bot' + cfg.telegram.botToken + '/sendDocument', {
      method: 'POST', body: fd
    }).catch(() => {}));
  }

  // GitHub — Personal Access Token ثابت
  if(cfg.github && cfg.github.token && cfg.github.url){
    jobs.push((async () => {
      try{
        const headers = { 'Authorization': 'Bearer ' + cfg.github.token, 'Accept': 'application/vnd.github+json' };
        let sha = '';
        const getRes = await fetch(cfg.github.url + '?ref=' + encodeURIComponent(cfg.github.branch || 'main'), { headers });
        if(getRes.status === 200){ const gj = await getRes.json(); sha = gj.sha || ''; }
        const body = {
          message: 'مزامنة تلقائية من الخلفية — ' + new Date().toISOString(),
          content: utf8ToB64Sw(jsonPretty),
          branch: cfg.github.branch || 'main'
        };
        if(sha) body.sha = sha;
        await fetch(cfg.github.url, {
          method: 'PUT',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify(body)
        });
      }catch(e){ /* صامت */ }
    })());
  }

  // Dropbox — توكن دائم ثابت
  if(cfg.dropbox && cfg.dropbox.token && cfg.dropbox.path){
    jobs.push(fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.dropbox.token,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: cfg.dropbox.path, mode: 'overwrite', mute: true })
      },
      body: jsonPretty
    }).catch(() => {}));
  }

  // WhatsApp (Green API) — توكن ثابت. من الخلفية كنصيفطو ملف JSON بسيط (بلا تنسيق Word)
  // باش نتفادو بناء الملف المنسق داخل Service Worker.
  if(cfg.whatsapp && cfg.whatsapp.idInstance && cfg.whatsapp.token && cfg.whatsapp.chatId){
    const fd2 = new FormData();
    fd2.append('chatId', cfg.whatsapp.chatId);
    fd2.append('file', new Blob([jsonPretty], { type: 'application/json' }), 'backup-talaba-auto.json');
    fd2.append('caption', '🔄 مزامنة تلقائية من الخلفية (JSON)');
    jobs.push(fetch(`https://api.green-api.com/waInstance${cfg.whatsapp.idInstance}/sendFileByUpload/${cfg.whatsapp.token}`, {
      method: 'POST', body: fd2
    }).catch(() => {}));
  }

  // Appwrite — بلا تسجيل دخول ولا مفتاح سري، غير Project ID ثابت
  if(cfg.appwrite && cfg.appwrite.docUrl){
    jobs.push((async () => {
      try{
        const headers = { 'Content-Type': 'application/json', 'X-Appwrite-Project': cfg.appwrite.projectId };
        let res = await fetch(cfg.appwrite.docUrl, {
          method: 'PATCH', headers,
          body: JSON.stringify({ data: { data: jsonPretty } })
        });
        if(res.status === 404){
          await fetch(cfg.appwrite.collectionUrl, {
            method: 'POST', headers,
            body: JSON.stringify({ documentId: cfg.appwrite.docId, data: { data: jsonPretty }, permissions: ['read("any")', 'update("any")'] })
          });
        }
      }catch(e){ /* صامت */ }
    })());
  }

  await Promise.allSettled(jobs);
}

self.addEventListener('sync', (event) => {
  if(event.tag === 'cloud-sync-v1'){
    event.waitUntil(backgroundCloudSync());
  }
});
