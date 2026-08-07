// Cloudflare Worker — نسخ احتياطي بسيط عبر Workers KV (بلا بطاقة بنكية)
// يستقبل POST (تخزين) و GET (استرجاع)، محمي بمفتاح سري (Bearer token)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '').trim();

    if (token !== env.SECRET_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST — تخزين نسخة احتياطية
    if (request.method === 'POST') {
      const body = await request.json();
      const uid = body.uid;
      if (!uid) {
        return new Response(JSON.stringify({ error: 'uid required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      await env.BACKUP_KV.put(`backup-${uid}`, JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // GET — استرجاع نسخة احتياطية
    if (request.method === 'GET') {
      const uid = url.searchParams.get('uid');
      if (!uid) {
        return new Response(JSON.stringify({ error: 'uid required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      const stored = await env.BACKUP_KV.get(`backup-${uid}`);
      if (!stored) {
        return new Response(JSON.stringify({ data: null }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      return new Response(stored, {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
};
