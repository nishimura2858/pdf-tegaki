/* 本棚（アプリを開くと最初に出る画面）
   - 本は、Googleドライブの「読書ノート」フォルダに入れたPDF。一覧を取ってきて並べる
     押すと、この端末にダウンロードしてから開く（2回目からは、すぐ開く。電波がなくても読める）
   - 「このiPadのPDFを追加」で、ファイルアプリから選んだPDFも本棚に入れられる
   - スクラップブックも、ここに並ぶ（中身は scrap.js）
   - 書き込み（ペン・マーカー・付箋）の、この端末への保存もここで受け持つ（Driveへの保存は sync.js）
   本の記録（Store の books）: { id, kind: 'drive'|'local'|'scrap', name, driveId, folder, size, md5,
     has: この端末に入っているか, pages, last: 最後に読んでいたページ, lastAt, addedAt, thumb: 表紙の小さな絵 } */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var home = $('home');
  var cur = null;        // 開いている本の id
  var loading = {};      // ダウンロード中の本 { id: { ctrl, got, total } }
  var refreshing = false, lastRefresh = 0, seq = 0, opening = false;

  var MESSAGES = {
    popup_failed_to_open: 'ログイン画面を開けませんでした（ポップアップがブロックされている可能性があります）',
    popup_closed: 'ログインが中断されました',
    access_denied: 'Googleへのアクセスが許可されませんでした',
    scope_denied: 'Driveへのアクセスが許可されていません。ログイン時にチェックを入れてください',
    state_mismatch: 'ログインの確認に失敗しました。もう一度お試しください',
    token_exchange_failed: 'ログインの仕上げに失敗しました。もう一度お試しください',
    not_configured: 'ログインサーバーの準備ができていません',
    invalid_grant: 'ログインの有効期限が切れました。もう一度お試しください'
  };
  function message(code) { return MESSAGES[code] || ('ログインできませんでした（' + (code || '不明なエラー') + '）'); }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function bare(name) { return String(name || '本').replace(/\.pdf$/i, ''); }
  function mb(n) { n = +n || 0; return n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'GB' : Math.max(1, Math.round(n / 1048576)) + 'MB'; }
  function hhmm(at) { var d = new Date(at); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); }
  function byName(a, b) { return String(a.name).localeCompare(String(b.name), 'ja', { numeric: true }); }

  /* ---------- 書き込みを、この端末に保存する ----------
     ふだんは IndexedDB へ。アプリを離れる瞬間の保存は、書き終わる前に止められることがあるので、
     念のため同じ内容を localStorage にも置いておき、次に開いたときに書き直す */
  var JDATA = 'dk:journal', JKEY2 = 'dk:journal:key';
  App.hooks.save = function (key, data) {
    if (document.hidden) { try { localStorage.setItem(JDATA, JSON.stringify(data)); localStorage.setItem(JKEY2, key); } catch (e) {} }
    Store.putAnn(key, data).then(function () {
      try { if (localStorage.getItem(JKEY2) === key) { localStorage.removeItem(JDATA); localStorage.removeItem(JKEY2); } } catch (e) {}
    }, function (e) {
      console.error(e);
      App.setStatus('この端末への保存に失敗しました（空きが足りない可能性があります）');
    });
  };
  async function restoreJournal() {
    try {
      var k = localStorage.getItem(JKEY2), j = localStorage.getItem(JDATA);
      if (k && j) await Store.putAnn(k, JSON.parse(j));
      localStorage.removeItem(JDATA); localStorage.removeItem(JKEY2);
    } catch (e) { console.error(e); }
  }

  /* ---------- 読んでいたページを覚える ---------- */
  var posT = 0;
  function savePos() {
    clearTimeout(posT);
    if (!cur || !S.hasFile || S.key !== cur) return;
    Store.patchBook(cur, { last: S.page, lastAt: Date.now() }).catch(function (e) { console.error(e); });
  }
  App.on('page', function () { clearTimeout(posT); posT = setTimeout(savePos, 1200); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) savePos(); });
  window.addEventListener('pagehide', savePos);

  /* ---------- 画面 ---------- */
  var ICON = {
    more: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="12" r="1.5" class="fill"/><circle cx="12" cy="12" r="1.5" class="fill"/><circle cx="17.5" cy="12" r="1.5" class="fill"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9z"/><path d="M12 11v5M9.8 13.8L12 16l2.2-2.2"/></svg>'
  };
  function tile(b) {
    var scrap = b.kind === 'scrap', dl = loading[b.id];
    var sub;
    if (scrap) sub = (b.pages != null ? b.pages : b.items ? b.items.length : 0) + 'ページ';
    else if (dl) sub = 'ダウンロード中…';
    else if (!b.has) sub = (b.gone ? 'Driveにありません' : 'まだこの端末にありません') + (b.size ? '・' + mb(b.size) : '');
    else if (b.pages) sub = (b.last && b.last > 1 ? b.last + ' / ' + b.pages + 'ページ' : b.pages + 'ページ');
    else sub = mb(b.size);
    var prog = !scrap && b.has && b.pages > 1 && b.last > 1 ? Math.round((b.last - 1) / (b.pages - 1) * 100) : 0;
    var cover = b.thumb ? '<img alt="" src="' + esc(b.thumb) + '">' : '<span class="t-ph">' + esc(bare(b.name).slice(0, 28)) + '</span>';
    return '<div class="tile ' + (scrap ? 'scrap' : 'book') + (!scrap && !b.has ? ' cloud' : '') + (b.id === cur ? ' on' : '') + '" data-book="' + esc(b.id) + '">' +
      '<button class="t-open" data-open="' + esc(b.id) + '">' +
      '<span class="t-thumb">' + cover +
      (!scrap && !b.has && !dl ? '<span class="t-cloud">' + ICON.cloud + '</span>' : '') +
      (dl ? '<span class="t-dl"><b>' + pct(dl) + '</b></span>' : '') +
      (prog ? '<span class="t-prog"><i style="width:' + prog + '%"></i></span>' : '') + '</span>' +
      '<span class="t-name">' + esc(bare(b.name)) + '</span>' +
      '<span class="t-when">' + esc(sub) + '</span></button>' +
      '<button class="t-act" data-more="' + esc(b.id) + '" aria-label="メニュー">' + ICON.more + '</button></div>';
  }
  function pct(dl) { return dl.total ? Math.min(99, Math.floor(dl.got / dl.total * 100)) + '%' : mb(dl.got); }
  function paintProgress(id) {
    var els = home.querySelectorAll('[data-book="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .t-dl b');
    for (var i = 0; i < els.length; i++) if (loading[id]) els[i].textContent = pct(loading[id]);
  }

  /* ---------- 本棚の背表紙 ----------
     背表紙の絵はネットには出回っていない（本の情報のサイトにあるのは表紙だけ）ので、表紙の色から作る。
     表紙でいちばん目立つ色を地の色に、次に目立つ色を上下の帯に。表紙がまだない本（一度も開いていない）は、名前から色を決める
     太さはページ数（わからなければファイルの大きさ）、高さは表紙の縦横の比から */
  function hashOf(t) { var h = 0; t = String(t); for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return Math.abs(h); }
  function hex(r, g, b) { return '#' + [r, g, b].map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); }
  function lum(r, g, b) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
  function plainColors(name) { // 表紙がないとき: 名前から、落ち着いた色を
    var h = hashOf(name) % 360;
    return { bg: 'hsl(' + h + ',30%,36%)', ac: 'hsl(' + ((h + 28) % 360) + ',42%,72%)', fg: '#fbf8f1' };
  }
  var spineCache = {}; // id → { key: 表紙の印, c: 色, aspect }
  var shelfBooks = {}; // id → 本の記録（いま本棚に並べているもの。背表紙をなぞったときに表紙を出すため）
  function coverColors(url) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () {
        var W = 24, H = 34, c = document.createElement('canvas'); c.width = W; c.height = H;
        var x = c.getContext('2d'); x.drawImage(im, 0, 0, W, H);
        var d; try { d = x.getImageData(0, 0, W, H).data; } catch (e) { res(null); return; }
        var bk = {}, white = 0, n = W * H;
        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2];
          if (r > 232 && g > 232 && b > 232) { white++; continue; }
          var k = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5), o = bk[k] || (bk[k] = { n: 0, r: 0, g: 0, b: 0 });
          o.n++; o.r += r; o.g += g; o.b += b;
        }
        var list = Object.keys(bk).map(function (k) {
          var o = bk[k], r = o.r / o.n, g = o.g / o.n, b = o.b / o.n, sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
          return { r: r, g: g, b: b, n: o.n, s: o.n * (0.55 + sat) };
        }).sort(function (a, b) { return b.s - a.s; });
        var aspect = im.naturalHeight / (im.naturalWidth || 1);
        c.width = c.height = 0;
        if (!list.length || white > n * 0.5) { // 白い所が半分以上の表紙: 白い背表紙に、目立つ色の帯
          var a0 = list[0] || { r: 120, g: 110, b: 100 };
          res({ c: { bg: '#f3efe6', ac: hex(a0.r, a0.g, a0.b), fg: '#2a2620' }, aspect: aspect }); return;
        }
        var m = list[0], ac = null;
        for (var j = 1; j < list.length && !ac; j++) {
          var q = list[j];
          if (Math.hypot(q.r - m.r, q.g - m.g, q.b - m.b) > 90 && q.n >= 3) ac = q;
        }
        if (!ac && white > n * 0.15) ac = { r: 246, g: 243, b: 236 };
        if (!ac) { var k2 = lum(m.r, m.g, m.b) > 0.5 ? 0.55 : 1.6; ac = { r: Math.min(255, m.r * k2), g: Math.min(255, m.g * k2), b: Math.min(255, m.b * k2) }; }
        var light = lum(m.r, m.g, m.b) > 0.58;
        res({ c: { bg: hex(m.r, m.g, m.b), ac: hex(ac.r, ac.g, ac.b), fg: light ? '#1f1c17' : '#fbf8f1' }, aspect: aspect });
      };
      im.onerror = function () { res(null); };
      im.src = url;
    });
  }
  function spineSize(b, aspect) { // 大きめに表示する（読みやすいように、太さ・高さ・文字を約1.8倍に）
    var pages = +b.pages || (b.size ? Math.round(b.size / 350000) : 0);
    var w = pages ? Math.max(40, Math.min(104, 30 + pages * 0.135)) : 54;
    var h = aspect ? Math.max(232, Math.min(292, 232 + (aspect - 1.25) * 250)) : 256 + hashOf(b.id) % 5 * 8;
    return { w: Math.round(w), h: Math.round(h) };
  }
  /* 本物の背表紙の写真（裁断した本の背を撮って切り出したもの。spines/ に入れてある）
     本の名前で合わせる。r は 背の太さ÷背の高さ（写真から測った値）。棚では、この比のまま細さを再現する */
  var SPINE_PHOTOS = [
    { re: /^英語教育[\s　]*2026[.．]0?8$/, src: 'spines/eigo-kyoiku-2026-08.jpg', r: 0.01824 },
    { re: /^英語教育[\s　]*2026[.．]0?9$/, src: 'spines/eigo-kyoiku-2026-09.jpg', r: 0.01886 },
    { re: /^英語教育[\s　]*2026[.．]10$/, src: 'spines/eigo-kyoiku-2026-10.jpg', r: 0.01974 },
    { re: /^英語教育[\s　]*2026[.．]11$/, src: 'spines/eigo-kyoiku-2026-11.jpg', r: 0.02056 },
    { re: /^英語教育[\s　]*2026[.．]12$/, src: 'spines/eigo-kyoiku-2026-12.jpg', r: 0.01894 }
  ];
  function spinePhoto(b) {
    var n = bare(b.name).trim();
    for (var i = 0; i < SPINE_PHOTOS.length; i++) if (SPINE_PHOTOS[i].re.test(n)) return SPINE_PHOTOS[i];
    return null;
  }
  function photoSize(b, ph) { // 高さはほかの本と同じ決め方（この雑誌はB5判: 縦÷横 = 257÷182）。太さは写真の比のまま（本物と同じ細さ）
    var h = spineSize(b, ph.aspect || 257 / 182).h;
    return { w: Math.max(3, Math.round(h * ph.r * 10) / 10), h: h };
  }
  function spine(b) {
    var ph = spinePhoto(b);
    if (ph) return photoSpine(b, ph);
    var dl = loading[b.id], sc = spineCache[b.id], c = sc && sc.key === (b.thumb || '').length ? sc.c : plainColors(b.name);
    var sz = spineSize(b, sc && sc.aspect), name = bare(b.name);
    var foot = dl ? '<span class="t-dl"><b>' + pct(dl) + '</b></span>' : !b.has ? '<span class="sp-cloud">' + ICON.cloud + '</span>' : '';
    return '<span class="sp-slot" data-book="' + esc(b.id) + '"><button class="spine' + (!b.has ? ' cloud' : '') + (b.id === cur ? ' on' : '') +
      '" data-open="' + esc(b.id) + '" data-spine="' + esc(b.id) + '" aria-label="' + esc(name) + '" style="--w:' + sz.w + 'px;--h:' + sz.h +
      'px;--bg:' + c.bg + ';--ac:' + c.ac + ';--fg:' + c.fg + '">' +
      '<span class="sp-band"></span><span class="sp-title">' + esc(name) + '</span><span class="sp-band low"></span>' +
      (foot ? '<span class="sp-foot">' + foot + '</span>' : '') + '</button></span>';
  }
  function photoSpine(b, ph) {
    var dl = loading[b.id], sz = photoSize(b, ph), name = bare(b.name);
    return '<span class="sp-slot" data-book="' + esc(b.id) + '"><button class="spine photo' + (!b.has ? ' cloud' : '') + (b.id === cur ? ' on' : '') +
      '" data-open="' + esc(b.id) + '" data-spine="' + esc(b.id) + '" aria-label="' + esc(name) + '" style="--w:' + sz.w + 'px;--h:' + sz.h +
      'px;background-image:url(' + ph.src + ')">' +
      (dl ? '<span class="sp-foot"><span class="t-dl"><b>' + pct(dl) + '</b></span></span>' : '') + '</button></span>';
  }
  // 表紙から色を出し終わった本から、背表紙に色を付けていく
  async function paintSpines(books, my) {
    for (var i = 0; i < books.length; i++) {
      var b = books[i];
      if (!b.thumb || spinePhoto(b)) continue;
      var sc = spineCache[b.id];
      if (!sc || sc.key !== b.thumb.length) {
        var r = await coverColors(b.thumb);
        if (!r) continue;
        sc = spineCache[b.id] = { key: b.thumb.length, c: r.c, aspect: r.aspect };
      }
      if (my !== seq) return;
      var els = home.querySelectorAll('[data-spine="' + (window.CSS && CSS.escape ? CSS.escape(b.id) : b.id) + '"]');
      var sz = spineSize(b, sc.aspect);
      for (var j = 0; j < els.length; j++) {
        var st = els[j].style;
        st.setProperty('--bg', sc.c.bg); st.setProperty('--ac', sc.c.ac); st.setProperty('--fg', sc.c.fg);
        st.setProperty('--w', sz.w + 'px'); st.setProperty('--h', sz.h + 'px');
      }
    }
  }
  // 最近読んでいる本（表紙を見せて棚の一番上に）
  function faceTile(b) {
    var prog = b.pages > 1 && b.last > 1 ? Math.round((b.last - 1) / (b.pages - 1) * 100) : 0;
    var sub = b.pages ? (b.last && b.last > 1 ? b.last + ' / ' + b.pages + 'ページ' : b.pages + 'ページ') : '';
    var cover = b.thumb ? '<img alt="" src="' + esc(b.thumb) + '">' : '<span class="t-ph">' + esc(bare(b.name).slice(0, 28)) + '</span>';
    return '<div class="face' + (b.id === cur ? ' on' : '') + '" data-book="' + esc(b.id) + '">' +
      '<div class="f-stand"><button class="f-cover" data-open="' + esc(b.id) + '" aria-label="' + esc(bare(b.name)) + '">' + cover +
      (prog ? '<span class="t-prog"><i style="width:' + prog + '%"></i></span>' : '') + '</button>' +
      '<button class="t-act f-act" data-more="' + esc(b.id) + '" aria-label="メニュー">' + ICON.more + '</button></div>' +
      '<button class="f-label" data-open="' + esc(b.id) + '"><span class="t-name">' + esc(bare(b.name)) + '</span>' +
      (sub ? '<span class="t-when">' + esc(sub) + '</span>' : '') + '</button></div>';
  }

  async function render() {
    var my = ++seq;
    var all = await Store.books();
    if (my !== seq) return; // あとから頼まれた描き直しがあれば、そちらに任せる
    shelfBooks = {}; all.forEach(function (b) { shelfBooks[b.id] = b; });
    var scraps = all.filter(function (b) { return b.kind === 'scrap'; })
      .sort(function (a, b) { return (b.lastAt || b.addedAt || 0) - (a.lastAt || a.addedAt || 0); });
    var books = all.filter(function (b) { return b.kind !== 'scrap'; });
    // 最近読んでいる本（最近開いた5冊。表紙を見せて、棚の一番上に）
    var recent = books.filter(function (b) { return b.lastAt && b.has; })
      .sort(function (a, b) { return b.lastAt - a.lastAt; }).slice(0, 5);
    $('recentGrid').innerHTML = recent.map(faceTile).join('');
    $('secRecent').hidden = !recent.length;
    // スクラップブック
    $('scrapGrid').innerHTML = scraps.map(tile).join('');
    $('scrapEmpty').hidden = !!scraps.length;
    // 本棚（Driveのフォルダごと。このiPadから入れた本は最後に）
    var groups = {}, order = [];
    books.forEach(function (b) {
      var g = b.kind === 'local' ? '￿このiPadから入れた本' : (b.folder || '');
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(b);
    });
    order.sort(function (a, b) { return a.localeCompare(b, 'ja', { numeric: true }); });
    // 2段目から下: 背表紙を見せて並べる（フォルダごとに1つの棚）
    $('shelf').innerHTML = order.map(function (g) {
      var name = g.replace(/^￿/, '');
      return (name ? '<h3 class="h-folder">' + esc(name) + '</h3>' : '') +
        '<div class="h-spines">' + groups[g].sort(byName).map(spine).join('') + '</div>';
    }).join('');
    paintSpines(books, my).catch(function (e) { console.error(e); });
    renderDrive(books);
    $('homeClose').hidden = !S.hasFile;
    // この端末に入っている量
    var have = books.filter(function (b) { return b.has; }), sum = have.reduce(function (s, b) { return s + (+b.size || 0); }, 0);
    $('usage').textContent = have.length ? 'この端末に入っている本: ' + have.length + '冊・' + mb(sum) + '（本の「…」から、端末から消して空きを増やせます。Driveには残ります）' : '';
  }
  function renderDrive(books) {
    var btn = $('driveBtn'), info = $('driveInfo'), empty = $('shelfEmpty');
    var logged = !!(window.GAuth && GAuth.hasToken());
    btn.disabled = refreshing;
    btn.textContent = refreshing ? '更新中…' : logged ? 'Driveの本を更新' : 'Googleドライブにログイン';
    info.textContent = logged && lastRefresh ? hhmm(lastRefresh) + ' に更新' : '';
    if (!books) return;
    var n = books.filter(function (b) { return b.kind === 'drive'; }).length;
    empty.hidden = n > 0;
    empty.innerHTML = !logged
      ? '<b>Googleドライブにログイン</b>すると、Driveに「読書ノート」というフォルダができます。<br>そのフォルダに本のPDFを入れると、ここに並びます。'
      : 'Googleドライブの<b>「読書ノート」フォルダ</b>に、本のPDFを入れてください（フォルダで分けてもかまいません）。<br>入れたら「Driveの本を更新」を押すと、ここに並びます。';
  }

  function show() {
    App.toolbar && App.toolbar.closePops();
    App.flushSave(); savePos();
    document.body.classList.add('home-on');
    home.hidden = false;
    goTab(tabIdx, false); // 非表示のあいだに横の位置が戻るので、開いていたほうへ戻す
    render().catch(function (e) { console.error(e); });
    if (window.GAuth && GAuth.hasToken() && Date.now() - lastRefresh > 10 * 60 * 1000) refresh(false);
  }
  function hide() {
    if (home.hidden) return;
    home.hidden = true;
    document.body.classList.remove('home-on');
    App.toolbar && App.toolbar.closePops();
  }
  App.on('open', hide);
  App.on('open', function () { $('bookTitle').textContent = bare(S.name); });

  /* ---------- Driveの本の一覧を取ってくる ---------- */
  async function refresh(ask) {
    if (refreshing || !window.GAuth) return;
    var token = null;
    try { token = ask ? await GAuth.getToken('home') : await GAuth.ensure(); }
    catch (e) { App.setStatus(message(e && e.message)); return; }
    if (!token) { renderDrive(); return; }
    refreshing = true; renderDrive();
    try {
      var list = await DriveX.listBooks(token);
      var all = await Store.books(), byId = {}, seen = {};
      all.forEach(function (b) { byId[b.id] = b; });
      for (var i = 0; i < list.length; i++) {
        var r = list[i], id = 'd:' + r.driveId;
        seen[id] = true;
        if (byId[id]) {
          await Store.patchBook(id, function (rec) {
            var p = { name: r.name, folder: r.folder, md5: r.md5, modified: r.modified, gone: undefined };
            if (!rec.has) p.size = r.size;
            return p;
          });
        } else {
          await Store.putBook({ id: id, kind: 'drive', driveId: r.driveId, name: r.name, folder: r.folder,
            size: r.size, md5: r.md5, modified: r.modified, has: false, addedAt: Date.now() });
        }
      }
      // Driveからなくなった本: この端末に入っていれば残す（印だけ付ける）。入っていなければ本棚から外す（書き込みは残す）
      for (var k = 0; k < all.length; k++) {
        var b = all[k];
        if (b.kind !== 'drive' || seen[b.id]) continue;
        if (b.has || loading[b.id] || b.id === cur) await Store.patchBook(b.id, { gone: true });
        else await Store.removeBook(b.id, true);
      }
      lastRefresh = Date.now();
      if (window.Sync) await Sync.pullScraps(token).catch(function (e) { console.error(e); });
    } catch (e) {
      console.error(e);
      if (e.status === 401) { GAuth.invalidate(); App.setStatus('ログインが切れました。「Googleドライブにログイン」を押してください'); }
      else App.setStatus('Driveの本の一覧を取れませんでした。通信を確かめて、もう一度お試しください');
    } finally {
      refreshing = false;
      render().catch(function (e) { console.error(e); });
    }
  }

  /* ---------- ダウンロード ---------- */
  async function download(id, fresh) {
    if (loading[id]) return false;
    var b = await Store.getBook(id);
    if (!b || b.kind !== 'drive') return false;
    var token = await GAuth.ensure();
    if (!token) { App.setStatus('ダウンロードするには、「Googleドライブにログイン」を押してください'); return false; }
    var st = loading[id] = { ctrl: new AbortController(), got: 0, total: b.size || 0 }, shown = 0;
    render().catch(function () {});
    function prog(got) {
      st.got = got;
      var now = performance.now();
      if (now - shown > 250) { shown = now; paintProgress(id); }
    }
    try {
      var m = await DriveX.meta(b.driveId, token);
      st.total = +m.size || st.total;
      var md5 = m.md5Checksum || '', w = null, from = 0;
      // 前に途中まで取ってあれば、続きから（Driveの中身が変わっていないときだけ）
      if (!fresh && !b.has && b.part && md5 && b.part.md5 === md5) from = await Store.countChunks(id);
      if (from > 0) {
        w = Source.writer(id, from); st.got = from * Source.CHUNK;
        var res = await DriveX.download(b.driveId, token, w, prog, from * Source.CHUNK, st.ctrl.signal);
        if (!res.resumed) from = 0;
      }
      if (!from) {
        await Store.patchBook(id, { has: false, part: { md5: md5 } });
        await Store.delChunks(id);
        w = Source.writer(id, 0); st.got = 0;
        await DriveX.download(b.driveId, token, w, prog, 0, st.ctrl.signal);
      }
      var out = await w.close();
      if (st.total && out.size !== st.total) {
        await Store.delChunks(id); await Store.patchBook(id, { part: undefined });
        throw new Error('size_mismatch');
      }
      await Store.patchBook(id, { has: true, size: out.size, md5: md5 || b.md5, hasMd5: md5, part: undefined, thumb: fresh ? undefined : b.thumb });
      Store.persist();
      return true;
    } catch (e) {
      console.error(e);
      if (e && e.name === 'AbortError') App.setStatus('ダウンロードを中止しました（もう一度押すと、続きから取ります）');
      else if (e.status === 401) { GAuth.invalidate(); App.setStatus('ログインが切れました。「Googleドライブにログイン」を押してください'); }
      else if (e.status === 404) App.setStatus('この本は、Driveに見つかりませんでした');
      else App.setStatus('ダウンロードできませんでした。通信のよい場所で、もう一度本を押してください（続きから取ります）');
      return false;
    } finally {
      delete loading[id];
      render().catch(function () {});
    }
  }

  /* ---------- 開く ---------- */
  function thumbSoon(id) {
    setTimeout(function () {
      if (cur !== id || !S.hasFile || S.key !== id) return;
      var c = document.createElement('canvas');
      App.renderThumb(c, 1, 120).then(function () {
        var url = c.toDataURL('image/jpeg', 0.75);
        c.width = c.height = 0;
        return Store.patchBook(id, { thumb: url });
      }).catch(function (e) { console.error(e); });
    }, 1500);
  }
  // 本・スクラップブックを開いたあとの共通の後始末
  function opened(id, pages, hadThumb) {
    cur = id; hide();
    Store.patchBook(id, { lastAt: Date.now(), pages: pages }).catch(function (e) { console.error(e); });
    if (!hadThumb) thumbSoon(id);
  }
  async function open(id, at) {
    if (opening) return false;
    var b = await Store.getBook(id);
    if (!b) { App.setStatus('この本は、本棚に見つかりませんでした'); return false; }
    if (loading[id]) {
      if (window.confirm('「' + bare(b.name) + '」のダウンロードを中止しますか？')) loading[id] && loading[id].ctrl.abort();
      return false;
    }
    if (id === cur && S.hasFile && S.key === id) { hide(); if (at) App.goPage(at); return true; }
    if (b.kind !== 'scrap' && !b.has) {
      // まだこの端末にない本: ダウンロードしてから開く（その間に、ほかの本を読んでいてもよい）
      var before = cur;
      if (!(await download(id))) return false;
      if (home.hidden || cur !== before) { App.setStatus('「' + bare(b.name) + '」のダウンロードが終わりました'); return false; }
      b = await Store.getBook(id);
    }
    if (opening) return false;
    opening = true;
    try {
      if (b.kind === 'scrap') return await Scrap.open(id, at);
      App.setStatus('開いています…');
      var doc = await Source.openPdf(b), ann = await Store.getAnn(id);
      App.openDoc(doc, b.name, id, ann, 'book', at || b.last || 1);
      opened(id, doc.numPages, !!b.thumb);
      return true;
    } catch (e) {
      console.error(e);
      App.setStatus('この本を開けませんでした。本の「…」から「ダウンロードし直す」を試してください');
      return false;
    } finally { opening = false; }
  }

  /* ---------- このiPadのPDFを追加 ---------- */
  $('localFile').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      App.setStatus('本棚に入れています…');
      var id = await Source.localId(f), old = await Store.getBook(id);
      if (!old || !old.has) {
        await Source.importBlob(id, f, function (got, total) { App.setStatus('本棚に入れています… ' + Math.floor(got / total * 100) + '%'); });
        await Store.putBook({ id: id, kind: 'local', name: f.name, size: f.size, has: true, addedAt: Date.now(),
          last: old ? old.last : 1, lastAt: old ? old.lastAt : 0 });
        Store.persist();
      }
      await open(id);
    } catch (err) {
      console.error(err);
      App.setStatus('このPDFを本棚に入れられませんでした（端末の空きが足りない可能性があります）');
      render().catch(function () {});
    }
  });

  /* ---------- メニュー（本の「…」） ---------- */
  var menu = $('homeMenu');
  function menuAt(anchor, items) {
    menu.innerHTML = items.map(function (it, i) {
      return it.head ? '<div class="mhead">' + esc(it.head) + '</div>'
        : '<button class="item' + (it.danger ? ' danger' : '') + '" data-i="' + i + '">' + esc(it.label) + '</button>';
    }).join('');
    menu.onclick = function (e) {
      var b = e.target.closest('[data-i]'); if (!b) return;
      App.toolbar.closePops();
      Promise.resolve(items[+b.dataset.i].run()).then(render).catch(function (err) { console.error(err); });
    };
    App.toolbar.showPop(menu, anchor);
  }
  // この端末から本のデータを消す（Driveには残る。書き込みも残る）
  async function evict(b) {
    if (b.id === cur) { App.closeDoc(); cur = null; }
    await Store.delChunks(b.id);
    await Store.patchBook(b.id, { has: false, part: undefined });
    App.setStatus('「' + bare(b.name) + '」をこの端末から消しました（Driveには残っています）');
  }
  async function bookMenu(anchor, id) {
    var b = await Store.getBook(id); if (!b) return;
    var items = [{ head: bare(b.name) }];
    if (b.kind === 'scrap') {
      items.push({ label: '名前を変える', run: function () { return Scrap.rename(id); } });
      items.push({ label: 'PDFにして共有', run: function () { return Scrap.share(id); } });
      items.push({ label: 'スクラップブックを削除', danger: true, run: function () { return Scrap.remove(id); } });
    } else if (b.kind === 'drive') {
      if (loading[id]) items.push({ label: 'ダウンロードを中止', run: function () { loading[id] && loading[id].ctrl.abort(); } });
      else if (!b.has) {
        if (!b.gone) items.push({ label: 'この端末にダウンロード（' + mb(b.size) + '）', run: function () { download(id); } });
      } else {
        if (!b.gone) items.push({ label: 'ダウンロードし直す', run: function () {
          if (b.id === cur) { App.closeDoc(); cur = null; }
          download(id, true);
        } });
        items.push({ label: b.gone ? '本棚から外す（Driveにはもうありません）' : 'この端末から消す（Driveには残ります）', danger: true, run: function () {
          if (b.gone) {
            if (!window.confirm('「' + bare(b.name) + '」を本棚から外しますか？\nこの本はDriveにもうないので、読めなくなります。')) return;
            if (b.id === cur) { App.closeDoc(); cur = null; }
            return Store.removeBook(id, true);
          }
          return evict(b);
        } });
      }
    } else {
      items.push({ label: '本棚から外す', danger: true, run: function () {
        if (!window.confirm('「' + bare(b.name) + '」を本棚から外しますか？\nこの端末に入れたPDFを消します（元のファイルは消えません）。書き込みは残るので、同じPDFを入れ直すと戻ります。')) return;
        if (b.id === cur) { App.closeDoc(); cur = null; }
        return Store.removeBook(id, true);
      } });
    }
    menuAt(anchor, items);
  }

  // 背表紙は細くて「…」を置けないので、長押し（Macでは右クリック）でメニューを出す
  var lp = null, lpFired = false;
  home.addEventListener('pointerdown', function (e) {
    lpFired = false; // 新しく触れたら、前の長押しの印は消す（長押しのあと click が来ないこともある）
    var sp = e.target.closest('.spine'); if (!sp || e.button > 0) return;
    clearTimeout(lp && lp.t);
    lp = { x: e.clientX, y: e.clientY, t: setTimeout(function () { lpFired = true; lp = null; bookMenu(sp, sp.dataset.spine); }, 550) };
  });
  home.addEventListener('pointermove', function (e) {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) { clearTimeout(lp.t); lp = null; }
  });
  ['pointerup', 'pointercancel'].forEach(function (t) { home.addEventListener(t, function () { if (lp) { clearTimeout(lp.t); lp = null; } }); });
  home.addEventListener('scroll', function () { if (lp) { clearTimeout(lp.t); lp = null; } }, true);
  home.addEventListener('contextmenu', function (e) {
    var sp = e.target.closest('.spine'); if (!sp) return;
    e.preventDefault();
    if (lpFired) return;
    bookMenu(sp, sp.dataset.spine);
  });

  /* ---------- 背表紙を指でなぞると、表紙がパラパラとめくれる ----------
     読むときの「本の小口」（pages.js）と同じ見せ方: 表紙を1枚の紙のように、真ん中の背を軸に回してめくる。
     いま選んでいる本の表紙が右に起き上がり、通り過ぎた本は左へ、これからの本は右の下に重なって、端だけが見える。
     背表紙に触れて横へなぞる: 指の位置の本まで、表紙がパラパラめくれる（同じ段に並ぶ本の中で）
     表紙が出ている間に、指を上へはらう: その本を開く。そのまま指を離す: 何もしない
     縦に動かし始めたときは、ふだんどおり本棚がスクロールする */
  var fl = document.createElement('div');
  fl.id = 'spFlip'; fl.setAttribute('aria-hidden', 'true');
  fl.innerHTML = '<div class="fl-stage"></div><div class="fl-name"></div><div class="fl-hint">↑ 上へはらうと開く</div>';
  document.body.appendChild(fl);
  var flStage = fl.children[0], flName = fl.children[1];
  var br = null;          // なぞっている間の様子
  var brClickBlock = 0;   // なぞり終えた直後の click（マウス）は無視する
  var FL = { W: 190, H: 268, cx: 0, top: 0, f: 0, show: 0, intro: 1, introAt: 0, raf: 0, leaves: {}, books: [], hideT: 0 };
  function rowOf(sp) { // 同じ段に並ぶ背表紙（左から順に）
    var row = sp.closest('.h-spines'), bottom = sp.getBoundingClientRect().bottom;
    return Array.prototype.filter.call(row.querySelectorAll('.spine'), function (el) {
      return Math.abs(el.getBoundingClientRect().bottom - bottom) < 4;
    }).map(function (el) { var r = el.getBoundingClientRect(); return { el: el, c: (r.left + r.right) / 2, top: r.top, bottom: r.bottom }; });
  }
  function fAt(x) { // 指の横の位置 → 何冊目か（背表紙と背表紙の間では、小数でなめらかに）
    var r = br.row, n = r.length;
    if (x <= r[0].c) return 0;
    if (x >= r[n - 1].c) return n - 1;
    for (var i = 0; i < n - 1; i++) if (x < r[i + 1].c) return i + (x - r[i].c) / ((r[i + 1].c - r[i].c) || 1);
    return n - 1;
  }
  // 表紙の角度（本の小口と同じ考え方）。s = i - f + 0.5: 0.5 = いま選んでいる表紙（右に起き上がる）
  function flAngle(s) {
    var OPEN = 32, as = Math.abs(s);
    if (as < 0.5) return 90 - (90 - OPEN) * 2 * s;   // めくっている途中（背を軸に回る）
    var ef = 1 - (1 - Math.cos(OPEN * Math.PI / 180)) * Math.exp(-0.16 * (as - 0.5)); // 下の表紙ほど寝て、端がのぞく
    var th = Math.acos(ef) * 180 / Math.PI;
    return s > 0 ? th : 180 - th;
  }
  function flLeaf(i) {
    var b = FL.books[i] || {}, el = document.createElement('div'), name = bare(b.name);
    el.className = 'fl-leaf';
    if (b.thumb) el.innerHTML = '<img alt="" src="' + esc(b.thumb) + '">';
    else {
      var ph = spinePhoto(b), c = (spineCache[b.id] && spineCache[b.id].c) || plainColors(b.name);
      el.innerHTML = '<span class="fl-ph" style="background:' + (ph ? '#f3efe6' : c.bg) + ';color:' + (ph ? '#2a2620' : c.fg) + '">' + esc(name) + '</span>';
    }
    flStage.appendChild(el);
    return el;
  }
  function flLayout() {
    var f = FL.show, u = FL.intro, W = FL.W, H = FL.H, cx = FL.cx, n = FL.books.length, sel = Math.round(FL.f);
    for (var i = 0; i < n; i++) {
      var s = i - f + 0.5;
      if (Math.abs(s) > 30) { if (FL.leaves[i]) { FL.leaves[i].remove(); delete FL.leaves[i]; } continue; }
      var el = FL.leaves[i] || (FL.leaves[i] = flLeaf(i));
      var th = 90 + (flAngle(s) - 90) * u, right = th <= 90, lift = right ? th : 180 - th;
      el.style.width = W + 'px'; el.style.height = H + 'px';
      el.style.transformOrigin = right ? '0 50%' : '100% 50%';
      el.style.transform = 'translate3d(' + (right ? cx : cx - W) + 'px,' + FL.top + 'px,0) rotateY(' + (right ? -lift : lift) + 'deg)';
      el.style.zIndex = String(2000 - Math.round(Math.abs(s) * 20));
      el.style.setProperty('--dir', right ? '270deg' : '90deg');
      var l = lift / 90; el.style.setProperty('--sh', (0.06 + 0.34 * l * l).toFixed(3));
      el.classList.toggle('sel', i === sel && Math.abs(s - 0.5) < 0.5);
    }
    var b = FL.books[sel];
    flName.textContent = b ? bare(b.name) : '';
  }
  function flTick() {
    FL.raf = 0;
    if (!br || !br.on) return;
    var now = performance.now();
    if (FL.intro < 1) { var t = Math.min(1, (now - FL.introAt) / 240); FL.intro = 1 - Math.pow(1 - t, 3); }
    var d = FL.f - FL.show;
    FL.show += Math.abs(d) < 0.003 ? d : d * 0.38;
    flLayout();
    if (FL.intro < 1 || FL.show !== FL.f) FL.raf = requestAnimationFrame(flTick);
  }
  function flKick() { if (!FL.raf) FL.raf = requestAnimationFrame(flTick); }
  function flOpen() {
    clearTimeout(FL.hideT);
    flStage.textContent = ''; FL.leaves = {};
    FL.books = br.row.map(function (s) { return shelfBooks[s.el.dataset.spine] || {}; });
    // 大きさと位置: なぞっている段の上に（場所がなければ下に）。背表紙を隠さないように
    var vw = window.innerWidth, vh = window.innerHeight, bottom = br.row[0].bottom;
    var top = Math.min.apply(null, br.row.map(function (s) { return s.top; })) - 16; // 引き出した本の分も
    var H = Math.min(300, Math.max(180, Math.max(top, vh - bottom) - 100)), W = Math.round(H * 182 / 257);
    var boxW = Math.min(vw - 16, W * 2 + 120), boxH = H + 76;
    var y = top - boxH - 10 >= 8 ? top - boxH - 10 : bottom + 10 + boxH <= vh - 8 ? bottom + 10 : Math.max(8, top - boxH - 10);
    FL.W = W; FL.H = H; FL.cx = boxW / 2; FL.top = 14;
    fl.style.width = boxW + 'px'; fl.style.height = boxH + 'px';
    fl.style.left = Math.round((vw - boxW) / 2) + 'px'; fl.style.top = Math.round(y) + 'px';
    FL.intro = 0; FL.introAt = performance.now();
    fl.classList.remove('go'); fl.classList.add('on'); void fl.offsetWidth; fl.classList.add('show');
  }
  function flClose(go) {
    fl.classList.remove('show');
    if (go) fl.classList.add('go');
    clearTimeout(FL.hideT);
    FL.hideT = setTimeout(function () { fl.classList.remove('on', 'go'); flStage.textContent = ''; FL.leaves = {}; }, 260);
  }
  function pullSel() {
    var sel = Math.round(FL.f);
    if (br.pulled === sel) return;
    if (br.pulled != null && br.row[br.pulled]) br.row[br.pulled].el.classList.remove('pulled');
    br.pulled = sel; if (br.row[sel]) br.row[sel].el.classList.add('pulled');
  }
  function endBrowse(openIt) {
    if (!br) return;
    var on = br.on, sel = Math.round(FL.f), s = on && br.row[sel], id = s && s.el.dataset.spine;
    if (on && br.pulled != null && br.row[br.pulled]) br.row[br.pulled].el.classList.remove('pulled');
    br = null;
    if (!on) return;
    brClickBlock = Date.now() + 400;
    flClose(openIt && id);
    if (openIt && id) open(id);
  }
  home.addEventListener('pointerdown', function (e) {
    var sp = e.target.closest('.spine');
    if (br) endBrowse(false);
    if (!sp || e.button > 0 || !e.isPrimary) return;
    br = { id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, sp: sp, low: e.clientY, row: null, pulled: null };
  });
  home.addEventListener('pointermove', function (e) {
    if (!br || e.pointerId !== br.id) return;
    var dx = e.clientX - br.x0, dy = e.clientY - br.y0;
    if (!br.on) {
      if (Math.hypot(dx, dy) < 8) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.1) { br = null; return; } // 縦に動かした: ふだんのスクロール
      br.on = true; br.row = rowOf(br.sp);
      if (lp) { clearTimeout(lp.t); lp = null; }
      FL.f = FL.show = fAt(br.x0);
      flOpen();
    }
    // 下へ動いた分は覚えておき、そこからどれだけ上へ戻したか（上へはらったか）を見る
    if (e.clientY > br.low) br.low = e.clientY;
    var up = br.low - e.clientY;
    if (up > 70) { FL.f = Math.round(FL.f); endBrowse(true); return; }
    if (up < 18) { FL.f = fAt(e.clientX); pullSel(); } // 上へ動かし始めたら、本は替えない
    flKick();
  });
  ['pointerup', 'pointercancel'].forEach(function (t) {
    home.addEventListener(t, function (e) { if (br && e.pointerId === br.id) endBrowse(false); });
  });
  // なぞっている間は、iPad が本棚をスクロールしたり、本棚⇄スクラップブックを切りかえたりしないように止める
  // （まだ動き始めで、なぞるかスクロールか決まっていないときも、横向きの動きなら止めておく。iPad は最初の動きでスクロールするか決めるため）
  home.addEventListener('touchmove', function (e) {
    if (!br || !e.cancelable) return;
    var t = e.touches[0]; if (!t) return;
    if (br.on || Math.abs(t.clientX - br.x0) >= Math.abs(t.clientY - br.y0)) e.preventDefault();
  }, { passive: false });

  home.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (Date.now() < brClickBlock && b.classList.contains('spine')) return;
    if (lpFired) { lpFired = false; if (b.classList.contains('spine')) return; }
    var d = b.dataset;
    if (d.open) { open(d.open); return; }
    if (d.more) { bookMenu(b, d.more); return; }
    switch (b.id) {
      case 'homeClose': hide(); break;
      case 'driveBtn': refresh(true); break;
      case 'addLocal': $('localFile').click(); break;
      case 'tabShelf': goTab(0, true); break;
      case 'tabScrap': goTab(1, true); break;
      case 'newScrap': Promise.resolve(Scrap.create()).then(render); break;
    }
  });
  $('openBtn').addEventListener('click', show);

  /* ---------- 本棚 ⇄ スクラップブック（横に払って切りかえる） ---------- */
  var pager = $('hPager'), tabIdx = 0, tabLock = 0;
  function paintTab(i) {
    tabIdx = i;
    $('tabShelf').classList.toggle('on', i === 0); $('tabScrap').classList.toggle('on', i === 1);
    $('tabShelf').setAttribute('aria-selected', String(i === 0)); $('tabScrap').setAttribute('aria-selected', String(i === 1));
    $('linksShelf').hidden = i !== 0; $('linksScrap').hidden = i !== 1;
  }
  function goTab(i, smooth) {
    paintTab(i);
    tabLock = smooth ? Date.now() + 500 : 0;
    pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  }
  pager.addEventListener('scroll', function () {
    if (home.hidden || Date.now() < tabLock) return;
    var i = Math.round(pager.scrollLeft / (pager.clientWidth || 1));
    if (i !== tabIdx && (i === 0 || i === 1)) paintTab(i);
  }, { passive: true });

  // 起動時: ログインから戻ってきたときは結果を伝える。新しい版に切りかえて読み直したときは、読んでいた本を開き直す
  (async function () {
    await restoreJournal();
    var r = window.GAuth ? await GAuth.consumeRedirect() : null;
    if (r) GAuth.takeAfter();
    await render().catch(function (e) { console.error(e); });
    if (r && r.error) App.setStatus(message(r.error));
    else if (r) App.setStatus('Googleドライブにログインしました');
    var again = null;
    try { again = sessionStorage.getItem('dk:reopen'); sessionStorage.removeItem('dk:reopen'); } catch (e) {}
    if (again) open(again);
    if (window.GAuth && GAuth.hasToken()) refresh(false);
  })();

  window.Library = {
    show: show, hide: hide, render: render, open: open, opened: opened, refresh: refresh,
    current: function () { return cur; }, bare: bare, message: message,
    forget: function (id) { if (cur === id) cur = null; }
  };
})();
