/* Googleログイン（アクセストークンの取得）
   ■ ログインを続ける方式（ふだんはこちら）
     ログインサーバー（Cloudflare Workers、worker/ フォルダ）が準備できていれば、
     一度ログインすると「更新用の鍵（リフレッシュトークン）」をこの端末に保存し、
     1時間ごとのログイン切れを、画面を出さずに自動で更新する
   ■ 1時間ごとにログインする方式（サーバーが使えないときの予備）
     - 通常のブラウザ: ポップアップ方式（Google Identity Services）
     - ホーム画面から起動したとき: ページ遷移するリダイレクト方式
   URLに ?auth=popup または ?auth=redirect を付けると、予備の方式に固定できる（動作確認用） */
(function () {
  'use strict';
  var C = window.APP_CONFIG;
  // 権限を drive.file → drive に広げたので、前の権限のトークンは使わない（キー名を変えた）
  var TOKEN_KEY = 'gauth:token:drive', REFRESH_KEY = 'gauth:refresh',
    STATE_KEY = 'gauth:state', AFTER_KEY = 'gauth:after', VERIFIER_KEY = 'gauth:verifier';
  var token = null, expiresAt = 0, refreshP = null, serverP = null, serverOk = null;

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function fail(code) { return new Error(code); }

  function forced() {
    var m = new URLSearchParams(location.search).get('auth');
    return m === 'popup' || m === 'redirect' ? m : null;
  }
  function mode() {
    var m = forced(); if (m) return m;
    var standalone = window.navigator.standalone === true ||
      (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    return standalone ? 'redirect' : 'popup';
  }
  // Google Cloudに登録したリダイレクトURIと完全一致させる（…/pdf-tegaki/ の形）
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

  function saveToken(t, sec) {
    token = t; expiresAt = Date.now() + (Math.max(120, sec) - 60) * 1000;
    store(TOKEN_KEY, JSON.stringify({ t: token, e: expiresAt }));
  }
  function loadToken() {
    try {
      var o = JSON.parse(read(TOKEN_KEY));
      if (o && o.t && o.e > Date.now()) { token = o.t; expiresAt = o.e; }
    } catch (e) {}
  }
  function valid() { return !!token && Date.now() < expiresAt; }
  function clearToken() { token = null; expiresAt = 0; store(TOKEN_KEY, null); }

  /* ---------- ログインサーバー ---------- */
  function server(path, body) {
    return fetch(C.AUTH_SERVER + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; });
    });
  }
  // サーバーが使えるか（秘密の鍵が登録済みか）。通信できないときは false（次回また確かめる）
  function checkServer() {
    if (!C.AUTH_SERVER || forced()) { serverOk = false; return Promise.resolve(false); }
    if (!serverP) serverP = server('/status').then(function (d) {
      serverOk = d.ready === true; return serverOk;
    }, function () { serverP = null; return false; });
    return serverP;
  }
  // 更新用の鍵で、新しいアクセストークンをもらう。だめなら null
  function refresh() {
    var rt = read(REFRESH_KEY);
    if (!rt) return Promise.resolve(null);
    if (!refreshP) {
      refreshP = server('/refresh', { refresh_token: rt }).then(function (d) {
        if (d.access_token) { saveToken(d.access_token, +d.expires_in || 3600); return token; }
        // 鍵が取り消された・期限切れ → 次は普通にログインしてもらう
        if (d.error === 'invalid_grant') store(REFRESH_KEY, null);
        return null;
      }, function () { return null; }).then(function (t) { refreshP = null; return t; });
    }
    return refreshP;
  }

  /* ---------- ポップアップ方式（予備） ---------- */
  function requestPopup(prompt) {
    return new Promise(function (resolve, reject) {
      var o = window.google && google.accounts && google.accounts.oauth2;
      if (!o) { reject(fail('gis_not_loaded')); return; }
      var client = o.initTokenClient({
        client_id: C.CLIENT_ID,
        scope: C.SCOPE,
        callback: function (r) {
          if (r.error) { reject(fail(r.error)); return; }
          if (!o.hasGrantedAllScopes(r, C.SCOPE)) { reject(fail('scope_denied')); return; }
          saveToken(r.access_token, +r.expires_in || 3600);
          resolve(token);
        },
        error_callback: function (e) { reject(fail((e && e.type) || 'popup_error')); }
      });
      // ユーザーのタップの直後に同期的に呼ぶ必要がある（ポップアップブロック対策）
      client.requestAccessToken({ prompt: prompt || '' });
    });
  }

  /* ---------- リダイレクト方式 ---------- */
  function randomHex(n) {
    var a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function b64url(buf) {
    var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // code: true → ログインを続ける方式（コードを受け取り、サーバーでトークンと交換する）
  async function startRedirect(after, code) {
    var state = randomHex(16);
    store(STATE_KEY, state);
    store(AFTER_KEY, after || null);
    var q = new URLSearchParams({
      client_id: C.CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: code ? 'code' : 'token',
      scope: C.SCOPE,
      include_granted_scopes: 'true',
      state: state
    });
    if (code) {
      var verifier = randomHex(32);
      store(VERIFIER_KEY, verifier);
      q.set('code_challenge', b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      q.set('code_challenge_method', 'S256');
      q.set('access_type', 'offline');
      q.set('prompt', 'consent'); // 更新用の鍵を確実にもらうため
    }
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  }
  function never() { return new Promise(function () {}); }

  /* リダイレクトで戻ってきたときに、URLから結果を受け取る。
     戻り値（Promise）: null（ログインから戻ったのではない）/ { ok: true } / { error: '…' } */
  async function consumeRedirect() {
    var h = location.hash, s = location.search;
    var fromHash = !!h && (h.indexOf('access_token=') >= 0 || h.indexOf('error=') >= 0);
    var fromQuery = !!s && s.indexOf('state=') >= 0 && (s.indexOf('code=') >= 0 || s.indexOf('error=') >= 0);
    if (!fromHash && !fromQuery) return null;
    var p = new URLSearchParams(fromHash ? h.slice(1) : s.slice(1));
    // URLから結果を消す（?auth=… などの指定は残す）
    var keep = new URLSearchParams(s);
    ['code', 'state', 'scope', 'authuser', 'prompt', 'hd', 'error', 'error_description', 'iss'].forEach(function (k) { keep.delete(k); });
    var qs = keep.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    var expected = read(STATE_KEY); store(STATE_KEY, null);
    if (!expected || p.get('state') !== expected) return { error: 'state_mismatch' };
    if (p.get('error')) return { error: p.get('error') };
    function hasScope(str) { return String(str || '').split(' ').indexOf(C.SCOPE) >= 0; }
    if (fromHash) {
      if (!hasScope(p.get('scope'))) return { error: 'scope_denied' };
      saveToken(p.get('access_token'), +p.get('expires_in') || 3600);
      return { ok: true };
    }
    var verifier = read(VERIFIER_KEY); store(VERIFIER_KEY, null);
    try {
      var d = await server('/token', { code: p.get('code'), redirect_uri: redirectUri(), code_verifier: verifier || '' });
      if (!d.access_token) return { error: d.error || 'token_exchange_failed' };
      if (d.scope && !hasScope(d.scope)) return { error: 'scope_denied' };
      saveToken(d.access_token, +d.expires_in || 3600);
      if (d.refresh_token) store(REFRESH_KEY, d.refresh_token);
      return { ok: true };
    } catch (e) {
      return { error: 'token_exchange_failed' };
    }
  }

  loadToken();
  checkServer();

  window.GAuth = {
    mode: mode,
    /* ログイン画面を出さずに使える状態か（更新用の鍵があれば true） */
    hasToken: function () { return valid() || !!read(REFRESH_KEY); },
    /* いま使えるトークン。なければ null（自動更新はしない） */
    current: function () { return valid() ? token : null; },
    /* 使えるトークン。切れていれば、更新用の鍵で画面を出さずに更新する。だめなら null */
    ensure: function () { return valid() ? Promise.resolve(token) : refresh(); },
    /* 有効なトークンを返す。必要ならログイン画面を出す（タップの直後に呼ぶこと）。
       リダイレクト方式ではページを離れるので、戻ってこない Promise を返す。
       after: 戻ってきたあとに続けたい操作の名前 */
    getToken: function (after) {
      if (valid()) return Promise.resolve(token);
      if (read(REFRESH_KEY)) {
        // 自動更新を試す。だめならログインし直し（待ったあとなのでポップアップは使えない → ページ遷移で）
        return refresh().then(function (t) {
          if (t) return t;
          startRedirect(after, serverOk === true); return never();
        });
      }
      if (serverOk === true) { startRedirect(after, true); return never(); }
      if (mode() === 'redirect') { startRedirect(after, false); return never(); }
      return requestPopup(); // タップの直後に同期的に開く
    },
    invalidate: clearToken,
    consumeRedirect: consumeRedirect,
    takeAfter: function () { var a = read(AFTER_KEY); store(AFTER_KEY, null); return a; },
    checkServer: checkServer
  };
})();
