/* ホーム画面（アプリを開くと最初に出る、PDFを選ぶ画面）
   - ファイルアプリから開く／白紙のノート
   - お気に入り: ☆を付けたPDFと、アプリの中に作ったフォルダ（フォルダは1段だけ）
   - 最近開いたPDF
   お気に入りは、この端末（IndexedDB）に PDF の中身ごと取っておく（最近の一覧から押し出されても消えない）
     'favIndex' = { folders: [{ id, name }], items: [{ id, name, at, folder }] }, 'fav:<id>' = { name, data }
   PDFの読み書きは pdf-open.js（PdfOpen）に任せる。このファイルは pdf-open.js より先に読み込む */
(function () {
  'use strict';
  var App = window.App;
  var $ = function (id) { return document.getElementById(id); };
  var home = $('home'), cur = null; // cur: 開いているお気に入りのフォルダ（null なら一番上）

  function P() { return window.PdfOpen; }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function when(at) {
    var d = new Date(at), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function bare(name) { return String(name || 'PDF').replace(/\.pdf$/i, ''); }

  /* ---------- お気に入りの保存 ---------- */
  function favIndex() {
    return P().idb('readonly', function (st) { return st.get('favIndex'); }).then(function (f) {
      f = f || {};
      return { folders: Array.isArray(f.folders) ? f.folders : [], items: Array.isArray(f.items) ? f.items : [] };
    }, function () { return { folders: [], items: [] }; });
  }
  function saveFav(f) { return P().idb('readwrite', function (st) { st.put(f, 'favIndex'); }); }
  async function isFav(id) { var f = await favIndex(); return f.items.some(function (x) { return x.id === id; }); }
  async function addFav(id) {
    var rec = await P().idb('readonly', function (st) { return st.get('recent:' + id); });
    if (!rec || !rec.data) { App.setStatus('このPDFの控えが見つかりませんでした'); return false; }
    var f = await favIndex();
    if (f.items.some(function (x) { return x.id === id; })) return true;
    await P().idb('readwrite', function (st) { st.put({ name: rec.name, data: rec.data }, 'fav:' + id); });
    f.items.unshift({ id: id, name: rec.name, at: Date.now(), folder: cur });
    await saveFav(f);
    return true;
  }
  async function removeFav(id) {
    var f = await favIndex(), recent = await P().recentIndex();
    f.items = f.items.filter(function (x) { return x.id !== id; });
    var keepThumb = recent.some(function (x) { return x.id === id; });
    await P().idb('readwrite', function (st) {
      st.put(f, 'favIndex'); st.delete('fav:' + id);
      if (!keepThumb) st.delete('thumb:' + id);
    });
  }
  async function toggleFav(id) {
    if (await isFav(id)) { await removeFav(id); App.setStatus('お気に入りから外しました'); return false; }
    if (await addFav(id)) { App.setStatus('お気に入りに入れました'); return true; }
    return false;
  }

  /* ---------- 画面 ---------- */
  var ICON = {
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="12" r="1.5" class="fill"/><circle cx="12" cy="12" r="1.5" class="fill"/><circle cx="17.5" cy="12" r="1.5" class="fill"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>'
  };
  function pdfTile(x, th, kind, fav, open) {
    var btns = kind === 'fav'
      ? '<button class="t-act" data-more="' + x.id + '" aria-label="メニュー">' + ICON.more + '</button>'
      : '<button class="t-act t-star' + (fav ? ' on' : '') + '" data-star="' + x.id + '" aria-label="お気に入り">' + ICON.star + '</button>' +
        '<button class="t-act t-del" data-del="' + x.id + '" aria-label="一覧から外す">×</button>';
    return '<div class="tile' + (open ? ' on' : '') + '">' +
      '<button class="t-open" data-open="' + kind + ':' + x.id + '">' +
      '<span class="t-thumb">' + (th[x.id] ? '<img alt="" src="' + th[x.id] + '">' : '') + '</span>' +
      '<span class="t-name">' + esc(bare(x.name)) + '</span>' +
      (kind === 'recent' ? '<span class="t-when">' + when(x.at) + '</span>' : '') + '</button>' + btns + '</div>';
  }
  function folderTile(fd, n) {
    return '<div class="tile folder">' +
      '<button class="t-open" data-folder="' + fd.id + '"><span class="t-thumb">' + ICON.folder + '<b>' + n + '</b></span>' +
      '<span class="t-name">' + esc(fd.name) + '</span></button>' +
      '<button class="t-act" data-fmore="' + fd.id + '" aria-label="フォルダのメニュー">' + ICON.more + '</button></div>';
  }

  var seq = 0;
  async function render() {
    if (!P()) return;
    var my = ++seq;
    var f = await favIndex(), recent = await P().recentIndex();
    var ids = f.items.map(function (x) { return x.id; }).concat(recent.map(function (x) { return x.id; }));
    var th = await P().thumbs(ids), now = P().current();
    if (my !== seq) return; // あとから頼まれた描き直しがあれば、そちらに任せる（古い中身で上書きしない）
    if (cur && !f.folders.some(function (x) { return x.id === cur; })) cur = null;
    var fd = cur && f.folders.filter(function (x) { return x.id === cur; })[0];
    // お気に入り
    $('favCrumb').innerHTML = fd ? '<button id="favUp">お気に入り</button><span>›</span><b>' + esc(fd.name) + '</b>' : '';
    $('favTitle').hidden = !!fd;
    var html = '';
    if (!fd) f.folders.forEach(function (x) {
      html += folderTile(x, f.items.filter(function (i) { return i.folder === x.id; }).length);
    });
    f.items.filter(function (x) { return (x.folder || null) === (cur || null); })
      .forEach(function (x) { html += pdfTile(x, th, 'fav', true, x.id === now); });
    $('favGrid').innerHTML = html;
    $('favEmpty').hidden = !!html;
    $('favEmpty').textContent = fd ? 'このフォルダは空です。お気に入りのPDFを長押ししてここへドラッグするか、「…」から入れられます' :
      '最近開いたPDFの☆を押すと、ここに入ります';
    // 最近
    var favs = {}; f.items.forEach(function (x) { favs[x.id] = 1; });
    $('recentGrid').innerHTML = recent.map(function (x) { return pdfTile(x, th, 'recent', favs[x.id], x.id === now); }).join('');
    $('recentEmpty').hidden = !!recent.length;
  }

  function show() {
    App.toolbar && App.toolbar.closePops();
    document.body.classList.add('home-on');
    home.hidden = false;
    $('homeClose').hidden = !App.S.hasFile;
    render().catch(function (err) { console.error(err); });
  }
  function hide() {
    if (home.hidden) return;
    home.hidden = true;
    document.body.classList.remove('home-on');
    App.toolbar && App.toolbar.closePops();
  }
  App.on('open', hide);

  /* ---------- メニュー（お気に入りの「…」） ---------- */
  var menu = $('homeMenu');
  function menuAt(anchor, items) {
    menu.innerHTML = items.map(function (it, i) {
      return it.head ? '<div class="mhead">' + esc(it.head) + '</div>'
        : '<button class="item' + (it.danger ? ' danger' : '') + (it.on ? ' cur' : '') + '" data-i="' + i + '">' + esc(it.label) + '</button>';
    }).join('');
    menu.onclick = function (e) {
      var b = e.target.closest('[data-i]'); if (!b) return;
      App.toolbar.closePops();
      Promise.resolve(items[+b.dataset.i].run()).then(render).catch(function (err) { console.error(err); });
    };
    App.toolbar.showPop(menu, anchor);
  }
  async function itemMenu(anchor, id) {
    var f = await favIndex(), it = f.items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    function moveTo(folder) {
      return function () { it.folder = folder; return saveFav(f); };
    }
    var items = [];
    if (f.folders.length || it.folder) {
      items.push({ head: 'フォルダへ移す' });
      if (it.folder) items.push({ label: 'フォルダの外へ', run: moveTo(null) });
      f.folders.forEach(function (fd) { if (fd.id !== it.folder) items.push({ label: fd.name, run: moveTo(fd.id) }); });
    }
    items.push({ label: '新しいフォルダを作って移す', run: function () {
      var fd = newFolder(f); if (!fd) return; it.folder = fd.id; return saveFav(f);
    } });
    items.push({ label: 'お気に入りから外す', danger: true, run: function () { return removeFav(id); } });
    menuAt(anchor, items);
  }
  async function folderMenu(anchor, id) {
    var f = await favIndex(), fd = f.folders.filter(function (x) { return x.id === id; })[0];
    if (!fd) return;
    menuAt(anchor, [
      { label: '名前を変える', run: function () {
        var n = askName('フォルダの名前', fd.name); if (!n) return; fd.name = n; return saveFav(f);
      } },
      { label: 'フォルダを削除（中のPDFはお気に入りに残ります）', danger: true, run: function () {
        f.folders = f.folders.filter(function (x) { return x.id !== id; });
        f.items.forEach(function (x) { if (x.folder === id) x.folder = null; });
        return saveFav(f);
      } }
    ]);
  }
  function askName(msg, def) {
    var n = window.prompt(msg, def || '');
    n = n && n.trim();
    return n ? n.slice(0, 40) : null;
  }
  function newFolder(f) {
    var n = askName('新しいフォルダの名前', '');
    if (!n) return null;
    var fd = { id: 'f' + Date.now().toString(36), name: n };
    f.folders.push(fd);
    return fd;
  }

  /* ---------- 操作 ---------- */
  home.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    var d = t.dataset;
    if (t.id === 'homePick') { $('file').click(); return; } // タップのその場で開く（待つとiPadが開かせてくれない）
    if (t.id === 'homeBlank') { App.blank(); return; }
    if (t.id === 'homeClose') { hide(); return; }
    if (t.id === 'favUp') { cur = null; render(); return; }
    if (t.id === 'newFolder') {
      favIndex().then(function (f) { if (newFolder(f)) return saveFav(f).then(render); });
      return;
    }
    if (d.open) {
      var k = d.open.split(':');
      P().openStored(k[0] === 'fav' ? 'fav:' + k[1] : 'recent:' + k[1], k[1]).then(function (ok) { if (!ok) render(); });
      return;
    }
    if (d.folder) { cur = d.folder; render(); return; }
    if (d.star) { toggleFav(d.star).then(render); return; }
    if (d.del) {
      var tile = t.closest('.tile'); if (tile) tile.remove();
      P().removeRecent(d.del).then(render);
      return;
    }
    if (d.more) { itemMenu(t, d.more); return; }
    if (d.fmore) { folderMenu(t, d.fmore); return; }
  });

  /* ---------- お気に入りのPDFを、長押ししてフォルダへドラッグ ---------- */
  // 長押し（0.35秒）で持ち上げる。ふつうに指を動かしたときは、これまでどおり画面のスクロール
  // 落とせる場所: フォルダのタイル、フォルダの中では上の「お気に入り」（フォルダの外へ出す）
  var drag = null, eatClick = false;
  function dropTarget(x, y) {
    var el = document.elementFromPoint(x, y);
    el = el && el.closest('#favGrid [data-folder], #favUp');
    return el || null;
  }
  function setHot(el) {
    if (drag.hot === el) return;
    if (drag.hot) drag.hot.closest('.tile, .h-crumb').classList.remove('drop-hot');
    drag.hot = el;
    if (el) el.closest('.tile, .h-crumb').classList.add('drop-hot');
  }
  function endDrag(e, ok) {
    if (!drag) return;
    var d = drag; drag = null;
    clearTimeout(d.timer);
    if (!d.active) return;
    eatClick = true; setTimeout(function () { eatClick = false; }, 400);
    if (d.ghost) d.ghost.remove();
    d.tile.classList.remove('dragging');
    home.classList.remove('drag-on');
    var hot = d.hot; if (hot) hot.closest('.tile, .h-crumb').classList.remove('drop-hot');
    if (!ok || !hot) return;
    var to = hot.id === 'favUp' ? null : hot.dataset.folder;
    favIndex().then(function (f) {
      var it = f.items.filter(function (x) { return x.id === d.id; })[0];
      if (!it || (it.folder || null) === to) return;
      it.folder = to;
      var fd = to && f.folders.filter(function (x) { return x.id === to; })[0];
      return saveFav(f).then(function () { App.setStatus(fd ? '「' + fd.name + '」に入れました' : 'フォルダの外へ出しました'); });
    }).then(render).catch(function (err) { console.error(err); });
  }
  $('favGrid').addEventListener('pointerdown', function (e) {
    var tile = e.target.closest('.tile'); if (!tile || tile.classList.contains('folder')) return;
    if (e.target.closest('.t-act')) return;
    var open = tile.querySelector('[data-open^="fav:"]'); if (!open) return;
    if (drag) endDrag(e, false);
    drag = { id: open.dataset.open.slice(4), tile: tile, pid: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, hot: null };
    drag.timer = setTimeout(function () {
      if (!drag || drag.tile !== tile) return;
      drag.active = true;
      var r = tile.getBoundingClientRect(), g = tile.cloneNode(true);
      g.className = 'tile drag-ghost';
      g.style.width = r.width + 'px'; g.style.left = r.left + 'px'; g.style.top = r.top + 'px';
      drag.dx = drag.x0 - r.left; drag.dy = drag.y0 - r.top; drag.ghost = g;
      document.body.appendChild(g);
      tile.classList.add('dragging');
      home.classList.add('drag-on');
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (err) {}
    }, 350);
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) { clearTimeout(drag.timer); drag = null; }
      return;
    }
    drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
    drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    setHot(dropTarget(e.clientX, e.clientY));
  });
  window.addEventListener('pointerup', function (e) { if (drag && e.pointerId === drag.pid) endDrag(e, true); });
  window.addEventListener('pointercancel', function (e) { if (drag && e.pointerId === drag.pid) endDrag(e, false); });
  // 持ち上げている間は、画面をスクロールさせない
  home.addEventListener('touchmove', function (e) { if (drag && drag.active && e.cancelable) e.preventDefault(); }, { passive: false });
  // 落としたあとの「離した」で、PDFが開いたりしないように
  home.addEventListener('click', function (e) { if (eatClick) { e.stopPropagation(); e.preventDefault(); eatClick = false; } }, true);
  home.addEventListener('contextmenu', function (e) { if (e.target.closest('#favGrid .tile')) e.preventDefault(); });

  // 書く画面の「その他」: いま開いているPDFをお気に入りに入れる／外す
  var favBtn = $('favBtn');
  function syncFavBtn() {
    var id = P() && P().current();
    favBtn.hidden = !id;
    if (id) isFav(id).then(function (on) { favBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  }
  $('moreBtn').addEventListener('click', syncFavBtn);
  favBtn.addEventListener('click', function () {
    var id = P() && P().current(); if (!id) return;
    toggleFav(id).then(function (on) { favBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  });

  window.Home = { show: show, hide: hide, render: render, isFav: isFav };
})();
