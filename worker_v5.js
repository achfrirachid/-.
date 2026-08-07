/**
 * Cloudflare Worker: Backup Proxy (V5 - كامل ومتوافق 100% مع التطبيق)
 * -------------------------------------------------------------------
 * Environment Variables (Settings → Variables and Secrets):
 *   PROXY_SECRET - نفس القيمة اللي حاطة فحقل "مفتاح Cloudflare Worker" فالتطبيق
 * R2 Binding (Settings → Bindings → Add → R2 Bucket):
 *   Variable name: BACKUP_BUCKET
 *
 * ⭐ التوكنات ديال Telegram/GitHub/Dropbox كيتصيفطو من التطبيق نفسو (مسجلين فـ
 *   localStorage ديال الهاتف)، ماشي مخبأين فالـ Worker — هادشي كيخلي التركيب أسهل
 *   بزاف (خاصك غير PROXY_SECRET، بلا ما تحتاج تزيد توكنات فـ Cloudflare).
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

    // 1. اختبار بلا Auth — باش تتأكد الرابط صحيح
    if (path === "/hello") {
      return json({ ok: true, message: "URL is correct! Worker is reachable." });
    }

    // 2. التحقق من المفتاح السري
    const authHeader = request.headers.get("Authorization") || "";
    const providedSecret = authHeader.replace("Bearer ", "").trim();
    const actualSecret = (env.PROXY_SECRET || "").trim();

    if (path === "/test-auth") {
      if (actualSecret && providedSecret === actualSecret) {
        return json({ ok: true, message: "Secret Key is CORRECT!" });
      }
      return json({ ok: false, detail: "Secret Key mismatch!" }, 401);
    }

    if (!actualSecret || providedSecret !== actualSecret) {
      return json({ ok: false, detail: "Unauthorized" }, 401);
    }

    try {
      // ================= TELEGRAM =================
      if (path === "/telegram/upload" && request.method === "POST") {
        const { data, token, chatId } = await request.json();
        if (!token || !chatId) return json({ ok: false, detail: "missing token/chatId" }, 400);
        const formData = new FormData();
        formData.append("chat_id", chatId);
        formData.append("document", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "backup.json");
        const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: formData });
        const tgJson = await res.json();
        if (!tgJson.ok) return json({ ok: false, detail: tgJson.description || "telegram send failed" }, 502);
        return json({ ok: true });
      }

      if (path === "/telegram/fetch" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const chatId = url.searchParams.get("chatId");
        if (!token || !chatId) return json({ ok: false, detail: "missing token/chatId" }, 400);
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50`);
        const upd = await res.json();
        const results = (upd.result || []).slice().reverse();
        const msg = results.find(u => u.message && u.message.chat && String(u.message.chat.id) === String(chatId) && u.message.document);
        if (!msg) return json({ ok: false, detail: "no backup found" }, 404);
        const fileRes = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${msg.message.document.file_id}`)).json();
        if (!fileRes.ok) return json({ ok: false, detail: "getFile failed" }, 502);
        const content = await (await fetch(`https://api.telegram.org/file/bot${token}/${fileRes.result.file_path}`)).text();
        return json({ ok: true, data: JSON.parse(content) });
      }

      // ================= GITHUB =================
      if (path === "/github/upload" && request.method === "POST") {
        const { data, token, repo, path: fPath, branch } = await request.json();
        if (!token || !repo) return json({ ok: false, detail: "missing token/repo" }, 400);
        const apiUrl = `https://api.github.com/repos/${repo}/contents/${fPath || "backup.json"}`;
        const getRes = await fetch(`${apiUrl}?ref=${branch || "main"}`, { headers: { Authorization: `token ${token}`, "User-Agent": "talaba-backup-worker" } });
        const sha = getRes.ok ? (await getRes.json()).sha : undefined;

        const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
        let binary = "";
        bytes.forEach(b => (binary += String.fromCharCode(b)));
        const b64 = btoa(binary);

        const putRes = await fetch(apiUrl, {
          method: "PUT",
          headers: { Authorization: `token ${token}`, "User-Agent": "talaba-backup-worker", "Content-Type": "application/json" },
          body: JSON.stringify({ message: `backup ${new Date().toISOString()}`, content: b64, branch: branch || "main", ...(sha ? { sha } : {}) }),
        });
        if (!putRes.ok) {
          const err = await putRes.json().catch(() => ({}));
          return json({ ok: false, detail: err.message || "github upload failed" }, 502);
        }
        return json({ ok: true });
      }

      if (path === "/github/fetch" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const repo = url.searchParams.get("repo");
        const fPath = url.searchParams.get("path") || "backup.json";
        const branch = url.searchParams.get("branch") || "main";
        if (!token || !repo) return json({ ok: false, detail: "missing token/repo" }, 400);
        const apiUrl = `https://api.github.com/repos/${repo}/contents/${fPath}`;
        const res = await fetch(`${apiUrl}?ref=${branch}`, { headers: { Authorization: `token ${token}`, "User-Agent": "talaba-backup-worker" } });
        if (!res.ok) return json({ ok: false, detail: "no backup found" }, 404);
        const j = await res.json();
        const decoded = decodeURIComponent(escape(atob(j.content.replace(/\n/g, ""))));
        return json({ ok: true, data: JSON.parse(decoded) });
      }

      // ================= DROPBOX =================
      if (path === "/dropbox/upload" && request.method === "POST") {
        const { data, token, path: fPath } = await request.json();
        if (!token) return json({ ok: false, detail: "missing token" }, 400);
        const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Dropbox-API-Arg": JSON.stringify({ path: fPath || "/backup.json", mode: "overwrite", mute: true }),
            "Content-Type": "application/octet-stream",
          },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return json({ ok: false, detail: errText.slice(0, 200) || "dropbox upload failed" }, 502);
        }
        return json({ ok: true });
      }

      if (path === "/dropbox/fetch" && request.method === "GET") {
        const token = url.searchParams.get("token");
        const fPath = url.searchParams.get("path") || "/backup.json";
        if (!token) return json({ ok: false, detail: "missing token" }, 400);
        const res = await fetch("https://content.dropboxapi.com/2/files/download", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: fPath }) },
        });
        if (!res.ok) return json({ ok: false, detail: "no backup found" }, 404);
        const text = await res.text();
        return json({ ok: true, data: JSON.parse(text) });
      }

      // ================= CLOUDFLARE R2 =================
      if (path === "/r2/upload" && request.method === "POST") {
        if (!env.BACKUP_BUCKET) return json({ ok: false, detail: "R2 binding missing" }, 500);
        const { uid, data, updatedAt } = await request.json();
        if (!uid) return json({ ok: false, detail: "uid required" }, 400);
        await env.BACKUP_BUCKET.put(`backup-${uid}.json`, JSON.stringify({ data, updatedAt: updatedAt || Date.now() }), {
          httpMetadata: { contentType: "application/json" },
        });
        return json({ ok: true });
      }

      if (path === "/r2/fetch" && request.method === "GET") {
        if (!env.BACKUP_BUCKET) return json({ ok: false, detail: "R2 binding missing" }, 500);
        const uid = url.searchParams.get("uid");
        if (!uid) return json({ ok: false, detail: "uid required" }, 400);
        const obj = await env.BACKUP_BUCKET.get(`backup-${uid}.json`);
        if (!obj) return json({ ok: false, detail: "no backup found" }, 404);
        const parsed = JSON.parse(await obj.text());
        return json({ ok: true, data: parsed.data, record: parsed });
      }

      return json({ ok: false, detail: "path not handled: " + path }, 404);
    } catch (e) {
      return json({ ok: false, detail: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
