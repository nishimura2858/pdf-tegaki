/* ページ一覧（左のサイドバー）と、PDFの中の文字の検索 */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var thumbs = $('thumbs'), side = $('sidebar');
  var THUMB_W = 132;

  /* ---------- ページ一覧 ---------- */
  var sideOpen = false, dirty = {}, queue = [], running = false, observer = null, built = false, startAt = 0;

  function runQueue() {
    if (running) return;
    // 一覧が滑り出している間は描かない（動きがカクカクしないように）
    var wait = startAt - performance.now();
    if (wait > 0) { setTimeout(runQueue, wait + 10); return; }
    var job = queue.shift(); if (!job) return;
    running = true;
    App.renderThumb(job.canvas, job.n, THUMB_W).catch(function (e) { console.error(e); })
      .then(function () { job.el.classList.add('ready'); running = false; runQueue(); });
  }
  function request(el) {
    var n = +el.dataset.n;
    if (queue.some(function (j) { return j.el === el; })) return;
    queue.push({ el: el, n: n, canvas: el.querySelector('canvas') });
    runQueue();
  }
  function build() {
    if (observer) observer.disconnect();
    queue = []; thumbs.textContent = '';
    if (!S.hasFile) return;
    built = true;
    observer = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (en.isIntersecting && !en.target.dataset.done) { en.target.dataset.done = '1'; request(en.target); }
      });
    }, { root: side, rootMargin: '300px 0px' });
    for (var n = 1; n <= S.total; n++) {
      var el = document.createElement('button');
      el.className = 'thumb'; el.dataset.n = n;
      el.innerHTML = '<span class="paper"><canvas></canvas></span><span class="num">' + n + '</span>';
      var e = App.pageEntry(n);
      el.querySelector('.paper').style.aspectRatio = e.src > 0 ? '' : (e.w + ' / ' + e.h);
      thumbs.appendChild(el);
      observer.observe(el);
    }
    mark();
  }
  function mark() {
    thumbs.querySelectorAll('.thumb').forEach(function (t) { t.classList.toggle('on', +t.dataset.n === S.page); });
    var cur = thumbs.querySelector('.thumb.on');
    if (cur && sideOpen) {
      var r = cur.getBoundingClientRect(), sr = side.getBoundingClientRect();
      if (r.top < sr.top || r.bottom > sr.bottom) cur.scrollIntoView({ block: 'center' });
    }
  }
  function refreshDirty() {
    Object.keys(dirty).forEach(function (n) {
      var el = thumbs.querySelector('.thumb[data-n="' + n + '"]');
      if (el && el.dataset.done) request(el);
    });
    dirty = {};
  }
  // 一覧は紙の上に重ねて出す（紙の大きさは変えない）。一度作った小さな絵は使い回す
  function setSide(v) {
    sideOpen = v;
    if (v) {
      startAt = performance.now() + 320;
      if (!built) build(); else { mark(); refreshDirty(); }
    }
    document.body.classList.toggle('side-open', v);
    $('sideBtn').classList.toggle('on', v);
  }
  $('sideBtn').addEventListener('click', function () {
    if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); return; }
    setSide(!sideOpen);
  });
  thumbs.addEventListener('click', function (e) {
    var t = e.target.closest('.thumb'); if (t) App.goPage(+t.dataset.n);
  });
  var dt = null;
  App.on('data', function () {
    dirty[S.page] = 1;
    if (!sideOpen) return;
    clearTimeout(dt); dt = setTimeout(refreshDirty, 900);
  });
  App.on('page', function () { if (sideOpen) mark(); showMarks(); });
  App.on('layout', function () { built = false; if (sideOpen) build(); });
  App.on('open', function () { textCache = {}; query = ''; clearMarks(); built = false; if (sideOpen) build(); });

  /* ---------- 検索 ---------- */
  var textCache = {}, query = '', input = null, timer = null;
  // 全角の英数字を半角に、大文字を小文字にそろえる（文字数は変えない）
  function norm(s) {
    return String(s).replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/　/g, ' ').toLowerCase();
  }
  async function pageText(src) {
    if (textCache[src]) return textCache[src];
    var page = await S.pdf.getPage(src);
    var vp = page.getViewport({ scale: 1 });
    var tc = await page.getTextContent();
    var text = '', parts = [];
    tc.items.forEach(function (it) {
      if (typeof it.str !== 'string') return;
      var start = text.length;
      text += it.str;
      var tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      var fh = Math.hypot(tx[2], tx[3]);
      parts.push({ s: start, e: text.length, x: tx[4], y: tx[5] - fh, w: it.width * vp.scale, h: fh, W: vp.width, H: vp.height });
      if (it.hasEOL) text += ' ';
    });
    return (textCache[src] = { text: norm(text), raw: text, parts: parts });
  }
  // 見つかった場所を、ページ上の四角（ページに対する割合）にする
  function rects(t, ms, me) {
    var out = [];
    t.parts.forEach(function (p) {
      if (p.e <= ms || p.s >= me || p.e === p.s) return;
      var len = p.e - p.s, a = Math.max(ms, p.s) - p.s, b = Math.min(me, p.e) - p.s;
      out.push({ x: (p.x + p.w * a / len) / p.W, y: p.y / p.H, w: p.w * (b - a) / len / p.W, h: p.h / p.H });
    });
    return out;
  }
  async function run() {
    var q = norm(input ? input.value : '').trim();
    query = q;
    var res = $('searchResults'), info = $('searchInfo');
    res.textContent = '';
    clearMarks();
    if (!q) { info.textContent = 'PDFの中の文字を探します（手書きの文字は探せません）'; return; }
    if (!S.pdf) { info.textContent = '白紙のノートには、探せる文字がありません'; return; }
    info.textContent = '探しています…';
    var count = 0, html = [];
    for (var n = 1; n <= S.total; n++) {
      var e = App.pageEntry(n);
      if (!(e.src > 0)) continue;
      var t;
      try { t = await pageText(e.src); } catch (err) { console.error(err); continue; }
      if (q !== query) return; // 入力が変わった
      var i = t.text.indexOf(q);
      while (i >= 0 && count < 200) {
        count++;
        var a = Math.max(0, i - 14), b = Math.min(t.raw.length, i + q.length + 24);
        html.push('<button class="hit" data-n="' + n + '"><span class="pn">' + n + 'ページ</span><span class="snip">' +
          esc(t.raw.slice(a, i)) + '<mark>' + esc(t.raw.slice(i, i + q.length)) + '</mark>' + esc(t.raw.slice(i + q.length, b)) + '</span></button>');
        i = t.text.indexOf(q, i + q.length);
      }
    }
    info.textContent = count ? count + '件見つかりました' + (count >= 200 ? '（最初の200件）' : '') : '見つかりませんでした（文字が画像になっているPDFは探せません）';
    res.innerHTML = html.join('');
    showMarks();
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // 今のページで見つかった場所に、黄色い印をつける
  function clearMarks() { $('marks').textContent = ''; }
  async function showMarks() {
    clearMarks();
    if (!query || !S.pdf || !S.hasFile) return;
    var e = App.pageEntry(S.page); if (!(e.src > 0)) return;
    var q = query, t = await pageText(e.src);
    if (q !== query) return;
    var html = [], i = t.text.indexOf(q);
    while (i >= 0) {
      rects(t, i, i + q.length).forEach(function (r) {
        html.push('<i style="left:' + (r.x * 100) + '%;top:' + (r.y * 100) + '%;width:' + (r.w * 100) + '%;height:' + (r.h * 100) + '%"></i>');
      });
      i = t.text.indexOf(q, i + q.length);
    }
    $('marks').innerHTML = html.join('');
  }

  $('searchBtn').addEventListener('click', function (e) {
    if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); return; }
    var pop = $('searchPop');
    App.toolbar.showPop(pop, e.currentTarget);
    if (!pop.classList.contains('open')) return;
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブル対策）
    if (!input) {
      input = document.createElement('input');
      input.type = 'search'; input.id = 'searchInput'; input.placeholder = 'PDFの中を検索';
      input.autocomplete = 'off'; input.spellcheck = false;
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { clearTimeout(timer); run(); input.blur(); } });
      $('searchSlot').appendChild(input);
      input.value = query;
    }
    if (!query) run();
    setTimeout(function () { input && input.focus(); }, 50);
  });
  $('searchResults').addEventListener('click', function (e) {
    var h = e.target.closest('.hit'); if (!h) return;
    App.goPage(+h.dataset.n);
    App.toolbar.closePops();
  });
  App.on('popClosed', function () {
    if (input && !$('searchPop').classList.contains('open')) {
      input.blur(); input.remove(); input = null;
    }
  });
})();
