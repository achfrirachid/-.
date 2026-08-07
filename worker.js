// ==========================================================
// Cloudflare Worker - نسخة احتياطية (Backup) لتطبيق تتبع دفوعات الطلبة
// كيخزن البيانات فـ Cloudflare R2، ومحمي بمفتاح سري (Bearer Token)
// ==========================================================
//
// شنو كيدير:
//  - POST  → كيسجل/كيحدث نسخة احتياطية ديال المستخدم (uid) فـ R2
//  - GET   → كيرجع آخر نسخة محفوظة ديال المستخدم (uid)
//  - كل طلب خاصو يجيب "Authorization: Bearer <السر ديالك>" وإلا كيرفض (401)
//
// هاد الملف كيتوافق 100% مع الكود ديال التطبيق (الدوال cfUploadBackup و cfFetchBackup)

export default {
  async fetch(request, env) {
    // ✅ إعدادات CORS (باش الموقع يقدر يتصل بالـ Worker من المتصفح)
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // ✅ طلب Preflight ديال المتصفح
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ✅ التحقق من المفتاح السري (لازم يكون مطابق للسر المخزن فـ env.CF_SECRET)
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!env.CF_SECRET || token !== env.CF_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);

    // ---------------------------------------------------------
    // POST: صيفط نسخة احتياطية جديدة (upload)
    // Body متوقع: { uid, data, updatedAt }
    // ---------------------------------------------------------
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const uid = body && body.uid;
      if (!uid) {
        return new Response(JSON.stringify({ error: 'Missing uid' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const record = {
        data: body.data,
        updatedAt: body.updatedAt || Date.now(),
      };

      await env.BACKUP_BUCKET.put(`${uid}.json`, JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json' },
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------
    // GET: رجّع آخر نسخة احتياطية محفوظة (fetch/restore)
    // Query متوقع: ?uid=xxxx
    // ---------------------------------------------------------
    if (request.method === 'GET') {
      const uid = url.searchParams.get('uid');
      if (!uid) {
        return new Response(JSON.stringify({ error: 'Missing uid' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const obj = await env.BACKUP_BUCKET.get(`${uid}.json`);
      if (!obj) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const text = await obj.text();
      return new Response(text, {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------
    // أي طريقة أخرى: مرفوضة
    // ---------------------------------------------------------
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
