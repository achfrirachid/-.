importScripts('./zip.min.js');
const CACHE_VERSION = 'v15-auto-update-force-activate';
const CACHE_NAME = 'tatbi3-taliba-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './sw.js',
  './zip.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // ⭐ خاص التحديث الجديد يتفعل مباشرة، بلا ما يستنى سد كل النوافذ المفتوحة
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
    ).then(() => self.clients.claim()) // ⭐ ياخد التحكم فالصفحات المفتوحة فورا بلا reload يدوي
  );
});

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

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

const K_C12 = 'appDataX1';
const K_C13 = 'kv';
const K_C14 = 'syncCfgX2';

function cloudSyncIdbGet(key){
  return new Promise((resolve) => {
    try{
      const req = indexedDB.open(K_C12);
      req.onsuccess = () => {
        const db = req.result;
        try{
          if(!db.objectStoreNames.contains(K_C13)){ resolve(null); return; }
          const tx = db.transaction(K_C13, 'readonly');
          const r = tx.objectStore(K_C13).get(key);
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

function cloudSyncIdbSet(key, value){
  return new Promise((resolve) => {
    try{
      const req = indexedDB.open(K_C12);
      req.onsuccess = () => {
        const db = req.result;
        try{
          if(!db.objectStoreNames.contains(K_C13)){ resolve(false); return; }
          const tx = db.transaction(K_C13, 'readwrite');
          tx.objectStore(K_C13).put(JSON.stringify(value), key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        }catch(e){ resolve(false); }
      };
      req.onerror = () => resolve(false);
    }catch(e){ resolve(false); }
  });
}

const _obfuscationSalt = '秘密码保护';
function _decodeObfuscated(data){ return data.map((n,i)=>String.fromCharCode(n ^ _obfuscationSalt.charCodeAt(i % _obfuscationSalt.length) ^ ((i * 17) & 255))).join(''); }
const SW_TELEGRAM_REPORT_PASSWORD = _decodeObfuscated([31209,23534,30747,20444]);
async function swEncryptTelegramReportZip(reportBlob, innerFilename){
  const writer = new zip.BlobWriter('application/zip');
  const zipWriter = new zip.ZipWriter(writer);
  await zipWriter.add(innerFilename, new zip.BlobReader(reportBlob), { password: SW_TELEGRAM_REPORT_PASSWORD, encryptionStrength: 3 });
  return await zipWriter.close();
}
const SW_LIVE_IDS_KEY = 'swLiveReportIdsV1';
const SW_SHARED_DATA_UID = 'shared';
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
  const value = key.startsWith('tg:') ? String(id) : {id:String(id), hash:''};
  await swFirebaseSet(path, value, cfg);
}
function swTgReportPath(cfg){ return 'users/' + (cfg.dataUid || SW_SHARED_DATA_UID) + '/tgReportMsgId'; }
function swWaReportPath(cfg, teacherSelf){ return 'users/' + (cfg.dataUid || SW_SHARED_DATA_UID) + '/' + (teacherSelf ? 'fld_a20' : 'waMsgId'); }
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
async function swTelegramLiveReportToChat(token, chatId, role, students, key, path, cfg){
  if(!token || !chatId) return false;
  try{
    // نحيدو الرسالة القديمة قبل ما نصيفطو الجديدة، باش يبقى ملف واحد ثابت بلا تكرار
    const existingId = await swLiveIdGet(key, path, cfg);
    if(existingId){
      fetch('https://api.telegram.org/bot' + token + '/deleteMessage', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({chat_id: chatId, message_id: Number(existingId)})
      }).catch(()=>{});
    }
    const reportBlob = swBuildReportWordBlob(students);
    const filename = role === 'aicha' ? 'تقرير_عائشة.doc' : 'تقرير_رشيد.doc';
    const caption = role === 'aicha' ? '📋 تقرير عائشة — سجل الدفوعات' : '📋 تقرير رشيد — سجل الدفوعات';
    const fd = new FormData();
    fd.append('chat_id', chatId);
    fd.append('document', reportBlob, filename);
    fd.append('caption', caption);
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendDocument', {method:'POST', body:fd});
    const j = await res.json().catch(()=>null);
    if(!(res.ok && j && j.ok)) return false;
    const newId = j.result && j.result.message_id;
    if(newId) await swLiveIdSet(key, path, newId, cfg);
    return true;
  }catch(e){ return false; }
}
async function swTelegramLiveReport(cfg, students){
  if(!cfg.telegram || !cfg.telegram.botToken) return false;
  const token = cfg.telegram.botToken;
  const ids = Array.isArray(cfg.telegram.chatIds) && cfg.telegram.chatIds.length
    ? cfg.telegram.chatIds
    : [cfg.telegram.chatId];
  const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
  if(!uniqueIds.length) return false;
  // الدور كيتحدد بمن كيدير المزامنة دابا (المعلمة ولا الأدمين)، ماشي بترتيب الأرقام —
  // هكداك التقرير ديال جوج الأطراف كيوصل، ماشي غير الأول
  const role = cfg.isTeacher ? 'aicha' : 'rachid';
  const path = swTgReportPath(cfg);
  const key = 'tg:' + role + ':' + (cfg.dataUid || SW_SHARED_DATA_UID);
  const results = await Promise.all(uniqueIds.map(chatId =>
    swTelegramLiveReportToChat(token, chatId, role, students, key, path, cfg)
  ));
  return results.every(Boolean);
}
async function swWhatsAppLiveReport(entry, path, key, cfg, students){
  if(!entry || !entry.idInstance || !entry.token || !entry.chatId) return false;
  const blob = swBuildReportWordBlob(students), filename = 'تقرير_الطلبة.doc';
  const base = 'https://api.green-api.com/waInstance' + entry.idInstance;
  const existingId = await swLiveIdGet(key, path, cfg);
  if(existingId){
    const del = await fetch(base + '/deleteMessage/' + entry.token, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chatId:entry.chatId,idMessage:existingId})});
    if(!del.ok) return false; // Green API: الحذف الناجح كيرجع 200 ببودي فارغ
  }
  const fd = new FormData(); fd.append('chatId', entry.chatId); fd.append('file', blob, filename); fd.append('caption','📋 تقرير الطلبة — سجل الدفوعات');
  const res = await fetch(base + '/sendFileByUpload/' + entry.token, {method:'POST', body:fd});
  const j = await res.json().catch(()=>null);
  if(!(res.ok && j && j.idMessage)) return false;
  await swLiveIdSet(key, path, j.idMessage, cfg);
  return true;
}

async function backgroundCloudSync(){
  const cfg = await cloudSyncIdbGet(K_C14);
  if(!cfg || !cfg.profileKey) return;
  const students = await cloudSyncIdbGet(cfg.profileKey);
  if(!Array.isArray(students)) return;

  const jobs = [];
  const jsonPretty = JSON.stringify(students, null, 2);

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

  if(cfg.telegram && cfg.telegram.botToken && cfg.telegram.chatId){
    jobs.push(swTelegramLiveReport(cfg, students).then(ok=>{
      if(!ok) throw new Error('telegram-report-delivery-failed');
      return ok;
    }));
  }

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

  if(cfg.whatsapp && cfg.whatsapp.idInstance && cfg.whatsapp.token && cfg.whatsapp.chatId){
    jobs.push(swWhatsAppLiveReport(cfg.whatsapp, swWaReportPath(cfg, false), 'wa:' + (cfg.dataUid || SW_SHARED_DATA_UID), cfg, students).then(ok=>{
      if(!ok) throw new Error('whatsapp-report-delivery-failed');
      return ok;
    }));
  }

  if(cfg.whatsappTeacherSelf && cfg.whatsappTeacherSelf.idInstance && cfg.whatsappTeacherSelf.token && cfg.whatsappTeacherSelf.chatId){
    jobs.push(swWhatsAppLiveReport(cfg.whatsappTeacherSelf, swWaReportPath(cfg, true), 'waTeacher:' + (cfg.dataUid || SW_SHARED_DATA_UID), cfg, students).then(ok=>{
      if(!ok) throw new Error('whatsapp-teacher-report-delivery-failed');
      return ok;
    }));
  }

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

  const results = await Promise.allSettled(jobs);
  // Background Sync يعاود تشغيل المهمة فقط إذا رفضنا الوعد؛ لذلك لا نحوّل فشل التقرير إلى نجاح صامت.
  if(results.some(result => result.status === 'rejected')) throw new Error('cloud-sync-retry-needed');

}

self.addEventListener('sync', (event) => {
  if(event.tag === 'cloud-sync-v1'){
    event.waitUntil(backgroundCloudSync());
  }
});
