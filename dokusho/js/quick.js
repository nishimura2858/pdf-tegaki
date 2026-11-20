/* 全画面のときの、道具の呼び出し
   全画面では、道具のバーもパレットも出さず、本だけを見せる。道具は指で呼び出す
   - 指で1回たたく: 画面の下に「道具の帯」が出る。道具・色・太さ・元に戻すが1枚にまとまっている
     （中身のうち、色・太さなどはパレットの中身をそのまま移して使う）。紙をさわるか、何もしないと数秒で消える
   - 2本指でたたく: 元に戻す（全画面でなくても使える。GoodNotesと同じ）
   - 長押しで出す「輪のメニュー」も作ったが、ユーザーの希望でなくした（2026-11-17）
   - 小口のインデックス: 「小口に出す」にした付箋を、指で1回たたいたときに画面の左右の端に出す
     （全画面では道具の帯と一緒に出て、一緒に消える。全画面でないときは、1回たたくと出て、数秒で消える）。
     今より前のページの付箋は左、後ろのページの付箋は右（紙の本のインデックスと同じ）。たたくとそのページへ飛ぶ
   指の操作を見分けるのは app.js（hooks.singleTap / twoTap） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var tray = $('tray'), panel = $('palPanel'), palette = $('palette');
  var TOOLS = ['highlighter', 'pen', 'eraser', 'note'];

  function focusOn() { return S.hasFile && document.body.classList.contains('focus') && !document.body.classList.contains('home-on'); }
  function icon(t) { var b = document.querySelector('.topbar [data-tool="' + t + '"]'); return b ? b.querySelector('svg').outerHTML : ''; }
  function label(t) { var b = document.querySelector('.topbar [data-tool="' + t + '"]'); return b ? b.getAttribute('aria-label') : t; }

  /* ---------- 道具の帯 ---------- */
  TOOLS.forEach(function (t) {
    var b = document.createElement('button');
    b.dataset.tool = t; b.setAttribute('aria-label', label(t)); b.innerHTML = icon(t);
    $('trayTools').appendChild(b);
  });
  // 全画面に入るときに、パレットの中身（色・太さ・消しゴムの大きさ・付箋の色・元に戻す）を帯へ移す。出るときに戻す
  App.on('focus', function (on) {
    if (on) $('trayPanel').appendChild(panel);
    else { hideTray(true); palette.appendChild(panel); }
    if (on) hideEdge(true);
  });
  var hideT = 0, closedAt = 0;
  function info() {
    $('trayPage').textContent = App.pageText();
    var f = window.Scrap && S.kind === 'scrap' ? Scrap.sourceOf(S.page) : null;
    $('traySrc').hidden = !f;
    if (f) $('traySrc').textContent = '「' + f.name + '」' + f.page + 'ページ ›';
  }
  function arm(ms) {
    clearTimeout(hideT);
    hideT = setTimeout(function () {
      if (document.querySelector('.pop.open')) { arm(1500); return; } // 色の一覧などを開いている間は消さない
      hideTray();
    }, ms);
  }
  function markTool() {
    $('trayTools').querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === S.tool); });
  }
  function showTray() {
    if (!focusOn()) return;
    App.toolbar.closePops();
    info(); markTool();
    tray.hidden = false; void tray.offsetWidth;
    tray.classList.add('on');
    arm(4000);
    showEdge(false);
  }
  function hideTray(now) {
    clearTimeout(hideT);
    hideEdge(now);
    if (tray.hidden) return;
    tray.classList.remove('on');
    if (now) { tray.hidden = true; return; }
    setTimeout(function () { if (!tray.classList.contains('on')) tray.hidden = true; }, 220);
  }
  /* ---------- 小口のインデックス ---------- */
  var edge = $('edgeTabs'), edgeOn = false, edgeT = 0, GAP = 6, HIT = 30;
  // 帯の幅（全部の付箋で共通）。細いときは、見た目は細くても、たたける幅（HIT）は広くとる
  var WIDTHS = { s: { w: 9, h: 40 }, m: { w: 20, h: 50 }, l: { w: 34, h: 58 } }, W_KEY = 'dk:ui:edgeW', edgeW = 's';
  try { if (WIDTHS[localStorage.getItem(W_KEY)]) edgeW = localStorage.getItem(W_KEY); } catch (e) {}
  function tabNotes() {
    var a = [];
    Object.keys(S.notes).forEach(function (k) { (S.notes[k] || []).forEach(function (t) { if (t && t.tab) a.push({ n: +k, t: t }); }); });
    return a;
  }
  function shownPages() { var a = [S.page], m = S.spread && App.stillPage ? App.stillPage() : 0; if (m) a.push(m); return a; }
  function tabLabel(t) { return (t.text || '').replace(/\s+/g, '').slice(0, 2); }
  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function layoutEdge() {
    var list = tabNotes();
    edge.textContent = '';
    if (!list.length) return false;
    var sh = shownPages(), lo = Math.min.apply(null, sh), hi = Math.max.apply(null, sh);
    var sr = App.stage.getBoundingClientRect(), top = sr.top + 10, bot = sr.bottom - 10, avail = bot - top;
    var sides = { l: [], r: [] };
    list.forEach(function (o) {
      o.here = o.n >= lo && o.n <= hi;
      var side = o.n < lo ? 'l' : o.n > hi ? 'r' : (sh.length === 2 && o.n === lo ? 'l' : 'r');
      sides[side].push(o);
    });
    ['l', 'r'].forEach(function (side) {
      var a = sides[side]; if (!a.length) return;
      // 付箋を貼った高さに出す。重なるときは、ずらす。入りきらないときは、低くする
      var sz = WIDTHS[edgeW], bw = Math.max(sz.w, HIT);
      var h = Math.max(22, Math.min(sz.h, avail / a.length - GAP));
      a.forEach(function (o) { o.want = Math.max(top, Math.min(bot - h, top + o.t.y * avail - h / 2)); });
      a.sort(function (p, q) { return p.want - q.want || p.n - q.n; });
      var i, prev = -1e9;
      for (i = 0; i < a.length; i++) { a[i].top = Math.max(a[i].want, prev + h + GAP); prev = a[i].top; }
      var next = 1e9;
      for (i = a.length - 1; i >= 0; i--) { a[i].top = Math.min(a[i].top, bot - h, next - h - GAP); next = a[i].top; }
      a.forEach(function (o) {
        var b = document.createElement('button'), lb = tabLabel(o.t);
        b.className = 'etab ' + side + (o.here ? ' here' : '');
        b.dataset.n = o.n; b.dataset.id = o.t.id;
        b.style.top = Math.max(top, o.top) + 'px'; b.style.height = h + 'px'; b.style.width = bw + 'px';
        b.style.setProperty('--c', o.t.color || '#ffd84d'); b.style.setProperty('--w', sz.w + 'px');
        if (side === 'l') b.style.left = sr.left + 'px'; else b.style.left = (sr.right - bw) + 'px';
        b.setAttribute('aria-label', o.n + 'ページの付箋' + (o.t.text ? '「' + o.t.text.slice(0, 30) + '」' : '') + 'へ');
        // 細い: 色だけ / ふつう: ページ番号 / 太い: メモの最初の2文字とページ番号
        var inner = edgeW === 'l' ? (lb && h >= 44 ? '<b>' + esc(lb) + '</b>' : '') + '<small>' + o.n + '</small>' : edgeW === 'm' ? '<small>' + o.n + '</small>' : '';
        b.innerHTML = '<span class="strip">' + inner + '</span>';
        edge.appendChild(b);
      });
    });
    return true;
  }
  function edgeArm(ms) {
    clearTimeout(edgeT);
    if (focusOn()) return; // 全画面では、道具の帯と一緒に消える
    edgeT = setTimeout(function () {
      if (document.querySelector('.pop.open')) { edgeArm(1500); return; }
      hideEdge();
    }, ms);
  }
  function showEdge(own) {
    if (!S.hasFile || document.body.classList.contains('home-on')) return false;
    if (!layoutEdge()) { hideEdge(true); return false; }
    edgeOn = true;
    edge.hidden = false; void edge.offsetWidth;
    edge.classList.add('on');
    if (own) edgeArm(5000);
    return true;
  }
  function hideEdge(now) {
    clearTimeout(edgeT);
    if (!edgeOn && edge.hidden) return;
    edgeOn = false;
    edge.classList.remove('on');
    if (now) { edge.hidden = true; return; }
    setTimeout(function () { if (!edgeOn) edge.hidden = true; }, 220);
  }
  edge.addEventListener('click', function (e) {
    var b = e.target.closest('.etab'); if (!b) return;
    var n = +b.dataset.n, id = b.dataset.id;
    if (focusOn()) arm(4000); else edgeArm(5000);
    Promise.resolve(App.goPage(n)).then(function () {
      if (window.Notes && Notes.flash) Notes.flash(id);
      if (edgeOn) layoutEdge();
    });
  });
  // 付箋を開いた画面の「帯の幅」
  var twBox = $('noteTabW');
  function markW() { twBox.querySelectorAll('[data-tw]').forEach(function (b) { b.classList.toggle('on', b.dataset.tw === edgeW); }); }
  markW();
  twBox.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tw]'); if (!b) return;
    edgeW = b.dataset.tw; markW();
    try { localStorage.setItem(W_KEY, edgeW); } catch (er) {}
    if (focusOn()) { if (!tray.hidden) layoutEdge(); } else showEdge(true); // 見本として出す
  });
  App.on('page', function () { if (edgeOn) layoutEdge(); });
  App.on('notes', function () { if (edgeOn && !layoutEdge()) hideEdge(); });
  App.on('layout', function () { if (edgeOn) layoutEdge(); });
  window.addEventListener('resize', function () { if (edgeOn) layoutEdge(); });

  // 帯をさわっている間は消さない
  tray.addEventListener('pointerdown', function () { arm(4000); }, true);
  edge.addEventListener('pointerdown', function () { if (focusOn()) arm(4000); else edgeArm(5000); }, true);
  tray.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    arm(3000);
    if (b.id === 'trayExit') { hideTray(true); App.toolbar.setFocus(false); }
    else if (b.id === 'trayScrap') Scrap.pick(null, b);
    else if (b.id === 'trayBw') Scrap.bwPick(b);
    else if (b.id === 'trayPiece') Scrap.editShown();
    else if (b.id === 'traySrc') { hideTray(true); Scrap.openSource(S.page); }
  });
  // 帯の外（紙など）をさわったら消す。そのさわった操作（書く・めくる）は、そのまま続く
  document.addEventListener('pointerdown', function (e) {
    var trayOn = !tray.hidden && tray.classList.contains('on');
    if (!trayOn && !edgeOn) return;
    if (tray.contains(e.target) || edge.contains(e.target) || (e.target.closest && e.target.closest('.pop'))) return;
    closedAt = performance.now();
    if (trayOn) hideTray(); else hideEdge();
  }, true);
  App.hooks.singleTap = function () {
    if (performance.now() - closedAt < 900) return; // 帯・インデックスを消すためにたたいたとき
    if (focusOn()) { if (tray.hidden) showTray(); else hideTray(); return; }
    if (!S.hasFile) return;
    if (edgeOn) hideEdge(); else showEdge(true);
  };
  App.on('page', function () { if (!tray.hidden) info(); });
  App.on('open', function () { hideTray(true); });
  App.on('close', function () { hideTray(true); });

  /* ---------- 2本指でたたく: 元に戻す ---------- */
  App.hooks.twoTap = function () {
    if (!S.hasFile) return;
    var u = $('undo');
    if (u.disabled) { App.setStatus('元に戻せるものはありません'); return; }
    u.click();
    App.setStatus('元に戻しました（2本指でたたく）');
  };

  window.Quick = { showTray: showTray, hideTray: hideTray };
})();
