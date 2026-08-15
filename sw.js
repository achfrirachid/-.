// Service Worker ديال "تتبع الطلبة"
// الهدف: يخلي التطبيق يخدم أوفلاين (بلا انترنت) ويولي قابل للتثبيت (Add to Home Screen) بشكل صحيح.
// ⚠️ بدّل هاد الرقم (CACHE_VERSION) كل مرة تبدل فيها index.html، باش الهاتف يجيب النسخة الجديدة
const CACHE_VERSION = 'v5';
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

// ---- نفس منطق حساب حالة الشهر (خالص/ماخلصش) المستعمل فـ index.html (getPaymentStatusForCalendarMonth) ----
const SW_TOTAL_MONTHS = 10;
const SW_ACADEMIC_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6]; // من شتنبر (9) لغاية يونيو (6)
function swAddMonths(dateStr, n){
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d;
}
function swMonthStatus(s, targetMonth){
  const paidMonths = s.paidMonths || Array(SW_TOTAL_MONTHS).fill(false);
  const today = new Date();
  for(let i=0;i<SW_TOTAL_MONTHS;i++){
    const d = swAddMonths(s.startDate, i);
    if(d.getMonth() + 1 === targetMonth){
      if(paidMonths[i]) return '✅'; // خالص = علامة خضراء
      return d <= today ? '❌' : '—';
    }
  }
  return '—';
}
function swIsoToDisplay(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}
// كنبنيو نفس تقرير الطلبة اللي ديجا خدام فالتطبيق (نفس الأعمدة بالضبط: الاسم الكامل،
// يوم الالتحاق، شهر 9، 10، 11، 12، 1، 2، 3، 4، 5، 6) — بلا زيادة ولا نقصان من عندنا،
// غير مبني كجدول نصي (monospace) باش يبان منظم فالواتساب وتيليجرام.
function buildAutoReportText(students){
  const now = new Date().toLocaleString('ar-EG');
  const header = ['الاسم الكامل', 'يوم الالتحاق', ...SW_ACADEMIC_MONTHS.map(m => 'شهر ' + m)];
  const rows = students.map(s => [
    s.name || '',
    swIsoToDisplay(s.startDate),
    ...SW_ACADEMIC_MONTHS.map(m => swMonthStatus(s, m))
  ]);
  const nameW = Math.max(header[0].length, ...rows.map(r => r[0].length), 12);
  const dateW = Math.max(header[1].length, ...rows.map(r => r[1].length), 10);
  const line = (r) => r[0].padEnd(nameW) + ' | ' + r[1].padEnd(dateW) + ' | ' + SW_ACADEMIC_MONTHS.map((m,i) => r[2+i]).join('  ');
  let table = '```\n' + line(header) + '\n' + rows.map(line).join('\n') + '\n```';
  return `📋 تقرير الطلبة — سجل الدفوعات\n🕒 ${now} | عدد الطلبة: ${students.length}\n\n${table}`;
}

// ---- كتابة فـ IndexedDB (نظيرة cloudSyncIdbGet للقراءة) ----
function cloudSyncIdbSet(key, value){
  return new Promise((resolve) => {
    try{
      const req = indexedDB.open(CLOUD_SYNC_IDB_NAME);
      req.onsuccess = () => {
        const db = req.result;
        try{
          if(!db.objectStoreNames.contains(CLOUD_SYNC_IDB_STORE)){ resolve(false); return; }
          const tx = db.transaction(CLOUD_SYNC_IDB_STORE, 'readwrite');
          tx.objectStore(CLOUD_SYNC_IDB_STORE).put(JSON.stringify(value), key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        }catch(e){ resolve(false); }
      };
      req.onerror = () => resolve(false);
    }catch(e){ resolve(false); }
  });
}

// ============================================================
// 🗄️ الأرشيف (الصندوق الأسود) — من الخلفية (sw.js)
// يخدم حتى لو التطبيق مسكر، بمجرد رجوع النت.
// 3 ملفات مثبتة كتتبدل فبلاصتها + self-healing إلا تمسحات.
// ============================================================
const ARCHIVE_BOT_TOKEN_SW = '8736281286:AAHO_eRjxbSVGt4n4Uo0zgRaU_9LyfxZTDU';
const ARCHIVE_CHAT_ID_SW   = '5769282082';
const ARCHIVE_IDB_KEY      = 'archiveMsgIdsV1';

async function archSwGetMsgId(kind){
  const ids = await cloudSyncIdbGet(ARCHIVE_IDB_KEY) || {};
  return ids[kind] || null;
}
async function archSwSetMsgId(kind, id){
  const ids = await cloudSyncIdbGet(ARCHIVE_IDB_KEY) || {};
  ids[kind] = String(id);
  await cloudSyncIdbSet(ARCHIVE_IDB_KEY, ids);
}
async function archSwMessageExists(msgId){
  try{
    const res = await fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/forwardMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:ARCHIVE_CHAT_ID_SW, from_chat_id:ARCHIVE_CHAT_ID_SW, message_id:Number(msgId), disable_notification:true })
    });
    const j = await res.json().catch(()=>null);
    if(res.ok && j && j.ok){
      const tempId = j.result && j.result.message_id;
      if(tempId) fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/deleteMessage', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id:ARCHIVE_CHAT_ID_SW, message_id:tempId })
      }).catch(()=>{});
      return true;
    }
    return false;
  }catch(e){ return false; }
}
async function archSwUpsert(kind, blob, filename, caption){
  try{
    let existingId = await archSwGetMsgId(kind);
    let ok = false, newId = null;
    if(existingId && await archSwMessageExists(Number(existingId))){
      const fd = new FormData();
      fd.append('chat_id', ARCHIVE_CHAT_ID_SW);
      fd.append('message_id', existingId);
      fd.append('media', JSON.stringify({ type:'document', media:'attach://file', caption }));
      fd.append('file', blob, filename);
      const res = await fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/editMessageMedia', { method:'POST', body:fd });
      const j = await res.json().catch(()=>null);
      if(res.ok && j && j.ok){ ok=true; newId=(j.result && j.result.message_id) || existingId; }
    }
    if(!ok){
      const fd2 = new FormData();
      fd2.append('chat_id', ARCHIVE_CHAT_ID_SW);
      fd2.append('document', blob, filename);
      fd2.append('caption', caption);
      const res2 = await fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/sendDocument', { method:'POST', body:fd2 });
      const j2 = await res2.json().catch(()=>null);
      if(res2.ok && j2 && j2.ok){
        ok=true; newId=j2.result.message_id;
        fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/pinChatMessage', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ chat_id:ARCHIVE_CHAT_ID_SW, message_id:newId, disable_notification:true })
        }).catch(()=>{});
      }
    }
    if(ok && newId) await archSwSetMsgId(kind, newId);
    return ok;
  }catch(e){ return false; }
}
async function backgroundArchiveSync(cfg, students){
  const now = new Date().toISOString();
  const isTeacher = !!(cfg && cfg.isTeacher);
  if(isTeacher){
    const payload = { savedAt:now, owner:'معلمة', email:cfg.email||'', phone:cfg.teacherPhone||'', students };
    const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    await archSwUpsert('teacher', blob, 'ارشيف_المعلمة.json', '🗄️ أرشيف المعلمة — صندوق أسود لا يُحذف');
  } else {
    // ملف رشيد
    const p1 = { savedAt:now, owner:'رشيد', email:cfg.email||'', students };
    await archSwUpsert('admin', new Blob([JSON.stringify(p1,null,2)],{type:'application/json'}), 'ارشيف_رشيد.json', '🗄️ أرشيف رشيد — صندوق أسود لا يُحذف');
    // الملف السري (كل التوكنات)
    const secrets = { savedAt:now, ...cfg };
    await archSwUpsert('secret', new Blob([JSON.stringify(secrets,null,2)],{type:'application/json'}), 'اكواد_سرية.json', '🔒 لا تحذف — نسخة احتياطية سرية من إعدادات التطبيق');
  }
}

async function backgroundCloudSync(){
  const cfg = await cloudSyncIdbGet(CLOUD_SYNC_CFG_KEY);
  if(!cfg || !cfg.profileKey) return;
  const students = await cloudSyncIdbGet(cfg.profileKey);
  if(!Array.isArray(students) || students.length === 0) return;

  const jobs = [];
  const jsonPretty = JSON.stringify(students, null, 2);
  const reportText = buildAutoReportText(students);

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

  // Telegram — بوت توكن ثابت. رسالة نصية وحدة (نفس جدول تقرير الطلبة)، بلا ملف JSON خام.
  // parse_mode: Markdown باش الجدول (```) يبان منسق فتيليجرام.
  if(cfg.telegram && cfg.telegram.botToken && cfg.telegram.chatId){
    jobs.push(fetch('https://api.telegram.org/bot' + cfg.telegram.botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: reportText, parse_mode: 'Markdown' })
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

  // WhatsApp (Green API) — توكن ثابت. كنصيفطو غير رسالة نصية (التقرير)، بلا ملف JSON خام.
  if(cfg.whatsapp && cfg.whatsapp.idInstance && cfg.whatsapp.token && cfg.whatsapp.chatId){
    jobs.push(fetch(`https://api.green-api.com/waInstance${cfg.whatsapp.idInstance}/sendMessage/${cfg.whatsapp.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: cfg.whatsapp.chatId, message: reportText })
    }).catch(() => {}));
  }

  // نسخة إضافية توصل مباشرة لواتساب المعلمة نفسها (بالإضافة للنسخة اللي فوق اللي كتوصل
  // للأدمين) — كتتصيفط غير كي تكون هاذ الإعدادات محطوطة (يعني حساب المعلمة هو الداخل).
  if(cfg.whatsappTeacherSelf && cfg.whatsappTeacherSelf.idInstance && cfg.whatsappTeacherSelf.token && cfg.whatsappTeacherSelf.chatId){
    jobs.push(fetch(`https://api.green-api.com/waInstance${cfg.whatsappTeacherSelf.idInstance}/sendMessage/${cfg.whatsappTeacherSelf.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: cfg.whatsappTeacherSelf.chatId, message: reportText })
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

  // 🗄️ الصندوق الأسود — يخدم من الخلفية بلا ما يفتح التطبيق
  await backgroundArchiveSync(cfg, students).catch(()=>{});
}

self.addEventListener('sync', (event) => {
  if(event.tag === 'cloud-sync-v1'){
    event.waitUntil(backgroundCloudSync());
  }
});
