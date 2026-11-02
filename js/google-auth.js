/* Googleログイン（アクセストークンの取得）
   - 通常のブラウザ: ポップアップ方式（Google Identity Services）
   - ホーム画面から起動したとき: ページ遷移するリダイレクト方式
   URLに ?auth=popup または ?auth=redirect を付けると方式を固定できる（動作確認用） */
(function () {
  'use strict';
  var C = window.APP_CONFIG;
  var TOKEN_KEY = 'gauth:token', STATE_KEY = 'gauth:state', AFTER_KEY = 'gauth:after';
  var token = null, expiresAt = 0;

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function mode() {
    var m = new URLSearchParams(location.search).get('auth');
    if (m === 'popup' || m === 'redirect') return m;
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
  function fail(code) { return new Error(code); }

  /* ---------- ポップアップ方式 ---------- */
  function requestPopup() {
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
      client.requestAccessToken({ prompt: '' });
    });
  }

  /* ---------- リダイレクト方式 ---------- */
  function randomState() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function startRedirect(after) {
    var state = randomState();
    store(STATE_KEY, state);
    store(AFTER_KEY, after || null);
    var q = new URLSearchParams({
      client_id: C.CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: C.SCOPE,
      include_granted_scopes: 'true',
      state: state
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  }
  // リダイレクトで戻ってきたときに、URLの # 以降からトークンを受け取る
  function consumeRedirect() {
    var h = location.hash;
    if (!h || (h.indexOf('access_token=') < 0 && h.indexOf('error=') < 0)) return null;
    var p = new URLSearchParams(h.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    var expected = read(STATE_KEY); store(STATE_KEY, null);
    if (!expected || p.get('state') !== expected) return { error: 'state_mismatch' };
    if (p.get('error')) return { error: p.get('error') };
    var scopes = (p.get('scope') || '').split(' ');
    if (scopes.indexOf(C.SCOPE) < 0) return { error: 'scope_denied' };
    saveToken(p.get('access_token'), +p.get('expires_in') || 3600);
    return { ok: true };
  }

  loadToken();

  window.GAuth = {
    mode: mode,
    hasToken: valid,
    /* 有効なトークンを返す。リダイレクト方式ではページを離れるので、戻ってこない Promise を返す。
       after: 戻ってきたあとに続けたい操作の名前 */
    getToken: function (after) {
      if (valid()) return Promise.resolve(token);
      if (mode() === 'redirect') { startRedirect(after); return new Promise(function () {}); }
      return requestPopup();
    },
    invalidate: function () { token = null; expiresAt = 0; store(TOKEN_KEY, null); },
    consumeRedirect: consumeRedirect,
    takeAfter: function () { var a = read(AFTER_KEY); store(AFTER_KEY, null); return a; }
  };
})();
