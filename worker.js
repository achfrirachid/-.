// ==========================================================================
// Worker موحد: وسيط آمن بين التطبيق و(GitHub / Dropbox / Telegram / Cloudflare R2)
// ==========================================================================
// الفكرة: كل التوكنات الحقيقية (GitHub PAT, Dropbox Token, Telegram Bot Token)
// كتبقى مخبأة هنا فـ Cloudflare Environment Variables (مشفرة)، ماشي فكود التطبيق.
// التطبيق كيتصل بهاد الـ Worker فقط، بمفتاح واحد بسيط (PROXY_SECRET) يمكن
// يتحط فكود التطبيق بلا خطر كبير: أقصى شيء يقدر يديرو حد لقاه هو "يستهلك" الـ
// Worker ديالك (quota)، ماشي يوصل لحساباتك ديال GitHub/Dropbox/Telegram.
//
// الـ Routes:
//   POST /github/upload    body: { data: [...] }
//   GET  /github/fetch
//   POST /dropbox/upload   body: { data: [...] }
//   GET  /dropbox/fetch
//   POST /telegram/upload  body: { data: [...] }
//   GET  /telegram/fetch
//   POST /r2/upload        body: { uid, data, updatedAt }
//   GET  /r2/fetch?uid=xxx
//
// كل طلب خاصو Header: Authorization: Bearer <PROXY_SECRET>

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors() });
}
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    // ✅ التحقق من المفتاح المشترك
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!env.PROXY_SECRET || token !== env.PROXY_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    try {
      // ---------------- GitHub ----------------
      if (url.pathname === '/github/upload' && request.method === 'POST') {
        const body = await request.json();
        const ghApiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(env.GH_PATH).replace(/%2F/g, '/')}`;
        const branch = env.GH_BRANCH || 'main';

        let sha = null;
        const getRes = await fetch(`${ghApiUrl}?ref=${encodeURIComponent(branch)}`, {
          headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'backup-proxy' },
        });
        if (getRes.ok) {
          const j = await getRes.json();
          sha = j.sha || null;
        }

        const putBody = {
          message: 'تحديث نسخة احتياطية — ' + new Date().toISOString(),
          content: utf8ToBase64(JSON.stringify(body.data, null, 2)),
          branch,
        };
        if (sha) putBody.sha = sha;

        const putRes = await fetch(ghApiUrl, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + env.GH_TOKEN,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'backup-proxy',
          },
          body: JSON.stringify(putBody),
        });
        if (!putRes.ok) {
          const t = await putRes.text().catch(() => '');
          return json({ error: 'GitHub upload failed', detail: t.slice(0, 300) }, putRes.status);
        }
        return json({ ok: true });
      }

      if (url.pathname === '/github/fetch' && request.method === 'GET') {
        const ghApiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(env.GH_PATH).replace(/%2F/g, '/')}`;
        const branch = env.GH_BRANCH || 'main';
        const res = await fetch(`${ghApiUrl}?ref=${encodeURIComponent(branch)}`, {
          headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'backup-proxy' },
        });
        if (!res.ok) return json({ error: 'Not found' }, 404);
        const j = await res.json();
        if (!j.content) return json({ error: 'Empty' }, 404);
        const data = JSON.parse(base64ToUtf8(j.content));
        return json({ data });
      }

      // ---------------- Dropbox ----------------
      if (url.pathname === '/dropbox/upload' && request.method === 'POST') {
        const body = await request.json();
        const path = env.DBX_PATH || '/backup.json';
        const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + env.DBX_TOKEN,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
          },
          body: JSON.stringify(body.data, null, 2),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          return json({ error: 'Dropbox upload failed', detail: t.slice(0, 300) }, res.status);
        }
        return json({ ok: true });
      }

      if (url.pathname === '/dropbox/fetch' && request.method === 'GET') {
        const path = env.DBX_PATH || '/backup.json';
        const res = await fetch('https://content.dropboxapi.com/2/files/download', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + env.DBX_TOKEN,
            'Dropbox-API-Arg': JSON.stringify({ path }),
          },
        });
        if (!res.ok) return json({ error: 'Not found' }, 404);
        const data = JSON.parse(await res.text());
        return json({ data });
      }

      // ---------------- Telegram ----------------
      if (url.pathname === '/telegram/upload' && request.method === 'POST') {
        const body = await request.json();
        const token = env.TG_BOT_TOKEN;
        const chatId = env.TG_CHAT_ID;
        const blob = new Blob([JSON.stringify(body.data, null, 2)], { type: 'application/json' });
        const fileName = 'backup-' + Date.now() + '.json';
        const caption = '📚 نسخة احتياطية — تتبع الطلبة — ' + new Date().toISOString();

        let existingMsgId = null;
        if (env.BACKUP_BUCKET) {
          const stateObj = await env.BACKUP_BUCKET.get('tg_msg_id.txt');
          if (stateObj) existingMsgId = (await stateObj.text()).trim();
        }

        if (existingMsgId) {
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('message_id', existingMsgId);
          form.append('media', JSON.stringify({ type: 'document', media: 'attach://file', caption }));
          form.append('file', blob, fileName);
          const editRes = await fetch(`https://api.telegram.org/bot${token}/editMessageMedia`, { method: 'POST', body: form });
          if (editRes.ok) return json({ ok: true });
        }

        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption);
        form.append('document', blob, fileName);
        const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j || !j.ok) {
          return json({ error: 'Telegram upload failed', detail: j && j.description }, 502);
        }
        const newMsgId = j.result.message_id;
        if (env.BACKUP_BUCKET) await env.BACKUP_BUCKET.put('tg_msg_id.txt', String(newMsgId));
        await fetch(`https://api.telegram.org/bot${token}/pinChatMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: newMsgId, disable_notification: true }),
        }).catch(() => {});
        return json({ ok: true });
      }

      if (url.pathname === '/telegram/fetch' && request.method === 'GET') {
        const token = env.TG_BOT_TOKEN;
        const chatId = env.TG_CHAT_ID;
        const chatRes = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
        const chatJson = await chatRes.json();
        let doc = null;
        if (chatJson.ok && chatJson.result && chatJson.result.pinned_message && chatJson.result.pinned_message.document) {
          doc = chatJson.result.pinned_message.document;
          if (env.BACKUP_BUCKET) await env.BACKUP_BUCKET.put('tg_msg_id.txt', String(chatJson.result.pinned_message.message_id));
        }
        if (!doc) {
          const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`);
          const j = await res.json();
          if (j.ok && Array.isArray(j.result)) {
            const docs = j.result
              .map((u) => u.message)
              .filter((m) => m && String(m.chat && m.chat.id) === String(chatId) && m.document && /\.json$/i.test(m.document.file_name || ''))
              .sort((a, b) => (b.date || 0) - (a.date || 0));
            if (docs.length) doc = docs[0].document;
          }
        }
        if (!doc) return json({ error: 'Not found' }, 404);
        const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${doc.file_id}`);
        const fileJson = await fileRes.json();
        if (!fileJson.ok) return json({ error: 'Not found' }, 404);
        const contentRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileJson.result.file_path}`);
        const data = await contentRes.json();
        return json({ data });
      }

      // ---------------- Cloudflare R2 (نفس القديم) ----------------
      if (url.pathname === '/r2/upload' && request.method === 'POST') {
        const body = await request.json();
        if (!body.uid) return json({ error: 'Missing uid' }, 400);
        await env.BACKUP_BUCKET.put(`${body.uid}.json`, JSON.stringify({ data: body.data, updatedAt: body.updatedAt || Date.now() }));
        return json({ ok: true });
      }
      if (url.pathname === '/r2/fetch' && request.method === 'GET') {
        const uid = url.searchParams.get('uid');
        if (!uid) return json({ error: 'Missing uid' }, 400);
        const obj = await env.BACKUP_BUCKET.get(`${uid}.json`);
        if (!obj) return json({ error: 'Not found' }, 404);
        return new Response(await obj.text(), { headers: cors() });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String(e) }, 500);
    }
  },
};
