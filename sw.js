/* 電波がなくても開けるようにする（サービスワーカー）
   - アプリの部品（HTML・CSS・JS・アイコン・pdf.js など）を、この端末に取っておく
   - ページ本体（index.html）は「通信できればネットから、だめなら控えから」。更新はふだんどおり届く
   - 新しい版が入ったら、アプリに戻ってきたときに自動で読み直す（index.html の下のほう）
   - ?v= 付きの部品とライブラリは「控えがあれば控えから」（v が変われば別の物として取り直す）
   - Googleのログイン・Drive・ログインサーバーへの通信は、取っておかない（いつもネットへ）
   index.html の ?v= を上げたら、下の V も同じ番号にすること（古い控えを片づけるため） */
var V = '38';
var CACHE = 'tegaki-v' + V;
var CORE = [
  './',
  'index.html?v=' + V,
  'css/app.css?v=' + V,
  'js/config.js?v=' + V, 'js/app.js?v=' + V, 'js/shapes.js?v=' + V, 'js/toolbar.js?v=' + V,
  'js/lasso.js?v=' + V, 'js/pages.js?v=' + V, 'js/google-auth.js?v=' + V, 'js/drive.js?v=' + V,
  'js/drive-sync.js?v=' + V, 'js/pdf-open.js?v=' + V, 'js/pdf-write.js?v=' + V, 'js/share.js?v=' + V,
  'js/palette.js?v=' + V,
  'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/favicon-32.png', 'icons/icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/spark-md5/3.0.2/spark-md5.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // 1つ取れなくても、ほかは取っておく
    return Promise.all(CORE.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function (err) { console.warn('cache skip', u, err); });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('tegaki-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function cacheable(url) {
  if (url.origin === self.location.origin) return true;
  return url.hostname === 'cdnjs.cloudflare.com';
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (!cacheable(url)) return; // Google・Drive・ログインサーバーは、いつもネットへ

  // ページ本体: ネット優先（4秒で諦めて控えへ）
  if (req.mode === 'navigate') {
    e.respondWith(new Promise(function (resolve) {
      var done = false;
      function fallback() {
        if (done) return; done = true;
        caches.match('./', { ignoreSearch: true }).then(function (r) {
          resolve(r || caches.match('index.html?v=' + V).then(function (r2) { return r2 || Response.error(); }));
        });
      }
      var t = setTimeout(fallback, 4000);
      // 端末の一時置き場（最大10分）を通さず、いつも最新のページを取りに行く
      fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(function (res) {
        clearTimeout(t);
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./', copy); });
        }
        if (!done) { done = true; resolve(res); }
      }, function () { clearTimeout(t); fallback(); });
    }));
    return;
  }

  // 部品: 控え優先。なければネットから取って、控えに入れる
  e.respondWith(caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    });
  }));
});
