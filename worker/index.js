/* ログインを続けるための小さなサーバー
   Googleの秘密の鍵（クライアントシークレット）はブラウザに置けないので、ここで預かる。
   - POST /token   { code, redirect_uri, code_verifier } → ログイン直後のコードを、トークンと交換する
   - POST /refresh { refresh_token }                    → 新しいアクセストークンをもらう
   - GET  /status                                        → 準備ができているか（秘密の鍵が登録済みか）
   このアプリのページ（下の ORIGINS）からしか使えない */
const ORIGINS = ['https://nishimura2858.github.io', 'http://localhost:8000'];
const REDIRECTS = ['https://nishimura2858.github.io/pdf-tegaki/', 'http://localhost:8000/'];

function reply(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin'
    }
  });
}
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const path = new URL(req.url).pathname;
    if (req.method === 'OPTIONS') return reply({}, 204, origin);
    if (!ORIGINS.includes(origin)) return reply({ error: 'origin_not_allowed' }, 403, origin);
    const ready = !!(env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CLIENT_ID);
    if (path === '/status') return reply({ ready }, 200, origin);
    if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, origin);
    if (!ready) return reply({ error: 'not_configured' }, 503, origin);

    let b;
    try { b = await req.json(); } catch (e) { return reply({ error: 'bad_request' }, 400, origin); }
    let params;
    if (path === '/token') {
      if (!str(b.code, 2048) || !REDIRECTS.includes(b.redirect_uri) || !str(b.code_verifier, 128))
        return reply({ error: 'bad_request' }, 400, origin);
      params = { grant_type: 'authorization_code', code: b.code, redirect_uri: b.redirect_uri, code_verifier: b.code_verifier };
    } else if (path === '/refresh') {
      if (!str(b.refresh_token, 2048)) return reply({ error: 'bad_request' }, 400, origin);
      params = { grant_type: 'refresh_token', refresh_token: b.refresh_token };
    } else {
      return reply({ error: 'not_found' }, 404, origin);
    }
    params.client_id = env.GOOGLE_CLIENT_ID;
    params.client_secret = env.GOOGLE_CLIENT_SECRET;

    let r, d;
    try {
      r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params)
      });
      d = await r.json();
    } catch (e) {
      return reply({ error: 'google_unreachable' }, 502, origin);
    }
    // 必要なものだけ返す
    const out = {};
    ['access_token', 'expires_in', 'refresh_token', 'scope', 'error', 'error_description'].forEach(k => {
      if (d[k] !== undefined) out[k] = d[k];
    });
    return reply(out, r.status, origin);
  }
};
