(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), wrap = $('wrap'), pdfC = $('pdfc'), ink = $('ink'), lc = $('livec');
  var pctx = pdfC.getContext('2d'), ictx = ink.getContext('2d'), lctx = lc.getContext('2d');
  var tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  var MAXZOOM = 2.5;

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  var S = {
    pdf: null, hasFile: false, name: '', key: '',
    page: 1, total: 1, zoom: 1,
    tool: 'pen', color: '#e53935', width: 4, finger: false,
    strokes: {}, undo: [], redo: [], cache: {}, dirty: {},
    cssW: 0, cssH: 0, live: null, rc: null, anchor: null
  };
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
  function setStatus(t) { setText($('status'), t); }
  function r4(n) { return Math.round(n * 10000) / 10000; }
  function pages() { return S.strokes[S.page] || []; }

  /* ---------- 描画 ---------- */
  function penSegments(s, from) {
    var p = s.points, W = ink.width;
    var base = s.width * (W / 1000), H = ink.height;
    ictx.lineCap = 'round'; ictx.lineJoin = 'round';
    ictx.strokeStyle = s.color; ictx.fillStyle = s.color;
    if (p.length === 1) {
      ictx.beginPath();
      ictx.arc(p[0][0] * W, p[0][1] * H, base * (0.6 + 0.8 * p[0][2]) / 2, 0, Math.PI * 2);
      ictx.fill();
      return;
    }
    for (var j = Math.max(1, from || 1); j < p.length; j++) {
      ictx.lineWidth = base * (0.6 + 0.8 * ((p[j][2] + p[j - 1][2]) / 2));
      ictx.beginPath();
      ictx.moveTo(p[j - 1][0] * W, p[j - 1][1] * H);
      ictx.lineTo(p[j][0] * W, p[j][1] * H);
      ictx.stroke();
    }
  }
  /* 蛍光ペン（確定済み）: 不透明で1本描いてから、一定の透明度で重ねる */
  function highlightFinal(s) {
    var p = s.points, W = ink.width, H = ink.height, w = s.width * (W / 1000) * 5;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, i;
    for (i = 0; i < p.length; i++) {
      var x = p[i][0] * W, y = p[i][1] * H;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    var pad = w / 2 + 2;
    var bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
    var bw = Math.min(W, Math.ceil(x1 + pad)) - bx, bh = Math.min(H, Math.ceil(y1 + pad)) - by;
    if (bw <= 0 || bh <= 0) return;
    tctx.clearRect(bx, by, bw, bh);
    tctx.lineCap = 'round'; tctx.lineJoin = 'round';
    tctx.lineWidth = w; tctx.strokeStyle = s.color;
    tctx.beginPath(); tctx.moveTo(p[0][0] * W, p[0][1] * H);
    for (i = 1; i < p.length; i++) tctx.lineTo(p[i][0] * W, p[i][1] * H);
    if (p.length === 1) tctx.lineTo(p[0][0] * W + 0.01, p[0][1] * H);
    tctx.stroke();
    ictx.save(); ictx.globalAlpha = 0.35;
    ictx.drawImage(tmp, bx, by, bw, bh, bx, by, bw, bh);
    ictx.restore();
  }
  /* 蛍光ペン（書いている最中）: 専用レイヤーに不透明で描き、レイヤー全体を半透明にする */
  function highlightLive(s, from) {
    var p = s.points, W = lc.width, H = lc.height, w = s.width * (W / 1000) * 5;
    lctx.lineCap = 'round'; lctx.lineJoin = 'round';
    lctx.lineWidth = w; lctx.strokeStyle = s.color;
    if (p.length === 1) {
      lctx.beginPath(); lctx.moveTo(p[0][0] * W, p[0][1] * H); lctx.lineTo(p[0][0] * W + 0.01, p[0][1] * H); lctx.stroke();
      return;
    }
    for (var i = Math.max(1, from || 1); i < p.length; i++) {
      lctx.beginPath();
      lctx.moveTo(p[i - 1][0] * W, p[i - 1][1] * H);
      lctx.lineTo(p[i][0] * W, p[i][1] * H);
      lctx.stroke();
    }
  }
  function drawStroke(s, from) {
    if (!s.points || !s.points.length) return;
    if (s.tool === 'highlighter') highlightFinal(s); else penSegments(s, from);
  }
  function drawInk() {
    ictx.clearRect(0, 0, ink.width, ink.height);
    var arr = pages();
    for (var i = 0; i < arr.length; i++) drawStroke(arr[i]);
    if (S.live && S.live.tool !== 'highlighter') penSegments(S.live, 1);
  }

  async function renderPage() {
    if (!S.hasFile) return;
    var t0 = performance.now();
    var token = ++renderToken;
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }
    var page = null, bw = 1, bh = 1.414;
    if (S.pdf) {
      page = await S.pdf.getPage(S.page);
      var b = page.getViewport({ scale: 1 }); bw = b.width; bh = b.height;
    }
    if (token !== renderToken) return;
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

  function updateUI() {
    setText($('pageLabel'), S.hasFile ? (S.page + ' / ' + S.total) : '- / -');
    setText($('zoomLabel'), Math.round(S.zoom * 100) + '%');
    setDis($('prev'), !S.hasFile || S.page <= 1);
    setDis($('next'), !S.hasFile || S.page >= S.total);
    setDis($('undo'), !S.undo.length);
    setDis($('redo'), !S.redo.length);
  }

  /* ---------- 保存・復元 ---------- */
  function exportData() {
    var out = {};
    for (var k in S.strokes) if (S.strokes[k].length) out[k] = S.strokes[k];
    return { version: 1, pdf: S.name, pages: out };
  }
  function sanitize(d) {
    if (!d || typeof d !== 'object' || !d.pages || typeof d.pages !== 'object') return null;
    var res = {};
    Object.keys(d.pages).forEach(function (k) {
      var arr = d.pages[k]; if (!Array.isArray(arr)) return;
      var list = [];
      arr.forEach(function (s) {
        if (!s || !Array.isArray(s.points) || !s.points.length) return;
        var pts = [];
        s.points.forEach(function (q) {
          if (Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]))
            pts.push([+q[0], +q[1], isFinite(q[2]) ? +q[2] : 0.5]);
        });
        if (!pts.length) return;
        list.push({
          tool: s.tool === 'highlighter' ? 'highlighter' : 'pen',
          color: /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#1b2430',
          width: Math.min(40, Math.max(0.5, +s.width || 4)),
          points: pts
        });
      });
      if (list.length) res[k] = list;
    });
    return res;
  }
  function doSave() {
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
      var data = '{"version":1,"pdf":' + JSON.stringify(S.name) + ',"pages":{' + parts.join(',') + '}}';
      localStorage.setItem(S.key, data);
      dbg('自動保存 ' + Math.round(performance.now() - t0) + 'ms（' + Math.round(data.length / 1024) + 'KB）');
      setStatus('自動保存しました');
    } catch (e) { setStatus('この端末への保存に失敗しました（手書きデータからコピーしてください）'); }
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
    S.strokes = {};
    try {
      var raw = localStorage.getItem(S.key);
      if (raw) {
        var res = sanitize(JSON.parse(raw));
        if (res) { S.strokes = res; setStatus('保存済みの手書きを復元しました'); return; }
      }
    } catch (e) {}
    setStatus('手書きは自動保存されます');
  }

  /* ---------- ファイルを開く ---------- */
  function openDoc(doc, name, key) {
    S.pdf = doc; S.hasFile = true; S.name = name; S.key = key;
    S.total = doc ? doc.numPages : 1; S.page = 1; S.zoom = 1;
    S.undo = []; S.redo = []; S.live = null; S.cache = {}; S.dirty = {};
    loadSaved();
    $('hint').style.display = 'none'; wrap.style.display = 'block';
    stage.scrollTo(0, 0);
    renderPage();
  }
  $('file').addEventListener('change', async function (e) {
    var f = e.target.files[0]; if (!f) return;
    try {
      setStatus('読み込み中…');
      var buf = await f.arrayBuffer();
      var doc = await pdfjsLib.getDocument({ data: buf }).promise;
      openDoc(doc, f.name, 'strokes:' + f.name + ':' + f.size);
    } catch (err) { setStatus('PDFを開けませんでした'); console.error(err); }
    e.target.value = '';
  });
  $('blankBtn').addEventListener('click', function () { openDoc(null, '白紙', 'strokes:__blank__'); });

  /* ---------- 操作 ---------- */
  function goPage(n) {
    n = Math.min(S.total, Math.max(1, n));
    if (n === S.page && S.hasFile) { drawInk(); updateUI(); return; }
    S.page = n; S.live = null; stage.scrollTo(0, 0); renderPage();
  }
  $('prev').onclick = function () { goPage(S.page - 1); };
  $('next').onclick = function () { goPage(S.page + 1); };
  function setZoom(z) { S.zoom = Math.min(MAXZOOM, Math.max(0.5, Math.round(z * 100) / 100)); renderPage(); }
  $('zoomIn').onclick = function () { setZoom(S.zoom + 0.25); };
  $('zoomOut').onclick = function () { setZoom(S.zoom - 0.25); };

  document.querySelectorAll('[data-tool]').forEach(function (b) {
    b.onclick = function () {
      S.tool = b.dataset.tool;
      document.querySelectorAll('[data-tool]').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
  });
  document.querySelectorAll('[data-color]').forEach(function (b) {
    b.onclick = function () {
      S.color = b.dataset.color;
      document.querySelectorAll('[data-color]').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
  });
  document.querySelectorAll('[data-width]').forEach(function (b) {
    b.onclick = function () {
      S.width = +b.dataset.width;
      document.querySelectorAll('[data-width]').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
  });
  $('finger').onchange = function () { S.finger = this.checked; };

  function pushUndo() {
    S.undo.push({ page: S.page, strokes: pages().slice() });
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  function applySnapshot(from, to) {
    var a = from.pop(); if (!a) return;
    to.push({ page: a.page, strokes: (S.strokes[a.page] || []).slice() });
    S.strokes[a.page] = a.strokes;
    scheduleSave(a.page);
    if (a.page !== S.page) { S.page = a.page; renderPage(); } else { drawInk(); updateUI(); }
  }
  $('undo').onclick = function () { applySnapshot(S.undo, S.redo); };
  $('redo').onclick = function () { applySnapshot(S.redo, S.undo); };
  $('clearPage').onclick = function () {
    if (!S.hasFile || !pages().length) return;
    pushUndo(); S.strokes[S.page] = []; drawInk(); updateUI(); scheduleSave();
    setStatus('このページを消去しました（↶で戻せます）');
  };

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
    var p = s.points, W = S.cssW, H = S.cssH;
    if (p.length === 1) return Math.hypot(px - p[0][0] * W, py - p[0][1] * H) < r;
    for (var i = 1; i < p.length; i++)
      if (segDist(px, py, p[i - 1][0] * W, p[i - 1][1] * H, p[i][0] * W, p[i][1] * H) < r) return true;
    return false;
  }
  function eraseAt(pt) {
    var arr = pages(), px = pt[0] * S.cssW, py = pt[1] * S.cssH;
    var keep = arr.filter(function (s) { return !hit(s, px, py, 14); });
    if (keep.length !== arr.length) {
      if (!erased) { pushUndo(); erased = true; }
      S.strokes[S.page] = keep; drawInk(); updateUI(); scheduleSave();
    }
  }
  function flushDraw() {
    rafId = 0;
    var s = S.live; if (!s || s.points.length <= drawnIdx) return;
    if (s.tool === 'highlighter') highlightLive(s, drawnIdx); else penSegments(s, drawnIdx);
    drawnIdx = s.points.length;
  }

  ink.addEventListener('pointerdown', function (e) {
    if (!S.hasFile) return;
    e.preventDefault();
    if (e.pointerType === 'touch' && !S.finger) {
      if (drawing || performance.now() - lastPenUp < 500) { // 手のひらの接触は無視
        dbg('指#' + e.pointerId + ' 無視（' + (drawing ? 'ペンで書いている最中' : 'ペンを離した直後') + '）');
        return;
      }
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      ink.setPointerCapture(e.pointerId);
      var n = Object.keys(touches).length;
      dbg('指#' + e.pointerId + ' 接触 → ' + (n === 1 ? 'スクロール扱い' : n === 2 ? 'ピンチ扱い' : n + '本目'));
      if (n === 1) { pan = { id: e.pointerId, x: e.clientX, y: e.clientY }; }
      else if (n === 2) { pan = null; startPinch(); }
      return;
    }
    if (drawing) { dbg('!! ペン#' + e.pointerId + ' 無視（前の線#' + drawing.id + 'が終わっていない）'); return; }
    dbg('ペン#' + e.pointerId + '(' + e.pointerType + ') 書き始め' + (Object.keys(touches).length ? '（指' + Object.keys(touches).length + '本を解除）' : ''));
    pan = null; touches = {}; if (pinch) cancelPinch();
    ink.setPointerCapture(e.pointerId);
    S.rc = ink.getBoundingClientRect(); // 書き始めに1回だけ取得
    var pt = pos(e);
    if (S.tool === 'eraser') { drawing = { id: e.pointerId, erase: true }; erased = false; eraseAt(pt); return; }
    S.live = { tool: S.tool, color: S.color, width: S.width, points: [pt] };
    drawing = { id: e.pointerId };
    drawnIdx = 1;
    if (S.tool === 'highlighter') { lc.style.opacity = '0.35'; highlightLive(S.live, 0); }
    else penSegments(S.live, 0);
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
    if (drawing.erase) { evs.forEach(function (ev) { eraseAt(pos(ev)); }); return; }
    var s = S.live;
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
      if (pan && pan.id === e.pointerId) pan = null;
      return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    dbg('ペン#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '!! 取り消し（OSに中断された）' : '離す') +
      (S.live ? '（' + S.live.points.length + '点）' : ''));
    if (!drawing.erase && S.live) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flushDraw();
      var s = S.live;
      pushUndo();
      (S.strokes[S.page] = S.strokes[S.page] || []).push(s);
      if (s.tool === 'highlighter') { highlightFinal(s); lctx.clearRect(0, 0, lc.width, lc.height); }
      S.live = null; updateUI(); scheduleSave();
    }
    drawing = null;
    lastPenUp = performance.now();
  }
  ink.addEventListener('pointerup', endPointer);
  ink.addEventListener('pointercancel', endPointer);
  ink.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // iPadのスクリブル等がペン入力を横取りしないように、手書き面での標準タッチ動作を止める
  ['touchstart', 'touchmove', 'touchend'].forEach(function (t) {
    ink.addEventListener(t, function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  });
  // スクリブル対策（追加）: 紙のまわりの余白など、表示エリア全体でも標準タッチ動作を止める。
  // ボタンが並ぶ上部（header）には付けない（タップが効かなくなるため）
  ['touchstart', 'touchmove', 'touchend'].forEach(function (t) {
    stage.addEventListener(t, function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  });
  if (DEBUG) {
    // OSから届いたタッチの種類（stylus=ペン, direct=指）。preventDefault の処理とは別に記録だけする
    ink.addEventListener('touchstart', function (e) {
      var types = Array.prototype.map.call(e.changedTouches, function (t) { return t.touchType || '?'; });
      dbg('touchstart ' + types.join(',') + '（画面上の接触 計' + e.touches.length + '）' + (e.cancelable ? '' : ' !! 止められない'));
    }, { passive: true });
  }

  /* ---------- JSONダイアログ ---------- */
  $('jsonBtn').onclick = function () {
    if (!S.hasFile) { setStatus('先にPDFを開いてください'); return; }
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブルが反応しにくくなるように）
    var ta = document.createElement('textarea');
    ta.id = 'json'; ta.spellcheck = false;
    ta.value = JSON.stringify(exportData());
    $('jsonSlot').appendChild(ta);
    $('dlgMsg').textContent = '';
    $('dlg').classList.add('open');
  };
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
      var res = sanitize(JSON.parse($('json').value));
      if (!res) throw new Error('bad');
      S.strokes = res; S.undo = []; S.redo = []; S.cache = {};
      drawInk(); updateUI(); scheduleSave();
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

  /* Drive連携など、ほかのファイルから使う入口 */
  window.App = { openDoc: openDoc, setStatus: setStatus };
})();
