// Service Worker ديال "تتبع الطلبة"
// الهدف: يخلي التطبيق يخدم أوفلاين (بلا انترنت) ويولي قابل للتثبيت (Add to Home Screen) بشكل صحيح.
// ⚠️ بدّل هاد الرقم (CACHE_VERSION) كل مرة تبدل فيها index.html، باش الهاتف يجيب النسخة الجديدة
const CACHE_VERSION = 'v6';
const CACHE_NAME = 'tatbi3-taliba-' + CACHE_VERSION;

// الملفات الأساسية لي خاصها تبقى محفوظة محليا باش يخدم التطبيق حتى بلا نت
const APP_SHELL = [
  './',
  './index.html',
  './sw.js'
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
function swIsPaid(value){
  if(value === true || value === 1) return true;
  const text = String(value ?? '').trim().toLowerCase();
  return ['yes','paid','done','complete','completed','true','خلص','خالص','نعم','مخلص'].includes(text);
}
function swPaidMonths(s){
  const paid = Array(SW_TOTAL_MONTHS).fill(false);
  const raw = s && s.paidMonths;
  if(Array.isArray(raw)) for(let i=0;i<SW_TOTAL_MONTHS;i++) paid[i] = swIsPaid(raw[i]);
  else if(raw && typeof raw === 'object') for(let i=0;i<SW_TOTAL_MONTHS;i++) paid[i] = swIsPaid(raw[i] ?? raw[String(i)]);
  const legacy = [s && s.paid, s && s.isPaid, s && s.paidStatus, s && s.paymentStatus, s && s.status, s && s['خلص'], s && s['خالص']];
  if(!paid.some(Boolean) && legacy.some(swIsPaid)) paid[0] = true;
  return paid;
}
function swMonthStatus(s, targetMonth){
  const paidMonths = swPaidMonths(s);
  for(let i=0;i<SW_TOTAL_MONTHS;i++){
    const d = swAddMonths(s.startDate, i);
    if(d.getMonth() + 1 === targetMonth){
      if(paidMonths[i]) return '✅'; // خالص = علامة خضراء
      return '';
    }
  }
  return '';
}
function swIsoToDisplay(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}
// ---- نفس جدول Word المنسق اللي كيستعملو index.html (buildStudentsReportWordHtml) —
// كنبنيوه هنا بلا DOM (Service Worker ماعندوش document) باش نصيفطو ملف مرتب
// عوض رسالة نص "جدول" اللي كتبان مخربقة فتيليجرام/واتساب بسبب خلط العربية RTL
// مع padding LTR (مشكلة bidi ماعندهاش حل فالنص العادي).
function swBuildReportWordHtml(students){
  const rows = students.map((s, index)=>{
    const monthCells = SW_ACADEMIC_MONTHS.map(m => {
      const status = swMonthStatus(s, m);
      let bg = '', color = '#333';
      if(status === '✅'){ color = '#0a7a2f'; bg = '#e5f6ec'; }
      else if(status === '❌'){ color = '#c0392b'; bg = '#fbe9e7'; }
      else { color = '#333'; bg = '#ffffff'; }
      return `<td style="text-align:center; color:${color}; background:${bg}; font-weight:bold; font-size:13px; border:1px solid #d1d5db; padding:8px;">${status}</td>`;
    }).join('');
    const rowBg = index % 2 === 0 ? '#ffffff' : '#f9fafb';
    return `<tr style="background:${rowBg};">
      <td style="background:#f2f8f5; font-weight:bold; color:#1c2128; border:1px solid #d1d5db; padding:10px 12px; text-align:right;">${s.name || ''}</td>
      <td style="background:#fcfdfd; text-align:center; color:#4b5563; border:1px solid #d1d5db; padding:10px 8px; font-weight:600;">${swIsoToDisplay(s.startDate) || ''}</td>
      ${monthCells}
    </tr>`;
  }).join('');

  const headerMonths = SW_ACADEMIC_MONTHS.map(m => `<th style="background:#1b8a4d; color:#fff; text-align:center; border:1px solid #146c3b; padding:10px 6px; font-size:13px;">${m}</th>`).join('');
  const now = new Date().toLocaleString('ar-MA');

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: Arial, Tahoma, sans-serif; direction: rtl; padding: 16px; color:#1f2937; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d1d5db; }
</style>
</head>
<body dir="rtl">
  <h1 style="text-align:center; color:#1b8a4d; font-size:20px; margin-bottom:2px;">🏫 جمعية المعرفة</h1>
  <p style="text-align:center; color:#1b8a4d; font-weight:bold; font-size:14px; margin-top:0; margin-bottom:2px;">📋 تقرير الطلبة — سجل الدفوعات</p>
  <p style="text-align:center; color:#4b5563; font-size:12px; margin-top:0; margin-bottom:16px;">تاريخ التقرير: ${now} &nbsp;|&nbsp; عدد الطلبة: ${students.length}</p>
  <table>
    <thead>
      <tr>
        <th style="background:#1b8a4d; color:#fff; padding:12px 14px; text-align:right; font-size:14px;">الاسم الكامل</th>
        <th style="background:#1b8a4d; color:#fff; padding:12px 10px; text-align:center; font-size:14px;">يوم الالتحاق</th>
        ${headerMonths}
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="12" style="text-align:center; padding:20px; color:#6b7280;">ماكاين حتى طالب بعد</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}
function swBuildReportWordBlob(students){
  return new Blob(['\ufeff' + swBuildReportWordHtml(students)], { type: 'application/msword;charset=utf-8' });
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
const ARCHIVE_IDB_KEY      = 'archiveMsgIdsV1'; // كاش محلي فقط — المرجع الحقيقي هو Firebase
const SW_SHARED_DATA_UID   = 'workspace-main';

// نفس مسار Firebase بالضبط اللي كيستعملو index.html (archiveMsgIdCloudPath) — باش
// المقدمة والخلفية يتتبعو نفس الرسالة المثبتة، عوض ما كل وحدة تخلق ملف بوحدها
// (هادشي كان كيسبب ملفين مكررين لكل تقرير عوض ملف واحد كيتبدل).
function archSwCloudPath(kind, cfg){
  if(kind === 'teacher') return 'users/' + (cfg.dataUid || SW_SHARED_DATA_UID) + '/archiveMsgIds/teacher';
  return 'users/' + SW_SHARED_DATA_UID + '/archiveMsgIds/' + kind;
}
async function archSwGetMsgId(kind, cfg){
  if(cfg && cfg.firebaseUrl){
    try{
      const res = await fetch(cfg.firebaseUrl + '/' + archSwCloudPath(kind, cfg) + '.json');
      if(res.ok){
        const v = await res.json().catch(()=>null);
        if(v){ return String(v); }
      }
    }catch(e){ /* نكملو على الكاش المحلي */ }
  }
  const ids = await cloudSyncIdbGet(ARCHIVE_IDB_KEY) || {};
  return ids[kind] || null;
}
async function archSwSetMsgId(kind, id, cfg){
  const ids = await cloudSyncIdbGet(ARCHIVE_IDB_KEY) || {};
  ids[kind] = String(id);
  await cloudSyncIdbSet(ARCHIVE_IDB_KEY, ids);
  if(cfg && cfg.firebaseUrl){
    try{
      await fetch(cfg.firebaseUrl + '/' + archSwCloudPath(kind, cfg) + '.json', {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(String(id))
      });
    }catch(e){ /* صامت — الكاش المحلي كافي مؤقتا */ }
  }
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
async function archSwDeleteMessage(msgId){
  if(!msgId) return true;
  try{
    const res = await fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/deleteMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:ARCHIVE_CHAT_ID_SW, message_id:Number(msgId) })
    });
    const data = await res.json().catch(()=>null);
    return !!(res.ok && data && data.ok);
  }catch(e){ return false; }
}
async function archSwUpsert(kind, blob, filename, caption, cfg){
  try{
    let existingId = await archSwGetMsgId(kind, cfg);
    let ok = false, newId = null;
    if(existingId && await archSwMessageExists(Number(existingId))){
      const fd = new FormData();
      fd.append('chat_id', ARCHIVE_CHAT_ID_SW);
      fd.append('message_id', existingId);
      fd.append('media', JSON.stringify({ type:'document', media:'attach://file', caption }));
      fd.append('file', blob, filename);
      const res = await fetch('https://api.telegram.org/bot' + ARCHIVE_BOT_TOKEN_SW + '/editMessageMedia', { method:'POST', body:fd });
      const j = await res.json().catch(()=>null);
      if(res.ok && j && j.ok){
        ok=true;
        newId=(j.result && j.result.message_id) || existingId;
      } else if(j && /not modified/i.test(String(j.description || ''))){
        ok=true;
        newId=existingId;
      } else {
        const deleted = await archSwDeleteMessage(existingId);
        if(!deleted) return false;
      }
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
    if(ok && newId) await archSwSetMsgId(kind, newId, cfg);
    return ok;
  }catch(e){ return false; }
}
// الملف 1: تقرير المعلمة — جدول Word منظم، نفس خدمة الواتساب بالضبط.
// الملف 2: تقرير رشيد (الأدمين) — نفس الشي.
// الملف 3: الأكواد السرية (JSON) — نفسه كيبقى JSON حيت هادشي بيانات اعتماد ماشي تقرير.
async function backgroundArchiveSync(cfg, students){
  const isTeacher = !!(cfg && cfg.isTeacher);
  if(isTeacher){
    const blob = swBuildReportWordBlob(students);
    await archSwUpsert('teacher', blob, 'تقرير_المعلمة.doc', '🗄️ تقرير المعلمة — تقرير الطلبة (صندوق أسود لا يُحذف)', cfg);
  } else {
    const blob = swBuildReportWordBlob(students);
    await archSwUpsert('admin', blob, 'تقرير رشيد.doc', '🗄️ تقرير رشيد — تقرير الطلبة (صندوق أسود لا يُحذف)', cfg);
    // الملف السري (كل التوكنات) — يبقى JSON، ماشي جدول طلبة
    const secrets = { savedAt: new Date().toISOString(), ...cfg };
    await archSwUpsert('secret', new Blob([JSON.stringify(secrets,null,2)],{type:'application/json'}), 'اكواد_سرية.json', '🔒 لا تحذف — نسخة احتياطية سرية من إعدادات التطبيق', cfg);
  }
}

// ============================================================
// التقرير الحي الرئيسي: معرف واحد لكل حساب ووجهة، حتى لا تتراكم الملفات.
const SW_LIVE_IDS_KEY = 'swLiveReportIdsV1';
async function swFirebaseGet(path, cfg){
  if(!cfg || !cfg.firebaseUrl || !cfg.dataUid) return null;
  try{
    const res = await fetch(cfg.firebaseUrl + '/' + path + '.json');
    if(!res.ok) return null;
    return await res.json().catch(()=>null);
  }catch(e){ return null; }
}
async function swFirebaseSet(path, value, cfg){
  if(!cfg || !cfg.firebaseUrl || !cfg.dataUid) return false;
  try{
    const res = await fetch(cfg.firebaseUrl + '/' + path + '.json', {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)
    });
    return res.ok;
  }catch(e){ return false; }
}
async function swLiveIdGet(key, path, cfg){
  const remote = await swFirebaseGet(path, cfg);
  if(remote){
    const id = typeof remote === 'object' ? remote.id : remote;
    if(id){
      const ids = await cloudSyncIdbGet(SW_LIVE_IDS_KEY) || {};
      ids[key] = String(id); await cloudSyncIdbSet(SW_LIVE_IDS_KEY, ids);
      return String(id);
    }
  }
  const ids = await cloudSyncIdbGet(SW_LIVE_IDS_KEY) || {};
  return ids[key] || null;
}
async function swLiveIdSet(key, path, id, cfg){
  const ids = await cloudSyncIdbGet(SW_LIVE_IDS_KEY) || {};
  ids[key] = String(id); await cloudSyncIdbSet(SW_LIVE_IDS_KEY, ids);
  // Telegram يتوقع معرفًا نصيًا، وWhatsApp يتوقع {id, hash} في آخر index.html.
  const value = key.startsWith('tg:') ? String(id) : {id:String(id), hash:''};
  await swFirebaseSet(path, value, cfg);
}
function swTgReportPath(cfg){ return 'users/' + (cfg.dataUid || SW_SHARED_DATA_UID) + '/tgReportMsgId'; }
function swWaReportPath(cfg, teacherSelf){ return 'users/' + (cfg.dataUid || SW_SHARED_DATA_UID) + '/' + (teacherSelf ? 'waTeacherSelfMsgId' : 'waMsgId'); }
async function swTgMessageExists(token, chatId, msgId){
  try{
    const res = await fetch('https://api.telegram.org/bot' + token + '/forwardMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId, from_chat_id:chatId, message_id:Number(msgId), disable_notification:true})
    });
    const j = await res.json().catch(()=>null);
    if(res.ok && j && j.ok){
      const tempId = j.result && j.result.message_id;
      if(tempId) fetch('https://api.telegram.org/bot' + token + '/deleteMessage', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:chatId,message_id:tempId})}).catch(()=>{});
      return true;
    }
  }catch(e){}
  return false;
}
async function swTelegramLiveReport(cfg, students){
  if(!cfg.telegram || !cfg.telegram.botToken || !cfg.telegram.chatId) return false;
  const token = cfg.telegram.botToken, chatId = cfg.telegram.chatId;
  const path = swTgReportPath(cfg), key = 'tg:' + (cfg.dataUid || SW_SHARED_DATA_UID);
  const blob = swBuildReportWordBlob(students), filename = 'تقرير_الطلبة.doc';
  let existingId = await swLiveIdGet(key, path, cfg), ok = false, newId = null;
  if(existingId && await swTgMessageExists(token, chatId, existingId)){
    const fd = new FormData();
    fd.append('chat_id', chatId); fd.append('message_id', existingId);
    fd.append('media', JSON.stringify({type:'document', media:'attach://file', caption:'📋 تقرير الطلبة — سجل الدفوعات'}));
    fd.append('file', blob, filename);
    const res = await fetch('https://api.telegram.org/bot' + token + '/editMessageMedia', {method:'POST', body:fd});
    const j = await res.json().catch(()=>null);
    if(res.ok && j && j.ok){ ok=true; newId=(j.result && j.result.message_id) || existingId; }
    else if(j && /not modified/i.test(String(j.description || ''))){ ok=true; newId=existingId; }
    else {
      const del = await fetch('https://api.telegram.org/bot' + token + '/deleteMessage', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:chatId,message_id:Number(existingId)})});
      const dj = await del.json().catch(()=>null);
      if(!(del.ok && dj && dj.ok)) return false;
    }
  }
  if(!ok){
    const fd = new FormData(); fd.append('chat_id', chatId); fd.append('document', blob, filename); fd.append('caption','📋 تقرير الطلبة — سجل الدفوعات');
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendDocument', {method:'POST', body:fd});
    const j = await res.json().catch(()=>null);
    if(!(res.ok && j && j.ok)) return false;
    ok=true; newId=j.result.message_id;
    fetch('https://api.telegram.org/bot' + token + '/pinChatMessage', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:chatId,message_id:newId,disable_notification:true})}).catch(()=>{});
  }
  if(ok && newId) await swLiveIdSet(key, path, newId, cfg);
  return ok;
}
async function swWhatsAppLiveReport(entry, path, key, cfg, students){
  if(!entry || !entry.idInstance || !entry.token || !entry.chatId) return false;
  const blob = swBuildReportWordBlob(students), filename = 'تقرير_الطلبة.doc';
  const base = 'https://api.green-api.com/waInstance' + entry.idInstance;
  const existingId = await swLiveIdGet(key, path, cfg);
  if(existingId){
    const del = await fetch(base + '/deleteMessage/' + entry.token, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chatId:entry.chatId,idMessage:existingId})});
    const dj = await del.json().catch(()=>null);
    if(!(del.ok && dj && (dj.result === true || dj.success === true || dj.message === 'OK'))) return false;
  }
  const fd = new FormData(); fd.append('chatId', entry.chatId); fd.append('file', blob, filename); fd.append('caption','📋 تقرير الطلبة — سجل الدفوعات');
  const res = await fetch(base + '/sendFileByUpload/' + entry.token, {method:'POST', body:fd});
  const j = await res.json().catch(()=>null);
  if(!(res.ok && j && j.idMessage)) return false;
  await swLiveIdSet(key, path, j.idMessage, cfg);
  return true;
}

async function backgroundCloudSync(){
  const cfg = await cloudSyncIdbGet(CLOUD_SYNC_CFG_KEY);
  if(!cfg || !cfg.profileKey) return;
  const students = await cloudSyncIdbGet(cfg.profileKey);
  if(!Array.isArray(students)) return;

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

  // Telegram — تقرير حي واحد لكل حساب، يحدّث الرسالة السابقة بدل إنشاء ملف جديد.
  if(cfg.telegram && cfg.telegram.botToken && cfg.telegram.chatId){
    jobs.push(swTelegramLiveReport(cfg, students).catch(()=>false));
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

  // WhatsApp Admin — ملف حي واحد يحذف/يستبدل الملف السابق قبل إرسال البديل.
  if(cfg.whatsapp && cfg.whatsapp.idInstance && cfg.whatsapp.token && cfg.whatsapp.chatId){
    jobs.push(swWhatsAppLiveReport(cfg.whatsapp, swWaReportPath(cfg, false), 'wa:' + (cfg.dataUid || SW_SHARED_DATA_UID), cfg, students).catch(()=>false));
  }

  // نسخة المعلمة الشخصية — ملف حي مستقل واحد، لا رسالة جديدة لكل تعديل.
  if(cfg.whatsappTeacherSelf && cfg.whatsappTeacherSelf.idInstance && cfg.whatsappTeacherSelf.token && cfg.whatsappTeacherSelf.chatId){
    jobs.push(swWhatsAppLiveReport(cfg.whatsappTeacherSelf, swWaReportPath(cfg, true), 'waTeacher:' + (cfg.dataUid || SW_SHARED_DATA_UID), cfg, students).catch(()=>false));
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
