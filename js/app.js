/* 手書きの中心部分: ページの表示、ペン入力、保存
   - 道具のボタン類は toolbar.js、投げ縄・レーザーは lasso.js、ページ一覧・検索は pages.js
   - 手書きデータ（JSON）: { version, pdf, layout?, images?, pages: { "ページ番号": [線や画像, …] } }
     - 線: { tool: pen|pencil|highlighter, color, width, points: [[x, y, 筆圧], …] }（x, y はページに対する割合）
     - 画像: { tool: 'image', id, x, y, w, h }。画像の中身は images[id]（data URL）
     - layout: ページの並び [{ src: 元のPDFのページ番号（0は白紙）, w, h, added }]。ページを追加したときだけ保存する */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), wrap = $('wrap'), pdfC = $('pdfc'), ink = $('ink'), lc = $('livec');
  var pctx = pdfC.getContext('2d'), ictx = ink.getContext('2d'), lctx = lc.getContext('2d');
  var tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  var MAXZOOM = 2.5, PENS = { pen: 1, pencil: 1, highlighter: 1 };
  var A4 = { w: 595, h: 842 };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  var S = {
    pdf: null, hasFile: false, name: '', key: '',
    page: 1, total: 1, zoom: 1, layout: [], images: {}, pageSize: A4,
    tool: 'pen', color: '#e53935', width: 4, shape: false, eraser: 14,
    strokes: {}, undo: [], redo: [], cache: {}, dirty: {},
    cssW: 0, cssH: 0, live: null, rc: null, anchor: null, xform: null
  };
  var hooks = { saved: null, opened: null }; // Drive同期から使う通知先
  var tools = {};                            // 投げ縄・レーザーなど、別ファイルの道具
  var listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function emit(ev, a) { (listeners[ev] || []).forEach(function (fn) { try { fn(a); } catch (e) { console.error(e); } }); }
  var renderToken = 0, renderTask = null, saveTimer = null, lastStageW = 0;

  /* ---------- 確認用モード（URLに ?debug=1 を付けたときだけ動く） ---------- */
  var DEBUG = /[?&]debug=1(&|$)/.test(location.search);
  var dbgBox = null, dbgLines = [], dbgT0 = performance.now();
  function dbg(msg) {
    if (!DEBUG) return;
    dbgLines.push(((performance.now() - dbgT0) / 1000).toFixed(2) + ' ' + msg);
    if (dbgLines.length > 22) dbgLines.shift();
    if (!dbgBox) {
      dbgBox = document.createElement('pre');
      dbgBox.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:50;margin:0;padding:6px 8px;' +
        'max-width:60vw;background:rgba(0,0,0,.72);color:#9f9;font:11px/1.35 ui-monospace,Menlo,monospace;' +
        'border-radius:6px;pointer-events:none;white-space:pre-wrap;';
      document.body.appendChild(dbgBox);
    }
    dbgBox.textContent = dbgLines.join('\n');
  }
  if (DEBUG) {
    // 画面の更新が止まった時間を記録する
    var lastFrame = performance.now();
    requestAnimationFrame(function tick(now) {
      if (now - lastFrame > 150 && !document.hidden) dbg('!! 画面停止 ' + Math.round(now - lastFrame) + 'ms');
      lastFrame = now;
      requestAnimationFrame(tick);
    });
    // 手書き面以外に入ったペン入力
    document.addEventListener('pointerdown', function (e) {
      if (e.target !== ink) dbg('入力(' + e.pointerType + ') → 手書き面の外: ' + (e.target.id || e.target.tagName) + ' 位置' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
    }, true);
    dbg('確認用モード開始');
  }

  /* DOM更新は値が変わったときだけ（余計な再レイアウトを避ける） */
  var ui = {};
  function setText(el, t) { if (ui[el.id] !== t) { ui[el.id] = t; el.textContent = t; } }
  function setDis(el, v) { var k = 'd' + el.id; if (ui[k] !== v) { ui[k] = v; el.disabled = v; } }
  // お知らせは画面下に数秒だけ出す
  var statusTimer = null;
  function setStatus(t) {
    var el = $('status');
    setText(el, t);
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { el.classList.remove('show'); }, 3500);
  }
  // 右下のページ番号を少しのあいだ出す（text を渡すとその文字を出す: 倍率など）
  var pagerTimer = null;
  function flashPager(text) {
    var el = $('pager');
    if (!S.hasFile) return;
    setText($('pageLabel'), text || (S.page + ' / ' + S.total));
    el.classList.add('show');
    clearTimeout(pagerTimer);
    pagerTimer = setTimeout(function () {
      pagerTimer = null;
      el.classList.remove('show');
      setText($('pageLabel'), S.page + ' / ' + S.total);
    }, 1400);
  }
  function r4(n) { return Math.round(n * 10000) / 10000; }
  function pages() { return S.strokes[S.page] || []; }

  /* ---------- 描画 ---------- */
  // えんぴつの質感（ざらざら）に使う模様
  var noiseTile = null;
  function noise() {
    if (noiseTile) return noiseTile;
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d'), img = x.createImageData(64, 64), seed = 12345;
    for (var i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      img.data[i + 3] = Math.round(255 * (0.3 + 0.7 * (seed / 2147483647)));
    }
    x.putImageData(img, 0, 0);
    return (noiseTile = c);
  }
  // 筆圧に応じた線の太さ（画面上の大きさ W に対して）
  function widthAt(s, W, p) {
    var base = s.width * W / 1000;
    return s.tool === 'pencil' ? base * (0.45 + 0.9 * p) : base * (0.6 + 0.8 * p);
  }
  function segs(ctx, s, W, H, from) {
    var p = s.points;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0] * W, p[0][1] * H, widthAt(s, W, p[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (var j = Math.max(1, from || 1); j < p.length; j++) {
      ctx.lineWidth = widthAt(s, W, (p[j][2] + p[j - 1][2]) / 2);
      ctx.beginPath();
      ctx.moveTo(p[j - 1][0] * W, p[j - 1][1] * H);
      ctx.lineTo(p[j][0] * W, p[j][1] * H);
      ctx.stroke();
    }
  }
  function hlWidth(s, W) { return s.width * W / 1000 * 5; }
  function hlPath(ctx, s, W, H) {
    var p = s.points;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = hlWidth(s, W); ctx.strokeStyle = s.color;
    ctx.beginPath(); ctx.moveTo(p[0][0] * W, p[0][1] * H);
    for (var i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * W, p[i][1] * H);
    if (p.length === 1) ctx.lineTo(p[0][0] * W + 0.01, p[0][1] * H);
    ctx.stroke();
  }
  /* 線全体をいったん別の紙に描いてから、透明度（蛍光ペン）や質感（えんぴつ）をつけて重ねる */
  function composite(ctx, s, W, H, alpha, textured) {
    var p = s.points, i;
    var pad = (s.tool === 'highlighter' ? hlWidth(s, W) : widthAt(s, W, 1)) / 2 + 2;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (i = 0; i < p.length; i++) {
      var x = p[i][0] * W, y = p[i][1] * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (tmp.width < W || tmp.height < H) { tmp.width = Math.max(tmp.width, Math.ceil(W)); tmp.height = Math.max(tmp.height, Math.ceil(H)); }
    var bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
    var bw = Math.min(W, Math.ceil(x1 + pad)) - bx, bh = Math.min(H, Math.ceil(y1 + pad)) - by;
    if (bw <= 0 || bh <= 0) return;
    tctx.save();
    tctx.clearRect(bx, by, bw, bh);
    tctx.beginPath(); tctx.rect(bx, by, bw, bh); tctx.clip();
    if (s.tool === 'highlighter') hlPath(tctx, s, W, H); else segs(tctx, s, W, H);
    if (textured) {
      tctx.globalCompositeOperation = 'destination-in';
      tctx.fillStyle = tctx.createPattern(noise(), 'repeat');
      tctx.fillRect(bx, by, bw, bh);
    }
    tctx.restore();
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.drawImage(tmp, bx, by, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }
  // 画像
  var imgEls = {};
  function imgEl(id) {
    var el = imgEls[id];
    if (!el && S.images[id]) {
      el = imgEls[id] = new Image();
      el.onload = function () { drawInk(); emit('data'); };
      el.src = S.images[id];
    }
    return el;
  }
  function drawItem(ctx, s, W, H) {
    if (s.tool === 'image') {
      var el = imgEl(s.id);
      if (el && el.complete && el.naturalWidth) ctx.drawImage(el, s.x * W, s.y * H, s.w * W, s.h * H);
      return;
    }
    if (!s.points || !s.points.length) return;
    if (s.tool === 'highlighter') composite(ctx, s, W, H, 0.35, false);
    else if (s.tool === 'pencil') composite(ctx, s, W, H, 0.92, true);
    else segs(ctx, s, W, H);
  }
  // 画像を先に、線をあとに描く（画像の上に書けるように）。xf: 投げ縄で動かしている最中の見た目
  function drawList(ctx, list, W, H, xf) {
    var i, s;
    for (i = 0; i < list.length; i++) { s = xf ? xf(list[i]) : list[i]; if (s.tool === 'image') drawItem(ctx, s, W, H); }
    for (i = 0; i < list.length; i++) { s = xf ? xf(list[i]) : list[i]; if (s.tool !== 'image') drawItem(ctx, s, W, H); }
  }
  function drawInk() {
    ictx.clearRect(0, 0, ink.width, ink.height);
    drawList(ictx, pages(), ink.width, ink.height, S.xform);
    if (S.live && S.live.tool === 'pen') segs(ictx, S.live, ink.width, ink.height, 1);
  }

  /* ---------- ページの並び ---------- */
  function defaultLayout() {
    if (!S.pdf) return [{ src: 0, w: A4.w, h: A4.h }];
    var a = [];
    for (var i = 1; i <= S.pdf.numPages; i++) a.push({ src: i });
    return a;
  }
  function entry(n) { return S.layout[(n || S.page) - 1] || { src: S.pdf ? 1 : 0 }; }
  // ページの大きさ（PDFの単位）と、pdf.js のページ（白紙なら null）
  async function pageInfo(n) {
    var e = entry(n);
    if (e.src > 0 && S.pdf) {
      var page = await S.pdf.getPage(e.src);
      var b = page.getViewport({ scale: 1 });
      return { page: page, w: b.width, h: b.height };
    }
    return { page: null, w: e.w || A4.w, h: e.h || A4.h };
  }

  async function renderPage() {
    if (!S.hasFile) return;
    var t0 = performance.now();
    var token = ++renderToken;
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }
    var info = await pageInfo(S.page);
    if (token !== renderToken) return;
    var page = info.page, bw = info.w, bh = info.h;
    S.pageSize = { w: bw, h: bh };
    lastStageW = stage.clientWidth;
    var cssW = Math.max(240, (stage.clientWidth - 24) * S.zoom);
    var cssH = cssW * bh / bw, area = cssW * cssH;
    var dw = Math.min(window.devicePixelRatio || 1, 2);
    var dprPdf = Math.max(0.7, Math.min(dw, Math.sqrt(9e6 / area)));
    var dprInk = Math.max(0.7, Math.min(dw, Math.sqrt(6e6 / area)));
    S.cssW = cssW; S.cssH = cssH;
    wrap.style.width = cssW + 'px'; wrap.style.height = cssH + 'px';
    pdfC.width = Math.floor(cssW * dprPdf); pdfC.height = Math.floor(cssH * dprPdf);
    [ink, lc, tmp].forEach(function (c) { c.width = Math.floor(cssW * dprInk); c.height = Math.floor(cssH * dprInk); });
    [pdfC, ink, lc].forEach(function (c) { c.style.width = cssW + 'px'; c.style.height = cssH + 'px'; });
    if (S.anchor) {
      var a = S.anchor; S.anchor = null;
      var rc = wrap.getBoundingClientRect();
      stage.scrollLeft += rc.left + a.fx * rc.width - a.cx;
      stage.scrollTop += rc.top + a.fy * rc.height - a.cy;
    }
    drawInk();
    emit('resize');
    if (page) {
      var task = page.render({ canvasContext: pctx, viewport: page.getViewport({ scale: cssW / bw * dprPdf }) });
      renderTask = task;
      try { await task.promise; }
      catch (e) {
        if (!(e && e.name === 'RenderingCancelledException')) { setStatus('PDFの表示に失敗しました'); console.error(e); }
      }
    } else {
      pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, pdfC.width, pdfC.height);
    }
    dbg('ページ描き直し ' + Math.round(performance.now() - t0) + 'ms（倍率' + Math.round(S.zoom * 100) + '%）');
    updateUI();
  }

  /* ページ一覧用の小さな絵（PDF＋手書き）を canvas に描く */
  async function renderThumb(canvas, n, cssWidth) {
    var info = await pageInfo(n);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = Math.round(cssWidth * dpr), H = Math.round(cssWidth * info.h / info.w * dpr);
    canvas.width = W; canvas.height = H;
    canvas.style.width = cssWidth + 'px'; canvas.style.height = (cssWidth * info.h / info.w) + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (info.page) await info.page.render({ canvasContext: ctx, viewport: info.page.getViewport({ scale: W / info.w }) }).promise;
    drawList(ctx, S.strokes[n] || [], W, H);
  }

  function updateUI() {
    if (!pagerTimer) setText($('pageLabel'), S.hasFile ? (S.page + ' / ' + S.total) : '- / -');
    setDis($('prev'), !S.hasFile || S.page <= 1);
    setDis($('next'), !S.hasFile || S.page >= S.total);
    setDis($('undo'), !S.undo.length);
    setDis($('redo'), !S.redo.length);
    emit('ui');
  }

  /* ---------- 保存・復元 ---------- */
  function layoutCustom() { return S.layout.some(function (e) { return e.added; }); }
  // 使っている画像だけを保存する（取り消し履歴にある画像も残す）
  function usedImages() {
    var ids = {};
    function scan(list) { (list || []).forEach(function (s) { if (s.tool === 'image') ids[s.id] = 1; }); }
    Object.keys(S.strokes).forEach(function (k) { scan(S.strokes[k]); });
    S.undo.concat(S.redo).forEach(function (u) { scan(u.strokes); });
    var out = {};
    Object.keys(ids).sort().forEach(function (id) { if (S.images[id]) out[id] = S.images[id]; });
    return out;
  }
  function exportData() {
    var out = {};
    for (var k in S.strokes) if (S.strokes[k].length) out[k] = S.strokes[k];
    var d = { version: 1, pdf: S.name };
    if (layoutCustom()) d.layout = S.layout;
    var im = usedImages(); if (Object.keys(im).length) d.images = im;
    d.pages = out;
    return d;
  }
  function num(v, lo, hi, def) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
  /* 読み込んだデータを確かめて、使える形に直す。だめなら null */
  function parseData(d) {
    if (!d || typeof d !== 'object' || !d.pages || typeof d.pages !== 'object') return null;
    var res = {};
    Object.keys(d.pages).forEach(function (k) {
      var arr = d.pages[k]; if (!Array.isArray(arr)) return;
      var list = [];
      arr.forEach(function (s) {
        if (!s) return;
        if (s.tool === 'image') {
          if (typeof s.id === 'string' && isFinite(s.x) && isFinite(s.y) && s.w > 0 && s.h > 0)
            list.push({ tool: 'image', id: s.id, x: +s.x, y: +s.y, w: +s.w, h: +s.h });
          return;
        }
        if (!Array.isArray(s.points) || !s.points.length) return;
        var pts = [];
        s.points.forEach(function (q) {
          if (Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]))
            pts.push([+q[0], +q[1], isFinite(q[2]) ? +q[2] : 0.5]);
        });
        if (!pts.length) return;
        list.push({
          tool: PENS[s.tool] ? s.tool : 'pen',
          color: /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#1b2430',
          width: num(s.width, 0.5, 40, 4),
          points: pts
        });
      });
      if (list.length) res[k] = list;
    });
    var layout = null;
    if (Array.isArray(d.layout) && d.layout.length) {
      var max = S.pdf ? S.pdf.numPages : 0, ok = true;
      layout = d.layout.map(function (e) {
        var src = Math.floor(+(e && e.src));
        if (!(src >= 0 && src <= max)) ok = false;
        var o = { src: src };
        if (src === 0) { o.w = num(e.w, 50, 5000, A4.w); o.h = num(e.h, 50, 5000, A4.h); }
        if (e && e.added) o.added = true;
        return o;
      });
      if (!ok) layout = null;
    }
    var images = {};
    if (d.images && typeof d.images === 'object') Object.keys(d.images).forEach(function (id) {
      var v = d.images[id];
      if (typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(v)) images[id] = v;
    });
    return { pages: res, layout: layout, images: images };
  }
  function applyData(r) {
    S.strokes = r.pages;
    S.images = r.images || {};
    imgEls = {};
    S.layout = r.layout || defaultLayout();
    S.total = S.layout.length;
    if (S.page > S.total) S.page = S.total;
    S.undo = []; S.redo = []; S.cache = {}; S.dirty = {};
  }
  var imgJson = { key: '', text: '' };
  // quiet === true のときは「変更あり」を外部（Drive同期）に知らせない（Driveから読み込んだ直後の保存など）
  function doSave(quiet) {
    saveTimer = null;
    var t0 = performance.now();
    try {
      var parts = [];
      Object.keys(S.strokes).forEach(function (k) {
        var arr = S.strokes[k];
        if (!arr.length) { delete S.cache[k]; return; }
        if (S.dirty[k] || S.cache[k] === undefined) S.cache[k] = JSON.stringify(arr);
        parts.push(JSON.stringify(k) + ':' + S.cache[k]);
      });
      S.dirty = {};
      var extra = '';
      if (layoutCustom()) extra += ',"layout":' + JSON.stringify(S.layout);
      var im = usedImages(), ik = Object.keys(im).join(',');
      if (ik) {
        if (imgJson.key !== ik) imgJson = { key: ik, text: JSON.stringify(im) };
        extra += ',"images":' + imgJson.text;
      }
      var data = '{"version":1,"pdf":' + JSON.stringify(S.name) + extra + ',"pages":{' + parts.join(',') + '}}';
      localStorage.setItem(S.key, data);
      dbg('自動保存 ' + Math.round(performance.now() - t0) + 'ms（' + Math.round(data.length / 1024) + 'KB）');
      setStatus('自動保存しました');
    } catch (e) { setStatus('この端末への保存に失敗しました（容量がいっぱいの可能性があります）'); }
    if (quiet !== true && hooks.saved) hooks.saved(S.key);
  }
  function scheduleSave(page) {
    S.dirty[page || S.page] = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function wait() {
      if (drawing) { saveTimer = setTimeout(wait, 1500); return; }
      if (window.requestIdleCallback) requestIdleCallback(doSave, { timeout: 3000 }); else doSave();
    }, 3000);
  }
  function flushSave() { if (saveTimer) { clearTimeout(saveTimer); doSave(); } }
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushSave(); });
  function loadSaved() {
    applyData({ pages: {}, layout: null, images: {} });
    try {
      var raw = localStorage.getItem(S.key);
      if (raw) {
        var res = parseData(JSON.parse(raw));
        if (res) { applyData(res); setStatus('保存済みの手書きを復元しました'); return; }
      }
    } catch (e) {}
    setStatus('手書きは自動保存されます');
  }

  /* ---------- ファイルを開く ---------- */
  function openDoc(doc, name, key) {
    flushSave(); // 前のファイルの未保存分を、切り替える前に保存する
    S.pdf = doc; S.hasFile = true; S.name = name; S.key = key;
    S.page = 1; S.zoom = 1; S.live = null;
    loadSaved();
    $('hint').style.display = 'none'; wrap.style.display = 'block';
    $('pager').hidden = false;
    document.body.classList.add('has-file');
    stage.scrollTo(0, 0);
    renderPage();
    emit('open');
    emit('page');
    if (hooks.opened) hooks.opened(key, name);
  }

  /* ---------- 操作 ---------- */
  function goPage(n) {
    n = Math.min(S.total, Math.max(1, n));
    if (n === S.page && S.hasFile) { drawInk(); updateUI(); return; }
    S.page = n; S.live = null; stage.scrollTo(0, 0); renderPage();
    flashPager();
    emit('page');
  }
  $('prev').onclick = function () { goPage(S.page - 1); };
  $('next').onclick = function () { goPage(S.page + 1); };
  function setZoom(z) {
    S.zoom = Math.min(MAXZOOM, Math.max(0.5, Math.round(z * 100) / 100));
    flashPager(Math.round(S.zoom * 100) + '%');
    renderPage();
  }

  function pushUndo(page) {
    page = page || S.page;
    S.undo.push({ page: page, strokes: (S.strokes[page] || []).slice() });
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  // 手書きを変えたあとの共通処理（描き直し・ボタンの状態・保存）
  function commit(page) { drawInk(); updateUI(); scheduleSave(page); emit('data'); }
  function applySnapshot(from, to) {
    var a = from.pop(); if (!a) return;
    emit('beforeUndo');
    to.push({ page: a.page, strokes: (S.strokes[a.page] || []).slice() });
    S.strokes[a.page] = a.strokes;
    scheduleSave(a.page);
    emit('data');
    if (a.page !== S.page) { goPage(a.page); } else { drawInk(); updateUI(); }
  }
  $('undo').onclick = function () { applySnapshot(S.undo, S.redo); };
  $('redo').onclick = function () { applySnapshot(S.redo, S.undo); };
  $('clearPage').onclick = function () {
    if (!S.hasFile || !pages().length) return;
    pushUndo(); S.strokes[S.page] = []; commit();
    setStatus('このページを消去しました（元に戻すボタンで戻せます）');
  };

  /* ページを今のページの次に追加する。kind: 'same'（同じページ）/ 'blank'（白紙） */
  function insertPage(kind) {
    if (!S.hasFile) return;
    flushSave();
    var cur = entry();
    var e = kind === 'blank' || !(cur.src > 0)
      ? { src: 0, w: Math.round(S.pageSize.w), h: Math.round(S.pageSize.h), added: true }
      : { src: cur.src, added: true };
    var at = S.page; // この番号の次に入る
    S.layout.splice(at, 0, e);
    var ns = {};
    Object.keys(S.strokes).forEach(function (k) { var n = +k; ns[n > at ? n + 1 : n] = S.strokes[k]; });
    S.strokes = ns; S.total = S.layout.length;
    S.undo = []; S.redo = []; S.cache = {}; // ページ番号がずれるので、取り消し履歴は消す
    scheduleSave(at + 1);
    emit('layout');
    goPage(at + 1);
    setStatus(kind === 'blank' ? '白紙のページを追加しました' : '同じページを追加しました');
  }
  /* 今のページを削除する（追加したページだけ） */
  function deletePage() {
    if (!S.hasFile) return;
    if (!entry().added) { setStatus('元のPDFのページは削除できません（追加したページだけ削除できます）'); return; }
    if (!window.confirm('このページ（' + S.page + 'ページ目）を削除しますか？\n書き込みも一緒に消えます。')) return;
    flushSave();
    var at = S.page;
    S.layout.splice(at - 1, 1);
    var ns = {};
    Object.keys(S.strokes).forEach(function (k) { var n = +k; if (n !== at) ns[n > at ? n - 1 : n] = S.strokes[k]; });
    S.strokes = ns; S.total = S.layout.length;
    S.undo = []; S.redo = []; S.cache = {};
    scheduleSave(1);
    emit('layout');
    S.page = 0; goPage(Math.min(at, S.total));
    setStatus('ページを削除しました');
  }

  /* 画像を今のページの、見えている場所の真ん中に貼る。貼った画像を返す */
  function addImage(dataUrl, natW, natH) {
    if (!S.hasFile) return null;
    var id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    S.images[id] = dataUrl;
    var rc = wrap.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    var vx0 = Math.max(rc.left, sr.left), vx1 = Math.min(rc.right, sr.right);
    var vy0 = Math.max(rc.top, sr.top), vy1 = Math.min(rc.bottom, sr.bottom);
    var cx = ((vx0 + vx1) / 2 - rc.left) / rc.width, cy = ((vy0 + vy1) / 2 - rc.top) / rc.height;
    var wpx = Math.min(S.cssW * 0.5, (vx1 - vx0) * 0.7), hpx = wpx * natH / natW;
    var maxH = Math.min(S.cssH * 0.6, (vy1 - vy0) * 0.7);
    if (hpx > maxH) { wpx *= maxH / hpx; hpx = maxH; }
    var it = { tool: 'image', id: id, x: r4(cx - wpx / 2 / S.cssW), y: r4(cy - hpx / 2 / S.cssH), w: r4(wpx / S.cssW), h: r4(hpx / S.cssH) };
    pushUndo();
    (S.strokes[S.page] = S.strokes[S.page] || []).push(it);
    commit();
    return it;
  }

  function setTool(t) { S.tool = t; if (S.live) S.live = null; emit('tool', t); }

  /* ---------- 手書き ---------- */
  var drawing = null, pan = null, erased = false;
  var touches = {}, pinch = null, lastPenUp = 0, rafId = 0, drawnIdx = 0;

  function tMetrics() {
    var ids = Object.keys(touches), a = touches[ids[0]], b = touches[ids[1]];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
  function startPinch() {
    var m = tMetrics(), rc = wrap.getBoundingClientRect();
    pinch = { d0: m.d, cx0: m.cx, cy0: m.cy, cx: m.cx, cy: m.cy, z0: S.zoom, s: 1,
      fx: (m.cx - rc.left) / rc.width, fy: (m.cy - rc.top) / rc.height };
    wrap.style.transformOrigin = (pinch.fx * 100) + '% ' + (pinch.fy * 100) + '%';
  }
  function movePinch() {
    var m = tMetrics();
    var z = Math.min(MAXZOOM, Math.max(0.5, pinch.z0 * m.d / pinch.d0));
    pinch.s = z / pinch.z0; pinch.cx = m.cx; pinch.cy = m.cy;
    flashPager(Math.round(z * 100) + '%');
    wrap.style.transform = 'translate(' + (m.cx - pinch.cx0) + 'px,' + (m.cy - pinch.cy0) + 'px) scale(' + pinch.s + ')';
  }
  function clearPinchStyle() { wrap.style.transform = ''; wrap.style.transformOrigin = ''; }
  function cancelPinch() { pinch = null; clearPinchStyle(); }
  function endPinch() {
    var p = pinch; cancelPinch();
    var nz = Math.round(p.z0 * p.s * 100) / 100;
    dbg('ピンチ終了 ' + Math.round(S.zoom * 100) + '% → ' + Math.round(nz * 100) + '%');
    if (Math.abs(nz - S.zoom) < 0.01) return;
    S.anchor = { fx: p.fx, fy: p.fy, cx: p.cx, cy: p.cy };
    S.zoom = nz; renderPage();
  }

  function pos(e) {
    var rc = S.rc;
    var pr = e.pressure > 0 ? e.pressure : 0.5;
    return [r4((e.clientX - rc.left) / rc.width), r4((e.clientY - rc.top) / rc.height), Math.round(pr * 100) / 100];
  }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hit(s, px, py, r) {
    if (s.tool === 'image') return false; // 画像は消しゴムでは消えない（投げ縄で削除）
    var p = s.points, W = S.cssW, H = S.cssH;
    if (s.tool === 'highlighter') r += hlWidth(s, W) / 2;
    if (p.length === 1) return Math.hypot(px - p[0][0] * W, py - p[0][1] * H) < r;
    for (var i = 1; i < p.length; i++)
      if (segDist(px, py, p[i - 1][0] * W, p[i - 1][1] * H, p[i][0] * W, p[i][1] * H) < r) return true;
    return false;
  }
  function eraseAt(pt) {
    var arr = pages(), px = pt[0] * S.cssW, py = pt[1] * S.cssH;
    var keep = arr.filter(function (s) { return !hit(s, px, py, S.eraser); });
    if (keep.length !== arr.length) {
      if (!erased) { pushUndo(); erased = true; }
      S.strokes[S.page] = keep; drawInk(); updateUI(); scheduleSave();
    }
  }
  // 蛍光ペンはまっすぐな線にする。ほぼ水平なら水平にそろえる
  function straight(a, b) {
    var dx = (b[0] - a[0]) * S.cssW, dy = (b[1] - a[1]) * S.cssH;
    if (Math.abs(dy) < Math.abs(dx) * 0.12) b = [b[0], a[1], b[2]];
    return [[a[0], a[1], 0.5], [b[0], b[1], 0.5]];
  }
  function drawLive(from) {
    var s = S.live;
    if (s.tool === 'pen') segs(ictx, s, ink.width, ink.height, from);
    else if (s.tool === 'pencil') segs(lctx, s, lc.width, lc.height, from);
    else { lctx.clearRect(0, 0, lc.width, lc.height); hlPath(lctx, s, lc.width, lc.height); }
  }
  function flushDraw() {
    rafId = 0;
    var s = S.live; if (!s || (s.points.length <= drawnIdx && s.tool !== 'highlighter')) return;
    drawLive(drawnIdx);
    drawnIdx = s.points.length;
  }
  function liveLayer(tool) {
    lctx.clearRect(0, 0, lc.width, lc.height);
    lc.style.opacity = tool === 'highlighter' ? '0.35' : tool === 'pencil' ? '0.92' : '1';
    var m = tool === 'pencil' ? 'url(' + noise().toDataURL() + ')' : '';
    lc.style.webkitMaskImage = m; lc.style.maskImage = m;
  }

  /* 指1本を離したとき: 左右に払った → ページをめくる / 2回タップ → 拡大・元に戻す */
  var lastTap = null;
  function fingerUp(p, e) {
    var dx = e.clientX - p.x0, dy = e.clientY - p.y0, dt = performance.now() - p.t0;
    if (dt < 500 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && p.atR && S.page < S.total) goPage(S.page + 1);
      else if (dx > 0 && p.atL && S.page > 1) goPage(S.page - 1);
      else if (dx < 0 ? p.atR : p.atL) flashPager(); // 最初・最後のページ
      lastTap = null;
      return;
    }
    if (dt < 300 && Math.hypot(dx, dy) < 12) {
      var now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = null;
        var rc = wrap.getBoundingClientRect();
        S.anchor = { fx: (e.clientX - rc.left) / rc.width, fy: (e.clientY - rc.top) / rc.height, cx: e.clientX, cy: e.clientY };
        setZoom(Math.abs(S.zoom - 1) < 0.01 ? 2 : 1);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    } else lastTap = null;
  }

  ink.addEventListener('pointerdown', function (e) {
    if (!S.hasFile) return;
    e.preventDefault();
    // 指はスクロール・ページめくり・拡大縮小に使う（書くのはペンだけ）
    if (e.pointerType === 'touch') {
      if (drawing || performance.now() - lastPenUp < 500) { // 手のひらの接触は無視
        dbg('指#' + e.pointerId + ' 無視（' + (drawing ? 'ペンで書いている最中' : 'ペンを離した直後') + '）');
        return;
      }
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      ink.setPointerCapture(e.pointerId);
      var n = Object.keys(touches).length;
      dbg('指#' + e.pointerId + ' 接触 → ' + (n === 1 ? 'スクロール扱い' : n === 2 ? 'ピンチ扱い' : n + '本目'));
      if (n === 1) {
        pan = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(),
          // 払う前に、横スクロールが端まで来ていたか（端なら、払うとページをめくる）
          atL: stage.scrollLeft <= 1, atR: stage.scrollLeft >= stage.scrollWidth - stage.clientWidth - 1 };
      }
      else if (n === 2) { pan = null; startPinch(); }
      return;
    }
    if (drawing) { dbg('!! ペン#' + e.pointerId + ' 無視（前の線#' + drawing.id + 'が終わっていない）'); return; }
    dbg('ペン#' + e.pointerId + '(' + e.pointerType + ') 書き始め' + (Object.keys(touches).length ? '（指' + Object.keys(touches).length + '本を解除）' : ''));
    pan = null; touches = {}; if (pinch) cancelPinch();
    ink.setPointerCapture(e.pointerId);
    S.rc = ink.getBoundingClientRect(); // 書き始めに1回だけ取得
    var pt = pos(e);
    var h = tools[S.tool];
    if (h) { drawing = { id: e.pointerId, h: h }; h.down(pt, e); return; }
    if (S.tool === 'eraser') { drawing = { id: e.pointerId, erase: true }; erased = false; eraseAt(pt); return; }
    if (!PENS[S.tool]) return;
    S.live = { tool: S.tool, color: S.color, width: S.width, points: [pt] };
    drawing = { id: e.pointerId, start: pt };
    drawnIdx = 1;
    if (S.tool !== 'pen') liveLayer(S.tool);
    drawLive(0);
  });
  ink.addEventListener('pointermove', function (e) {
    if (touches[e.pointerId]) {
      touches[e.pointerId].x = e.clientX; touches[e.pointerId].y = e.clientY;
      if (pinch && Object.keys(touches).length === 2) { movePinch(); return; }
    }
    if (pan && e.pointerId === pan.id) {
      stage.scrollLeft -= e.clientX - pan.x; stage.scrollTop -= e.clientY - pan.y;
      pan.x = e.clientX; pan.y = e.clientY; return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    if (drawing.h) { evs.forEach(function (ev) { drawing.h.move(pos(ev), ev); }); return; }
    if (drawing.erase) { evs.forEach(function (ev) { eraseAt(pos(ev)); }); return; }
    var s = S.live;
    if (s.tool === 'highlighter') {
      s.points = straight(drawing.start, pos(evs[evs.length - 1]));
      if (!rafId) rafId = requestAnimationFrame(flushDraw);
      return;
    }
    evs.forEach(function (ev) {
      var pt = pos(ev), last = s.points[s.points.length - 1];
      if (Math.hypot((pt[0] - last[0]) * S.cssW, (pt[1] - last[1]) * S.cssH) > 0.6) s.points.push(pt);
    });
    if (s.points.length > drawnIdx && !rafId) rafId = requestAnimationFrame(flushDraw);
  });
  function endPointer(e) {
    if (touches[e.pointerId]) {
      dbg('指#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '取り消し' : '離す'));
      delete touches[e.pointerId];
      if (pinch) endPinch();
      if (pan && pan.id === e.pointerId) { if (e.type === 'pointerup') fingerUp(pan, e); pan = null; }
      return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    dbg('ペン#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '!! 取り消し（OSに中断された）' : '離す') +
      (S.live ? '（' + S.live.points.length + '点）' : ''));
    if (drawing.h) {
      var h = drawing.h; drawing = null; lastPenUp = performance.now();
      h.up(e);
      return;
    }
    if (!drawing.erase && S.live) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flushDraw();
      var s = S.live;
      // 図形モード: 手書きの丸・四角・三角・直線を、きれいな図形に直す
      if (S.shape && s.tool !== 'highlighter' && window.Shapes) {
        var fixed = Shapes.recognize(s.points, S.cssW, S.cssH);
        if (fixed) s.points = fixed;
      }
      pushUndo();
      (S.strokes[S.page] = S.strokes[S.page] || []).push(s);
      S.live = null;
      if (s.tool !== 'pen') { lctx.clearRect(0, 0, lc.width, lc.height); liveLayer('pen'); }
      if (s.tool === 'pen' && !fixed) drawItem(ictx, s, ink.width, ink.height);
      else drawInk();
      updateUI(); scheduleSave(); emit('data');
    }
    drawing = null;
    lastPenUp = performance.now();
  }
  ink.addEventListener('pointerup', endPointer);
  ink.addEventListener('pointercancel', endPointer);
  ink.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // iPadのスクリブル等がペン入力を横取りしないように、手書き面での標準タッチ動作を止める。
  // touchmove だけで止める。touchstart/touchend でも止めると、スクリブルとぶつかって
  // 数秒〜長時間ペンが効かなくなった（2026-11-03 iPadで確認。ユーザー了承のうえ外した）。
  // スクロール・拡大・文字選択・長押しメニューは CSS（touch-action / user-select / touch-callout）で防いでいる
  ink.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  // 紙のまわりの余白でも同じ（ボタンが並ぶ上部 header には付けない）
  stage.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  if (DEBUG) {
    // OSから届いたタッチの種類（stylus=ペン, direct=指）。preventDefault の処理とは別に記録だけする
    ink.addEventListener('touchstart', function (e) {
      var types = Array.prototype.map.call(e.changedTouches, function (t) { return t.touchType || '?'; });
      dbg('touchstart ' + types.join(',') + '（画面上の接触 計' + e.touches.length + '）' + (e.cancelable ? '' : ' !! 止められない'));
    }, { passive: true });
  }

  /* ---------- JSONダイアログ ---------- */
  function openJson() {
    if (!S.hasFile) { setStatus('先にPDFを開いてください'); return; }
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブルが反応しにくくなるように）
    var ta = document.createElement('textarea');
    ta.id = 'json'; ta.spellcheck = false;
    ta.value = JSON.stringify(exportData());
    $('jsonSlot').appendChild(ta);
    $('dlgMsg').textContent = '';
    $('dlg').classList.add('open');
  }
  $('closeDlg').onclick = function () {
    $('dlg').classList.remove('open');
    $('jsonSlot').textContent = '';
  };
  $('copyJson').onclick = function () {
    var ta = $('json'); ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(ta.value).then(
        function () { $('dlgMsg').textContent = 'コピーしました'; },
        function () { $('dlgMsg').textContent = '自動コピーできませんでした。選択された文字列を長押ししてコピーしてください'; });
      return;
    }
    $('dlgMsg').textContent = ok ? 'コピーしました' : '自動コピーできませんでした。選択された文字列を長押ししてコピーしてください';
  };
  $('importJson').onclick = function () {
    try {
      var res = parseData(JSON.parse($('json').value));
      if (!res) throw new Error('bad');
      applyData(res);
      renderPage(); updateUI(); scheduleSave(); emit('layout'); emit('data');
      $('dlgMsg').textContent = '読み込みました';
    } catch (e) { $('dlgMsg').textContent = '読み込めませんでした。JSONの形式を確認してください'; }
  };

  /* ---------- 画面サイズ変更 ---------- */
  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (S.hasFile && stage.clientWidth !== lastStageW) renderPage(); }, 200);
  });
  updateUI();

  /* Drive連携・道具・ページ一覧など、ほかのファイルから使う入口 */
  window.App = {
    S: S, on: on, emit: emit, tools: tools,
    openDoc: openDoc, setStatus: setStatus, dbg: dbg, hooks: hooks,
    drawInk: drawInk, drawList: drawList, renderPage: renderPage, renderThumb: renderThumb,
    goPage: goPage, updateUI: updateUI, pushUndo: pushUndo, commit: commit,
    scheduleSave: scheduleSave, flushSave: flushSave, exportData: exportData,
    setTool: setTool, insertPage: insertPage, deletePage: deletePage, addImage: addImage,
    pageEntry: entry, openJson: openJson, liveCtx: lctx, liveCanvas: lc, wrap: wrap, stage: stage,
    blank: function () { openDoc(null, '白紙', 'strokes:__blank__'); },
    currentKey: function () { return S.hasFile ? S.key : ''; },
    hasStrokes: function () { for (var k in S.strokes) if (S.strokes[k].length) return true; return false; },
    exportJson: function () { return JSON.stringify(exportData()); },
    // 外から受け取った手書きデータで置き換える（取り消し履歴は消える）
    replaceData: function (obj) {
      var res = parseData(obj); if (!res) return false;
      if (drawing) return false;
      applyData(res);
      clearTimeout(saveTimer); saveTimer = null;
      renderPage(); updateUI(); doSave(true); emit('layout'); emit('data');
      return true;
    }
  };
})();
