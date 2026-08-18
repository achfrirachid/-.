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

      // ---- WhatsApp: تنظيف تقارير التطبيق — يبقى أحدث 3 تقارير فقط ----
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
          return body.includes("تقرير إضافة طلبة من ملف الهاتف");
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
