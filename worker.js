// ============================================================
// Worker وسيط — كيخبي جميع التوكنات، لا التطبيق ولا ملف الهاتف فيهم حتى توكن
// ============================================================

const ALLOWED_ORIGINS = ["https://achfrirachid.github.io"]; // حيدو لـ "*" كان بدلتي الدومين ديالك

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Key",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// 🔒 قفل تلقائي: 5 محاولات غالطة => بلوكاج 10 دقائق لنفس الـ IP
const MAX_FAILED_ATTEMPTS = 5;
const BLOCK_SECONDS = 60; // دقيقة وحدة
const FAIL_WINDOW_SECONDS = 120; // النافذة اللي كيتعدو فيها المحاولات

function rlKey(kind, ip) {
  return new Request(`https://ratelimit.internal/${kind}/${encodeURIComponent(ip)}`);
}

async function isBlocked(ip) {
  const cache = caches.default;
  const hit = await cache.match(rlKey("block", ip));
  return !!hit;
}

async function recordFailure(ip) {
  const cache = caches.default;
  const countReq = rlKey("count", ip);
  let count = 0;
  const cached = await cache.match(countReq);
  if (cached) count = parseInt(await cached.text(), 10) || 0;
  count++;

  await cache.put(countReq, new Response(String(count), {
    headers: { "Cache-Control": `max-age=${FAIL_WINDOW_SECONDS}` },
  }));

  if (count >= MAX_FAILED_ATTEMPTS) {
    await cache.put(rlKey("block", ip), new Response("blocked", {
      headers: { "Cache-Control": `max-age=${BLOCK_SECONDS}` },
    }));
  }
}

async function getDropboxAccessToken(env) {
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("dropbox_auth_failed");
  return j.access_token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // 🔒 إلا كان محظور بسبب محاولات فاشلة سابقة
    if (await isBlocked(ip)) {
      return json({ error: "blocked_try_later" }, 429, origin);
    }

    // 🔒 حماية: كل طلب خاصو المفتاح السري فالـ header، غير كذلك كيترفض
    const key = request.headers.get("X-Proxy-Key") || "";
    if (!env.PROXY_KEY || key !== env.PROXY_KEY) {
      await recordFailure(ip);
      return json({ error: "unauthorized" }, 401, origin);
    }

    try {
      // ---- WhatsApp (green-api) ----
      if (url.pathname === "/wa" && request.method === "POST") {
        const { text, target } = await request.json();
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: text }) }
        );
        const j = await r.json();
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: إرسال صورة (وصل/بطاقة) نيشان لرقم محدد عبر Green API ----
      if (url.pathname === "/wa-send-image" && request.method === "POST") {
        const { phone, filename, caption, imageBase64 } = await request.json();
        if (!phone || !imageBase64) return json({ error: "missing_params" }, 400, origin);
        const digits = String(phone).replace(/\D/g, "");
        if (!digits) return json({ error: "invalid_phone" }, 400, origin);
        const chatId = `${digits}@c.us`;
        let bytes;
        try {
          const b64 = imageBase64.includes(",") ? imageBase64.split(",").pop() : imageBase64;
          bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        } catch (e) {
          return json({ error: "bad_image_data" }, 400, origin);
        }
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("caption", caption || "");
        form.append("file", new Blob([bytes], { type: "image/png" }), filename || "image.png");
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendFileByUpload/${env.WA_TOKEN}`,
          { method: "POST", body: form }
        );
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: تنظيف تقارير التطبيق — يبقى تقرير واحد فقط ----
      if (url.pathname === "/wa-cleanup" && request.method === "POST") {
        const { keepId, target } = await request.json();
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const historyRes = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/getChatHistory/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, count: 300 }) }
        );
        const history = await historyRes.json().catch(() => []);
        if (!historyRes.ok || !Array.isArray(history)) return json({ error: "history_failed" }, 502, origin);
        const reports = history.filter((m) => {
          if (!m || m.type !== "outgoing" || m.isDeleted) return false;
          const body = String(m.body || m.textMessage || m.caption || "");
          const fileName = String(m.fileName || "");
          return body.includes("تقرير إضافة طلبة من ملف الهاتف")
            || /^تقرير_(?:الطلبة(?:_[0-9]{4}-[0-9]{2}-[0-9]{2})?|المعلمة)\.(?:png|doc)$/.test(fileName);
        }).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        const keep = new Set();
        if (keepId) keep.add(String(keepId));
        let deleted = 0;
        for (const report of reports) {
          if (keep.has(String(report.idMessage))) continue;
          const del = await fetch(
            `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/deleteMessage/${env.WA_TOKEN}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, idMessage: report.idMessage }) }
          );
          if (del.ok) deleted++;
        }
        return json({ ok: true, kept: keep.size, deleted }, 200, origin);
      }

      // ---- WhatsApp: حذف رسالة قديمة (باش نبقاو على رسالة واحدة بدل ما نكثرو) ----
      if (url.pathname === "/wa-delete" && request.method === "POST") {
        const { idMessage, target } = await request.json();
        if (!idMessage) return json({ error: "missing_idMessage" }, 400, origin);
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/deleteMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, idMessage }) }
        );
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: فحص وجود تقرير محفوظ قبل التخطي ----
      if (url.pathname === "/wa-message-exists" && request.method === "POST") {
        const { idMessage, target } = await request.json();
        if (!idMessage) return json({ error: "missing_idMessage" }, 400, origin);
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/getMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, idMessage }) }
        );
        const j = await r.json().catch(() => null);
        return json({ ok: true, exists: !!(r.ok && j && !j.isDeleted) }, 200, origin);
      }

      // ---- WhatsApp: تفعيل التقارير التلقائية برقم صاحب الحساب — كود عبر واتساب، بلا أي توكن فالتطبيق ----
      // الكود كيتخزن هنا فالسيرفر فقط (Cache API، 5 دقايق)، ماشي فالمتصفح، وماشي فالتطبيق.
      if (url.pathname === "/wa-otp-send" && request.method === "POST") {
        const { target } = await request.json();
        if (target !== "admin" && target !== "teacher") return json({ error: "invalid_target" }, 400, origin);
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId || !env.WA_INSTANCE_ID || !env.WA_TOKEN) return json({ error: "wa_not_configured" }, 500, origin);
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
        const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const cache = caches.default;
        await cache.put(
          rlKey("wa-otp-" + target, "hash"),
          new Response(JSON.stringify({ hash: hashHex, attempts: 0, chatId }), { headers: { "Cache-Control": "max-age=300" } })
        );
        const label = target === "admin" ? "رشيد" : "عائشة";
        const message = `🔐 رمز تفعيل تقارير واتساب\n\nالحساب: ${label}\nالرمز: ${code}\n\nصالح لمدة 5 دقائق، ولا تشاركه مع أي شخص.`;
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message }) }
        );
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.idMessage) return json({ error: "send_failed" }, 502, origin);
        return json({ ok: true }, 200, origin);
      }

      // ---- WhatsApp: تأكيد كود التفعيل — المقارنة كتصير هنا فالسيرفر، الكود ماكيوصلش للمتصفح ----
      if (url.pathname === "/wa-otp-verify" && request.method === "POST") {
        const { target, code } = await request.json();
        if (target !== "admin" && target !== "teacher") return json({ error: "invalid_target" }, 400, origin);
        const cache = caches.default;
        const cached = await cache.match(rlKey("wa-otp-" + target, "hash"));
        if (!cached) return json({ ok: false, error: "expired" }, 200, origin);
        const pending = await cached.json();
        if ((pending.attempts || 0) >= 5) {
          await cache.delete(rlKey("wa-otp-" + target, "hash"));
          return json({ ok: false, error: "too_many_attempts" }, 200, origin);
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(code || "").trim()));
        const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (hashHex !== pending.hash) {
          pending.attempts = (pending.attempts || 0) + 1;
          await cache.put(rlKey("wa-otp-" + target, "hash"), new Response(JSON.stringify(pending), { headers: { "Cache-Control": "max-age=300" } }));
          return json({ ok: false, error: "wrong_code" }, 200, origin);
        }
        await cache.delete(rlKey("wa-otp-" + target, "hash"));
        return json({ ok: true, chatId: pending.chatId }, 200, origin);
      }

      // ---- WhatsApp: تمرير عام (Relay) لأي عملية Green API — بلا ما يوصل التوكن للتطبيق أبدا ----
      if (url.pathname === "/wa-relay" && request.method === "POST") {
        const { endpoint, params, httpMethod, pathSuffix } = await request.json();
        const allowedEndpoints = ["sendMessage", "deleteMessage", "getChatHistory", "getMessage", "getStateInstance", "receiveNotification", "deleteNotification"];
        if (!allowedEndpoints.includes(endpoint)) return json({ error: "endpoint_not_allowed" }, 400, origin);
        let apiUrl = `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/${endpoint}/${env.WA_TOKEN}`;
        if (pathSuffix) apiUrl += `/${encodeURIComponent(pathSuffix)}`;
        const method = httpMethod || "POST";
        if ((method === "GET" || method === "DELETE") && params) apiUrl += "?" + new URLSearchParams(params).toString();
        const r = await fetch(apiUrl, method === "GET" ? undefined : method === "DELETE" ? { method: "DELETE" } : {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}),
        });
        const j = await r.json().catch(() => null);
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: تمرير رفع ملف (FormData) — بديل عام لـ sendFileByUpload بلا توكن فالتطبيق ----
      if (url.pathname === "/wa-file-relay" && request.method === "POST") {
        const incoming = await request.formData();
        const chatId = incoming.get("chatId");
        const file = incoming.get("file");
        const caption = incoming.get("caption") || "";
        if (!chatId || !file) return json({ error: "missing_params" }, 400, origin);
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("caption", caption);
        form.append("file", file, file.name || "file.png");
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendFileByUpload/${env.WA_TOKEN}`,
          { method: "POST", body: form }
        );
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- Telegram ----
      if (url.pathname === "/tg" && request.method === "POST") {
        const { text } = await request.json();
        const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
        });
        const j = await r.json();
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- Telegram: تعديل رسالة موجودة فمكانها (بلا حذف ولا رسالة جديدة) ----
      if (url.pathname === "/tg-edit" && request.method === "POST") {
        const { message_id, text } = await request.json();
        if (!message_id || !text) return json({ error: "missing_params" }, 400, origin);
        const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TG_CHAT_ID, message_id, text }),
        });
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- GitHub upload/update (Contents API) ----
      if (url.pathname === "/gh-upload" && request.method === "POST") {
        const { filename, contentBase64 } = await request.json();
        const apiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(filename)}`;
        let sha;
        const getRes = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" } });
        if (getRes.ok) sha = (await getRes.json()).sha;
        const putRes = await fetch(apiUrl, {
          method: "PUT",
          headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "backup update", content: contentBase64, sha }),
        });
        const j = await putRes.json();
        return json(j, putRes.ok ? 200 : 502, origin);
      }

      // ---- GitHub download ----
      if (url.pathname === "/gh-download" && request.method === "GET") {
        const filename = url.searchParams.get("filename");
        const apiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodeURIComponent(filename)}`;
        const r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" } });
        if (!r.ok) return json({ error: "not_found" }, 404, origin);
        const j = await r.json();
        const content = atob(j.content.replace(/\n/g, ""));
        return json({ content }, 200, origin);
      }

      // ---- GitHub Gist: إنشاء/تحديث (Light Cloud backup) — التوكن مخبأ هنا فقط ----
      if (url.pathname === "/gh-gist-upsert" && request.method === "POST") {
        const { gistId, content } = await request.json();
        if (typeof content !== "string") return json({ error: "missing_content" }, 400, origin);
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GH_GIST_TOKEN}`,
          Accept: "application/vnd.github+json",
        };
        const body = JSON.stringify({
          description: "Tatabbou Light Backup",
          public: false,
          files: { "backup.json": { content } },
        });
        if (gistId) {
          const r = await fetch(`https://api.github.com/gists/${gistId}`, { method: "PATCH", headers, body });
          if (r.ok) {
            const j = await r.json();
            return json({ ok: true, id: j.id }, 200, origin);
          }
          // إلا الـ Gist تحيد أو الـ ID خاطئ، دير واحد جديد
        }
        const r2 = await fetch("https://api.github.com/gists", { method: "POST", headers, body });
        if (!r2.ok) return json({ error: "gist_create_failed" }, 502, origin);
        const j2 = await r2.json();
        return json({ ok: true, id: j2.id }, 200, origin);
      }

      // ---- GitHub Gist: قراءة ----
      if (url.pathname === "/gh-gist-fetch" && request.method === "GET") {
        const gistId = url.searchParams.get("gistId");
        if (!gistId) return json({ error: "missing_gistId" }, 400, origin);
        const r = await fetch(`https://api.github.com/gists/${gistId}`, {
          headers: { Authorization: `Bearer ${env.GH_GIST_TOKEN}`, Accept: "application/vnd.github+json" },
        });
        if (!r.ok) return json({ error: "not_found" }, 404, origin);
        const j = await r.json();
        const file = j.files && j.files["backup.json"];
        if (!file) return json({ error: "file_missing" }, 404, origin);
        return json({ content: file.content }, 200, origin);
      }

      // ---- JSONBin.io: رفع/قراءة (Light Cloud backup) ----
      if (url.pathname === "/jsonbin-upload" && request.method === "POST") {
        const { list } = await request.json();
        const r = await fetch(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
          body: JSON.stringify(list),
        });
        return json({ ok: r.ok }, r.ok ? 200 : 502, origin);
      }
      if (url.pathname === "/jsonbin-fetch" && request.method === "GET") {
        const r = await fetch(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}/latest`, {
          headers: { "X-Master-Key": env.JSONBIN_API_KEY },
        });
        if (!r.ok) return json({ error: "fetch_failed" }, 502, origin);
        const j = await r.json();
        return json({ record: j.record }, 200, origin);
      }

      // ---- RestDB.io: رفع/قراءة (Light Cloud backup) ----
      if (url.pathname === "/restdb-upload" && request.method === "POST") {
        const { list } = await request.json();
        const headers = { "Content-Type": "application/json", "x-apikey": env.RESTDB_API_KEY, "cache-control": "no-cache" };
        try {
          const old = await fetch(`${env.RESTDB_BASE_URL}?q={}`, { headers });
          const oldJ = await old.json().catch(() => []);
          for (const row of oldJ || []) {
            await fetch(`${env.RESTDB_BASE_URL}/${row._id}`, { method: "DELETE", headers }).catch(() => {});
          }
        } catch (e) {}
        const r = await fetch(env.RESTDB_BASE_URL, {
          method: "POST", headers,
          body: JSON.stringify({ students: list, updatedAt: new Date().toISOString() }),
        });
        return json({ ok: r.ok }, r.ok ? 200 : 502, origin);
      }
      if (url.pathname === "/restdb-fetch" && request.method === "GET") {
        const headers = { "x-apikey": env.RESTDB_API_KEY };
        const r = await fetch(`${env.RESTDB_BASE_URL}?h=${encodeURIComponent(JSON.stringify({ $orderby: { _id: -1 } }))}&max=1`, { headers });
        if (!r.ok) return json({ error: "fetch_failed" }, 502, origin);
        const rows = await r.json();
        return json({ row: (rows && rows[0]) || null }, 200, origin);
      }

      // ---- Baserow: رفع/قراءة (Light Cloud backup) ----
      if (url.pathname === "/baserow-upload" && request.method === "POST") {
        const { list } = await request.json();
        const headers = { "Content-Type": "application/json", Authorization: "Token " + env.BASEROW_TOKEN };
        const tableUrl = `https://api.baserow.io/api/database/rows/table/${env.BASEROW_TABLE_ID}/?user_field_names=true`;
        try {
          const old = await fetch(tableUrl, { headers });
          const oldJ = await old.json().catch(() => ({ results: [] }));
          for (const row of oldJ.results || []) {
            await fetch(`${tableUrl.split("?")[0]}${row.id}/`, { method: "DELETE", headers }).catch(() => {});
          }
        } catch (e) {}
        const r = await fetch(tableUrl, {
          method: "POST", headers,
          body: JSON.stringify({ data: JSON.stringify(list), updated_at: new Date().toISOString() }),
        });
        return json({ ok: r.ok }, r.ok ? 200 : 502, origin);
      }
      if (url.pathname === "/baserow-fetch" && request.method === "GET") {
        const headers = { Authorization: "Token " + env.BASEROW_TOKEN };
        const r = await fetch(`https://api.baserow.io/api/database/rows/table/${env.BASEROW_TABLE_ID}/?user_field_names=true`, { headers });
        if (!r.ok) return json({ error: "fetch_failed" }, 502, origin);
        const j = await r.json();
        return json({ row: (j.results || [])[0] || null }, 200, origin);
      }

      // ---- Backendless: رفع/قراءة (Light Cloud backup) ----
      if (url.pathname === "/backendless-upload" && request.method === "POST") {
        const { list } = await request.json();
        const base = `https://api.backendless.com/${env.BACKENDLESS_APP_ID}/${env.BACKENDLESS_API_KEY}/data/${env.BACKENDLESS_TABLE_NAME}`;
        const headers = { "Content-Type": "application/json" };
        try {
          const old = await fetch(base, { headers });
          const oldJ = await old.json().catch(() => []);
          for (const row of oldJ || []) {
            await fetch(`${base}/${row.objectId}`, { method: "DELETE", headers }).catch(() => {});
          }
        } catch (e) {}
        const r = await fetch(base, {
          method: "POST", headers,
          body: JSON.stringify({ data: JSON.stringify(list), updatedAt: new Date().toISOString() }),
        });
        return json({ ok: r.ok }, r.ok ? 200 : 502, origin);
      }
      if (url.pathname === "/backendless-fetch" && request.method === "GET") {
        const base = `https://api.backendless.com/${env.BACKENDLESS_APP_ID}/${env.BACKENDLESS_API_KEY}/data/${env.BACKENDLESS_TABLE_NAME}`;
        const r = await fetch(base);
        if (!r.ok) return json({ error: "fetch_failed" }, 502, origin);
        const rows = await r.json();
        return json({ row: (rows || [])[0] || null }, 200, origin);
      }

      // ---- Dropbox: رفع/قراءة (Light Cloud backup) — refresh token يتجدد فـ كل طلب ----
      if (url.pathname === "/dropbox-upload" && request.method === "POST") {
        const { list } = await request.json();
        const accessToken = await getDropboxAccessToken(env);
        const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": JSON.stringify({ path: "/tatabbou-backup.json", mode: "overwrite", mute: true }),
            "Content-Type": "application/octet-stream",
          },
          body: JSON.stringify(list),
        });
        return json({ ok: r.ok }, r.ok ? 200 : 502, origin);
      }
      if (url.pathname === "/dropbox-fetch" && request.method === "GET") {
        const accessToken = await getDropboxAccessToken(env);
        const r = await fetch("https://content.dropboxapi.com/2/files/download", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": JSON.stringify({ path: "/tatabbou-backup.json" }),
          },
        });
        if (!r.ok) return json({ error: "not_found" }, 404, origin);
        const text = await r.text();
        return json({ content: text }, 200, origin);
      }

      // ---- Upstash Redis: رفع/قراءة (Light Cloud backup) ----
      if (url.pathname === "/upstash-upload" && request.method === "POST") {
        const { list } = await request.json();
        const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/tatabbou-backup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "text/plain" },
          body: JSON.stringify(list),
        });
        const j = await r.json().catch(() => null);
        return json({ ok: !!(r.ok && j && j.result === "OK") }, r.ok ? 200 : 502, origin);
      }
      if (url.pathname === "/upstash-fetch" && request.method === "GET") {
        const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/tatabbou-backup`, {
          headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
        });
        if (!r.ok) return json({ error: "fetch_failed" }, 502, origin);
        const j = await r.json();
        return json({ value: j.result }, 200, origin);
      }

      // ---- TTS: تحويل نص لصوت عبر Google Translate (بلا API key) — كيستعملو التطبيق باش يقول "خالص" ----
      if (url.pathname === "/tts" && request.method === "GET") {
        const text = (url.searchParams.get("text") || "").slice(0, 200);
        const lang = url.searchParams.get("lang") || "ar";
        if (!text) return json({ error: "missing_text" }, 400, origin);
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
        const r = await fetch(ttsUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://translate.google.com/",
          },
        });
        if (!r.ok) return json({ error: "tts_failed" }, 502, origin);
        const buf = await r.arrayBuffer();
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=604800",
            ...corsHeaders(origin),
          },
        });
      }

      // ---- Firebase: قراءة مسار ----
      if (url.pathname === "/fb-read" && request.method === "GET") {
        const path = url.searchParams.get("path"); // مثال: users/xxx/students.json
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(path || "")) {
          return json({ error: "invalid_path" }, 400, origin);
        }
        const authR = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FB_API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
        });
        const authJ = await authR.json();
        if (!authR.ok || !authJ.idToken) return json({ error: "auth_failed" }, 502, origin);
        const r = await fetch(`${env.FB_DATABASE_URL}/${path}?auth=${authJ.idToken}`);
        const j = await r.json().catch(() => null);
        return json({ data: j }, r.ok ? 200 : 502, origin);
      }

      // ---- Firebase: كتابة ----
      if (url.pathname === "/fb-write" && request.method === "POST") {
        const body = await request.json(); // { path, data, method }
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(body.path || "")) {
          return json({ error: "invalid_path" }, 400, origin);
        }
        if (!Array.isArray(body.data)) {
          return json({ error: "invalid_data" }, 400, origin);
        }
        const authR = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FB_API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
        });
        const authJ = await authR.json();
        if (!authR.ok || !authJ.idToken) return json({ error: "auth_failed" }, 502, origin);
        const dbUrl = `${env.FB_DATABASE_URL}/${body.path}?auth=${authJ.idToken}`;
        const r = await fetch(dbUrl, { method: body.method || "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body.data) });
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      return json({ error: "not_found" }, 404, origin);
    } catch (e) {
      return json({ error: String(e) }, 500, origin);
    }
  },
};
