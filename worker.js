// ============================================================
// Worker وسيط — كيخبي جميع التوكنات، لا التطبيق ولا ملف الهاتف فيهم حتى توكن
// ============================================================

const ALLOWED_ORIGINS = ["*"]; // بدلها بـ ["https://achfrirachid.github.io"] (رابط GitHub Pages ديالك)

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // 🔒 حماية: كل طلب خاصو المفتاح السري فالـ header، غير كذلك كيترفض
    const key = request.headers.get("X-Proxy-Key") || "";
    if (!env.PROXY_KEY || key !== env.PROXY_KEY) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    try {
      // ---- WhatsApp (green-api) ----
      if (url.pathname === "/wa" && request.method === "POST") {
        const { text } = await request.json();
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: env.WA_CHAT_ID, message: text }) }
        );
        const j = await r.json();
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

      // ---- Dropbox upload ----
      if (url.pathname === "/dbx-upload" && request.method === "POST") {
        const { path, content } = await request.json();
        const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.DBX_TOKEN}`, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }) },
          body: content,
        });
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- Dropbox download ----
      if (url.pathname === "/dbx-download" && request.method === "GET") {
        const path = url.searchParams.get("path");
        const r = await fetch("https://content.dropboxapi.com/2/files/download", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.DBX_TOKEN}`, "Dropbox-API-Arg": JSON.stringify({ path }) },
        });
        if (!r.ok) return json({ error: "not_found" }, 404, origin);
        const text = await r.text();
        return json({ content: text }, 200, origin);
      }

      // ---- Firebase: قراءة مسار ----
      if (url.pathname === "/fb-read" && request.method === "GET") {
        const path = url.searchParams.get("path"); // مثال: users/xxx/students.json
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
