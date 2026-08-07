/**
 * Worker واحد كيخدم بروكسي لـ: Telegram + GitHub + Dropbox + Google Drive + Google Sheet.
 * الهدف: الخمسة يخدمو أوتوماتيك بلا ما يحتاج المستخدم يدوس "تسجيل الدخول" فـ Google فكل جهاز.
 * التوكنات/المفاتيح الحقيقية خاصهم يتحطو هنا كـ Environment Variables فـ Cloudflare Dashboard
 * (Settings → Variables and Secrets) — ماشي فالكود، وماشي فالمتصفح.
 *
 * Environment Variables:
 *   PROXY_SECRET         - كلمة سر بسيطة، نفسها اللي غادي تحطها فـ PROXY_SECRET فـ index.html
 *   TG_BOT_TOKEN          - توكن البوت ديال Telegram (من BotFather)
 *   TG_CHAT_ID            - الـ chat id لي غادي يتصيفط ليه الباكاب
 *   GH_TOKEN              - GitHub Personal Access Token بصلاحية repo (Contents: Read/Write)
 *   GH_REPO               - owner/repo (مثلا: yourname/backups)
 *   GH_PATH               - (اختياري) مسار الملف، افتراضيا backup.json
 *   GH_BRANCH             - (اختياري) الفرع، افتراضيا main
 *   DBX_TOKEN             - Dropbox access token دائم
 *   DBX_PATH              - (اختياري) مسار الملف، افتراضيا /backup.json
 *   GOOGLE_SA_EMAIL        - إيميل Service Account (من Google Cloud Console)
 *   GOOGLE_SA_PRIVATE_KEY  - المفتاح الخاص (private_key) ديال نفس الـ Service Account (PEM كامل)
 *   DRIVE_FOLDER_ID        - (اختياري) معرف مجلد Drive لي غادي يتحط فيه backup.json
 *   SHEET_ID               - معرف Google Sheet (من الرابط ديالو) لي غادي يتكتب فيه الباكاب
 *
 * ملاحظة مهمة: Drive/Sheet هنا كيخدمو بـ Service Account — يعني خاصك تدير Service Account
 * جديد فـ Google Cloud Console (IAM & Admin → Service Accounts)، تفعّل ليه Drive API و
 * Sheets API، وإيلا بغيتي يكتب فـ Sheet معين ولا مجلد Drive معين ديالك، خاصك "تشارك" (Share)
 * هاد الملف/المجلد مع إيميل الـ Service Account (بحال ما كتشارك مع أي حد آخر).
 *
 * بعد ما تدير Deploy، خد رابط الـ Worker (بحال https://xxx.workers.dev) وحطو فـ
 * PROXY_URL فـ index.html، وحط نفس PROXY_SECRET فـ PROXY_SECRET فـ index.html.
 */

function withCors(resp) {
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return new Response(resp.body, { status: resp.status, headers });
}

function json(obj, status = 200) {
  return withCors(new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const expected = 'Bearer ' + (env.PROXY_SECRET || '');
  return env.PROXY_SECRET && auth === expected;
}

// ---------------- Telegram ----------------
// كنستعملو رسالة واحدة "مثبتة" (pinned) فالشات، وكنبدلو فيها الملف كل مرة.
async function tgUpload(request, env) {
  const { data } = await request.json();
  const token = env.TG_BOT_TOKEN, chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return json({ ok: false, detail: 'TG_BOT_TOKEN/TG_CHAT_ID ماشي معمرين فالـ Worker' }, 500);

  const content = JSON.stringify(data, null, 2);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([content], { type: 'application/json' }), 'backup.json');
  form.append('caption', '📦 نسخة احتياطية محدثة');

  const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST', body: form
  });
  const sendJson = await sendRes.json();
  if (!sendJson.ok) return json({ ok: false, detail: sendJson.description || 'Telegram send failed' }, 500);

  const msgId = sendJson.result.message_id;
  // نثبتو الرسالة الجديدة
  await fetch(`https://api.telegram.org/bot${token}/pinChatMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, disable_notification: true })
  });

  return json({ ok: true, message_id: msgId });
}

async function tgFetch(env) {
  const token = env.TG_BOT_TOKEN, chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return json({ ok: false, detail: 'TG_BOT_TOKEN/TG_CHAT_ID ماشي معمرين' }, 500);

  const chatRes = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
  const chatJson = await chatRes.json();
  const pinned = chatJson.result && chatJson.result.pinned_message;
  const doc = pinned && pinned.document;
  if (!doc) return json({ ok: false, data: null });

  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${doc.file_id}`);
  const fileJson = await fileRes.json();
  const filePath = fileJson.result && fileJson.result.file_path;
  if (!filePath) return json({ ok: false, data: null });

  const contentRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const data = await contentRes.json();
  return json({ ok: true, data });
}

// ---------------- GitHub ----------------
function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'student-payment-tracker-worker'
  };
}
function ghApiUrl(env) {
  const path = env.GH_PATH || 'backup.json';
  return `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
}
function utf8ToB64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64ToUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

async function ghUpload(request, env) {
  const { data } = await request.json();
  if (!env.GH_TOKEN || !env.GH_REPO) return json({ ok: false, detail: 'GH_TOKEN/GH_REPO ماشي معمرين فالـ Worker' }, 500);

  const branch = env.GH_BRANCH || 'main';
  const url = ghApiUrl(env) + `?ref=${branch}`;
  let sha = null;
  const getRes = await fetch(url, { headers: ghHeaders(env) });
  if (getRes.ok) {
    const getJson = await getRes.json();
    sha = getJson.sha;
  }

  const body = {
    message: 'تحديث النسخة الاحتياطية',
    content: utf8ToB64(JSON.stringify(data, null, 2)),
    branch
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(ghApiUrl(env), {
    method: 'PUT', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const putJson = await putRes.json();
  if (!putRes.ok) return json({ ok: false, detail: putJson.message || 'GitHub upload failed' }, 500);
  return json({ ok: true });
}

async function ghFetch(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) return json({ ok: false, detail: 'GH_TOKEN/GH_REPO ماشي معمرين' }, 500);
  const branch = env.GH_BRANCH || 'main';
  const res = await fetch(ghApiUrl(env) + `?ref=${branch}`, { headers: ghHeaders(env) });
  if (!res.ok) return json({ ok: false, data: null });
  const j = await res.json();
  try {
    const data = JSON.parse(b64ToUtf8(j.content));
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, data: null });
  }
}

// ---------------- Dropbox ----------------
async function dbxUpload(request, env) {
  const { data } = await request.json();
  if (!env.DBX_TOKEN) return json({ ok: false, detail: 'DBX_TOKEN ماشي معمر فالـ Worker' }, 500);
  const path = env.DBX_PATH || '/backup.json';

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DBX_TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true })
    },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) {
    const t = await res.text();
    return json({ ok: false, detail: t.slice(0, 200) }, 500);
  }
  return json({ ok: true });
}

async function dbxFetch(env) {
  if (!env.DBX_TOKEN) return json({ ok: false, detail: 'DBX_TOKEN ماشي معمر' }, 500);
  const path = env.DBX_PATH || '/backup.json';
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DBX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  if (!res.ok) return json({ ok: false, data: null });
  try {
    const data = await res.json();
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, data: null });
  }
}

// ---------------- Google (Drive + Sheet) via Service Account ----------------
function b64urlEncode(bytes) {
  let str = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToArrayBuffer(pem) {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const raw = atob(clean);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}
async function getGoogleAccessToken(env, scope) {
  const privateKeyPem = (env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_SA_EMAIL, scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };
  const unsigned = b64urlEncode(JSON.stringify(header)) + '.' + b64urlEncode(JSON.stringify(claim));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)
  );
  const jwt = unsigned + '.' + b64urlEncode(sig);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('Google auth failed: ' + JSON.stringify(j));
  return j.access_token;
}

// ---- Drive: كنخبيو backup.json فمجلد (اختياري) بحساب الـ Service Account ----
async function driveFindFileId(token, env) {
  const q = encodeURIComponent(
    `name='backup.json' and trashed=false` + (env.DRIVE_FOLDER_ID ? ` and '${env.DRIVE_FOLDER_ID}' in parents` : '')
  );
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j = await res.json();
  return (j.files && j.files[0] && j.files[0].id) || null;
}
async function driveUpload(request, env) {
  const { data } = await request.json();
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) return json({ ok: false, detail: 'GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY ماشي معمرين' }, 500);

  const token = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/drive.file');
  const fileId = await driveFindFileId(token, env);
  const metadata = { name: 'backup.json', mimeType: 'application/json' };
  if (!fileId && env.DRIVE_FOLDER_ID) metadata.parents = [env.DRIVE_FOLDER_ID];
  const content = JSON.stringify(data, null, 2);

  const boundary = 'wkr_boundary_' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) return json({ ok: false, detail: await res.text() }, 500);
  return json({ ok: true });
}
async function driveFetch(env) {
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) return json({ ok: false, detail: 'GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY ماشي معمرين' }, 500);
  const token = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/drive.file');
  const fileId = await driveFindFileId(token, env);
  if (!fileId) return json({ ok: false, data: null });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return json({ ok: false, data: null });
  const data = await res.json();
  return json({ ok: true, data });
}

// ---- Sheet: كنكتبو الباكاب كـ JSON فخانة وحدة (A1) فورقة "Backup" ----
async function sheetUpload(request, env) {
  const { data } = await request.json();
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY || !env.SHEET_ID) {
    return json({ ok: false, detail: 'GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY/SHEET_ID ماشي معمرين' }, 500);
  }
  const token = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/spreadsheets');
  const range = 'Backup!A1';
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [[JSON.stringify(data)]] })
    }
  );
  if (!res.ok) return json({ ok: false, detail: await res.text() }, 500);
  return json({ ok: true });
}
async function sheetFetch(env) {
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY || !env.SHEET_ID) {
    return json({ ok: false, detail: 'GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY/SHEET_ID ماشي معمرين' }, 500);
  }
  const token = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/spreadsheets');
  const range = 'Backup!A1';
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return json({ ok: false, data: null });
  const j = await res.json();
  const raw = j.values && j.values[0] && j.values[0][0];
  if (!raw) return json({ ok: false, data: null });
  try {
    return json({ ok: true, data: JSON.parse(raw) });
  } catch (e) {
    return json({ ok: false, data: null });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }
    if (!checkAuth(request, env)) {
      return json({ ok: false, detail: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/telegram/upload' && request.method === 'POST') return await tgUpload(request, env);
      if (path === '/telegram/fetch' && request.method === 'GET') return await tgFetch(env);
      if (path === '/github/upload' && request.method === 'POST') return await ghUpload(request, env);
      if (path === '/github/fetch' && request.method === 'GET') return await ghFetch(env);
      if (path === '/dropbox/upload' && request.method === 'POST') return await dbxUpload(request, env);
      if (path === '/dropbox/fetch' && request.method === 'GET') return await dbxFetch(env);
      if (path === '/drive/upload' && request.method === 'POST') return await driveUpload(request, env);
      if (path === '/drive/fetch' && request.method === 'GET') return await driveFetch(env);
      if (path === '/sheet/upload' && request.method === 'POST') return await sheetUpload(request, env);
      if (path === '/sheet/fetch' && request.method === 'GET') return await sheetFetch(env);
      return json({ ok: false, detail: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, detail: String(e) }, 500);
    }
  }
};
