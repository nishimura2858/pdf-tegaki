/* 読書ノートの中心部分: ページの表示（見開き・めくり・拡大）、ペンとマーカー、保存
   手書きノート（pdf-tegaki の js/app.js）を土台にして、読書用に直したもの。表示とめくりの動きは同じ
   - 道具のボタン類は toolbar.js、ページ一覧・検索は pages.js、付箋は notes.js、スクラップブックは scrap.js、本棚は library.js
   - 書き込みデータ: { version, pdf, layout?, notes?, pages: { "ページ番号": [線, …] } }
     - 線: { tool: pen|highlighter, color, width, points: [[x, y, 筆圧], …] }（x, y はページに対する割合）
     - notes: 付箋 { "ページ番号": [{ id, x, y, color, text, at }, …] }
     - layout: ページの並び [{ src: 元のページ番号, rot }]。元の並びと違うとき（回転・並べ替え・削除）だけ保存する
   - 保存先は、この端末の IndexedDB（library.js の hooks.save）。手書きノートとは別の場所 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), wrap = $('wrap'), pdfC = $('pdfc'), ink = $('ink'), lc = $('livec');
  var pctx = pdfC.getContext('2d'), ictx = ink.getContext('2d'), lctx = lc.getContext('2d');
  var tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  var MAXZOOM = 8, PENS = { pen: 1, pencil: 1, highlighter: 1 };
  var A4 = { w: 595, h: 842 };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  var S = {
    pdf: null, hasFile: false, name: '', key: '', kind: 'book', // kind: 'book'（本）/ 'scrap'（スクラップブック）
    page: 1, total: 1, zoom: 1, layout: [], images: {}, notes: {}, pageSize: A4,
    tool: 'pen', color: '#e53935', width: 4, shape: false, eraser: 14,
    strokes: {}, undo: [], redo: [], cache: {}, dirty: {},
    cssW: 0, cssH: 0, live: null, rc: null, anchor: null, xform: null
  };
  // ほかのファイルとのつなぎ目
  // save: この端末に保存する / saved・opened: Drive同期への知らせ
  // drawNotes: 付箋を描く / noteAt: その場所にある付箋 / tap: 指で軽くたたいたとき（付箋を貼る・開く）
  // singleTap: 指で1回たたいた（2回たたく拡大ではないと分かってから）/ twoTap: 2本指でたたいた
  // hold: 指1本で長押しした（動かさずに約0.45秒）。つかむもの（move/up を持つ）を返すと、その指はそれを動かすのに使う
  var hooks = { save: null, saved: null, opened: null, drawNotes: null, noteAt: null, tap: null, singleTap: null, twoTap: null, hold: null };
  var tools = {};                            // 投げ縄・レーザーなど、別ファイルの道具
  var listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function emit(ev, a) { (listeners[ev] || []).forEach(function (fn) { try { fn(a); } catch (e) { console.error(e); } }); }
  var renderToken = 0, renderTask = null, saveTimer = null, lastStageW = 0, lastShown = '';

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
    setText($('pageLabel'), text || pageText());
    el.classList.add('show');
    clearTimeout(pagerTimer);
    pagerTimer = setTimeout(function () {
      pagerTimer = null;
      el.classList.remove('show');
      setText($('pageLabel'), pageText());
    }, 1400);
  }
  // 位置（ページに対する割合）を丸める。大きく拡大しても線の縁が揺れないよう、10万分の1まで残す（2026-11-16）
  function r4(n) { return Math.round(n * 100000) / 100000; }
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
    // ペンは筆圧で太さをほとんど変えない（ペンの圧の小さな揺れで、太さがムラになったため。2026-11-16）
    var base = s.width * W / 1000;
    return s.tool === 'pencil' ? base * (0.6 + 0.8 * p) : base * (0.85 + 0.3 * p);
  }
  /* ペン・えんぴつの線: 点ごとの丸と、となりの丸をつなぐ帯を1つの形にまとめて、一度で塗る
     （区切りごとに線を重ねて描くと、重なった所のふちが濃くなってギザギザに見えたため。2026-11-16）
     - 筆圧は前後の点と平均して、太さが急に変わらないように
     - 点の間が少し開いている所は、なめらかな曲線（Catmull-Rom）で点を補う（図形の辺のような長い区間はまっすぐ） */
  function cr(a, b, c, d, t) {
    var t2 = t * t, t3 = t2 * t;
    function f(i) { return 0.5 * (2 * b[i] + (c[i] - a[i]) * t + (2 * a[i] - 5 * b[i] + 4 * c[i] - d[i]) * t2 + (3 * b[i] - a[i] - 3 * c[i] + d[i]) * t3); }
    return [f(0), f(1), b[2] + (c[2] - b[2]) * t];
  }
  function band(ctx, a, b) { // 2つの丸の外側の接線でできる帯（丸と同じ向きに回る）
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    if (d < 1e-6 || d <= Math.abs(a[2] - b[2])) return;
    var ux = dx / d, uy = dy / d, nx = -uy, ny = ux, c = (a[2] - b[2]) / d, k = Math.sqrt(1 - c * c);
    var m1x = c * ux + k * nx, m1y = c * uy + k * ny, m2x = c * ux - k * nx, m2y = c * uy - k * ny;
    var q = [[a[0] + a[2] * m1x, a[1] + a[2] * m1y], [b[0] + b[2] * m1x, b[1] + b[2] * m1y],
             [b[0] + b[2] * m2x, b[1] + b[2] * m2y], [a[0] + a[2] * m2x, a[1] + a[2] * m2y]];
    var area = 0;
    for (var i = 0; i < 4; i++) { var u = q[i], v = q[(i + 1) % 4]; area += u[0] * v[1] - v[0] * u[1]; }
    if (area < 0) q.reverse();
    ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]); ctx.closePath();
  }
  function segs(ctx, s, W, H) {
    var p = s.points, n = p.length, i, P = [], Q, lim = W * 0.02;
    // 筆圧は前から・後ろからの両方でならす（太さがゆっくりしか変わらないように）
    var pr = [], f = p[0][2];
    for (i = 0; i < n; i++) { f += (p[i][2] - f) * 0.18; pr.push(f); }
    f = pr[n - 1];
    for (i = n - 1; i >= 0; i--) { f += (pr[i] - f) * 0.18; pr[i] = f; }
    // 手の細かいぶれをならす（となりの点が近いときだけ。図形の角はそのまま）。2回かける
    var X = [], Y = [];
    for (i = 0; i < n; i++) { X.push(p[i][0] * W); Y.push(p[i][1] * H); }
    for (var pass = 0; pass < 2; pass++) {
      var X2 = X.slice(), Y2 = Y.slice();
      for (i = 1; i < n - 1; i++) {
        if (Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]) < lim && Math.hypot(X[i] - X[i + 1], Y[i] - Y[i + 1]) < lim) {
          X2[i] = (X[i - 1] + 2 * X[i] + X[i + 1]) / 4; Y2[i] = (Y[i - 1] + 2 * Y[i] + Y[i + 1]) / 4;
        }
      }
      X = X2; Y = Y2;
    }
    for (i = 0; i < n; i++) P.push([X[i], Y[i], Math.max(0.35, widthAt(s, W, pr[i]) / 2)]);
    Q = [P[0]];
    for (i = 1; i < n; i++) {
      var a = P[i - 1], b = P[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.min(10, Math.floor(d / 2.5));
      // 長い区間（図形に直した線の辺など）は、まっすぐのまま（角が丸まらないように）
      if (k >= 1 && n > 2 && d < W * 0.02) {
        var a0 = P[Math.max(0, i - 2)], b1 = P[Math.min(n - 1, i + 1)];
        for (var j = 1; j <= k; j++) Q.push(cr(a0, a, b, b1, j / (k + 1)));
      }
      Q.push(b);
    }
    ctx.fillStyle = s.color;
    ctx.beginPath();
    for (i = 0; i < Q.length; i++) {
      var q = Q[i];
      ctx.moveTo(q[0] + q[2], q[1]); ctx.arc(q[0], q[1], q[2], 0, Math.PI * 2);
      if (i) band(ctx, Q[i - 1], q);
    }
    ctx.fill('nonzero');
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
    // 見えている所だけの紙（拡大中のきれいな層・書いている最中の層）は、ずらして描いてある
    var tf = ctx.getTransform ? ctx.getTransform() : null, ox = tf ? -tf.e : 0, oy = tf ? -tf.f : 0;
    var cw = ctx.canvas.width, ch = ctx.canvas.height;
    if (tmp.width < cw || tmp.height < ch) { tmp.width = Math.max(tmp.width, cw); tmp.height = Math.max(tmp.height, ch); }
    var bx = Math.max(ox, Math.floor(x0 - pad)), by = Math.max(oy, Math.floor(y0 - pad));
    var bw = Math.min(ox + cw, W, Math.ceil(x1 + pad)) - bx, bh = Math.min(oy + ch, H, Math.ceil(y1 + pad)) - by;
    if (bw <= 0 || bh <= 0) return;
    tctx.save();
    tctx.setTransform(1, 0, 0, 1, -ox, -oy);
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
    ctx.drawImage(tmp, bx - ox, by - oy, bw, bh, bx, by, bw, bh);
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
    // xf が null を返したものは描かない（投げ縄で動かしている最中は、別の紙に描いている）
    for (i = 0; i < list.length; i++) { s = xf ? xf(list[i]) : list[i]; if (s && s.tool === 'image') drawItem(ctx, s, W, H); }
    for (i = 0; i < list.length; i++) { s = xf ? xf(list[i]) : list[i]; if (s && s.tool !== 'image') drawItem(ctx, s, W, H); }
  }
  // 付箋（線の上に描く）
  function drawNotes(ctx, n, W, H) {
    var l = S.notes[n];
    if (hooks.drawNotes && l && l.length) hooks.drawNotes(ctx, l, W, H);
  }
  function drawInk() {
    ictx.clearRect(0, 0, ink.width, ink.height);
    drawList(ictx, pages(), ink.width, ink.height, S.xform);
    drawNotes(ictx, S.page, ink.width, ink.height);
    if (hv) hiInk();
  }

  /* ---------- 見えている所だけの、きめ細かい層 ----------
     - pc: 書いている最中の線。書き始めに、見えている所に重ねて置き、毎回まるごと描き直す
     - hp（PDF）と hi（手書き）: 拡大して紙全体の絵が粗くなったとき（大きすぎて細かく描けない）、
       見えている所だけを画面の細かさで描いて重ねる。スクロールが止まったら描き直す（GoodNotesのように） */
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  function vpCanvas(id) { var c = document.createElement('canvas'); c.id = id; c.className = 'vp'; c.hidden = true; return c; }
  var hp = vpCanvas('hipdf'), hi = vpCanvas('hiink'), pc = vpCanvas('penc');
  wrap.insertBefore(hp, lc); wrap.insertBefore(hi, lc); wrap.insertBefore(pc, $('marks'));
  var hv = null, hiNeed = false, hiTok = 0, hiTimer = 0, pcv = null;
  // 紙のうち、画面に見えている所（m: まわりに足す余白の割合）を、画面の点の単位で
  function visBox(m) {
    var rw = wrap.getBoundingClientRect(), rs = stage.getBoundingClientRect();
    if (!rw.width || !S.cssW) return null;
    var k = rw.width / S.cssW;
    var x0 = (Math.max(rw.left, rs.left) - rw.left) / k, x1 = (Math.min(rw.right, rs.right) - rw.left) / k;
    var y0 = (Math.max(rw.top, rs.top) - rw.top) / k, y1 = (Math.min(rw.bottom, rs.bottom) - rw.top) / k;
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    var mx = (x1 - x0) * (m || 0), my = (y1 - y0) * (m || 0);
    x0 = Math.max(0, x0 - mx); y0 = Math.max(0, y0 - my); x1 = Math.min(S.cssW, x1 + mx); y1 = Math.min(S.cssH, y1 + my);
    var ox = Math.floor(x0 * DPR), oy = Math.floor(y0 * DPR);
    return { ox: ox, oy: oy, cw: Math.ceil(x1 * DPR) - ox, ch: Math.ceil(y1 * DPR) - oy, W: S.cssW * DPR, H: S.cssH * DPR,
      x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function placeVp(c, v) {
    if (c.width !== v.cw || c.height !== v.ch) { c.width = v.cw; c.height = v.ch; }
    c.style.left = (v.ox / DPR) + 'px'; c.style.top = (v.oy / DPR) + 'px';
    c.style.width = (v.cw / DPR) + 'px'; c.style.height = (v.ch / DPR) + 'px';
  }
  function vpCtx(c, v) {
    var x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
    x.setTransform(1, 0, 0, 1, -v.ox, -v.oy);
    return x;
  }
  // 書いている最中の線
  function pcStart() {
    pcv = visBox(0);
    if (!pcv) return;
    placeVp(pc, pcv); vpCtx(pc, pcv); pc.hidden = false;
  }
  function pcDraw() {
    if (!pcv) return;
    var x = vpCtx(pc, pcv);
    if (S.live) drawItem(x, S.live, pcv.W, pcv.H);
  }
  function pcClear() { if (pcv) { vpCtx(pc, pcv); pcv = null; } }
  // 拡大中のきめ細かい層
  function hiKey() { return S.key + ':' + S.page + ':' + Math.round(S.cssW) + 'x' + Math.round(S.cssH); }
  function hiHide() { hiTok++; hv = null; hp.hidden = hi.hidden = true; }
  function hiSoon(ms) { clearTimeout(hiTimer); if (hiNeed) hiTimer = setTimeout(hiRender, ms == null ? 180 : ms); }
  function hiInk() {
    if (!hv) return;
    var x = vpCtx(hi, hv);
    drawList(x, pages(), hv.W, hv.H, S.xform);
    drawNotes(x, S.page, hv.W, hv.H);
  }
  function hiAdd(s) { if (hv) { var x = hi.getContext('2d'); drawItem(x, s, hv.W, hv.H); } }
  async function hiRender() {
    if (!hiNeed || !S.hasFile || pinch || turning || drawing) { if (hiNeed && drawing) hiSoon(400); return; }
    var now = visBox(0); if (!now) return;
    var key = hiKey();
    if (hv && hv.key === key && now.x0 >= hv.x0 - 1 && now.y0 >= hv.y0 - 1 && now.x1 <= hv.x1 + 1 && now.y1 <= hv.y1 + 1) return; // もう描いてある
    var v = visBox(0.15);
    if (v.cw * v.ch > 10e6) v = now;
    v.key = key;
    var tok = ++hiTok, n = S.page, info = await pageInfo(n);
    if (tok !== hiTok || n !== S.page) return;
    var off = blankCanvas(v.cw, v.ch), x = off.getContext('2d');
    if (info.page) {
      try {
        await info.page.render({ canvasContext: x, viewport: info.vp(v.W / info.w), transform: [1, 0, 0, 1, -v.ox, -v.oy] }).promise;
      } catch (e) { off.width = off.height = 0; return; }
    } else { x.setTransform(1, 0, 0, 1, -v.ox, -v.oy); drawPaper(x, v.W, v.H, entry()); }
    if (tok !== hiTok || hiKey() !== key) { off.width = off.height = 0; return; }
    placeVp(hp, v); placeVp(hi, v);
    var px = hp.getContext('2d'); px.setTransform(1, 0, 0, 1, 0, 0); px.drawImage(off, 0, 0);
    off.width = off.height = 0;
    hv = v; hiInk();
    hp.hidden = hi.hidden = false;
    dbg('きめ細かい層 ' + v.cw + 'x' + v.ch);
  }
  stage.addEventListener('scroll', function () { if (hiNeed) hiSoon(); }, { passive: true });

  /* ---------- 見開きで、2ページにまたがる書き込み ----------
     書き始めたページに線をそのまま（はみ出した所も）入れ、もう片方のページにも、そのページの位置に直した写しを入れる。
     どちらも自分の紙の中だけが見えるので、見開きではつながって見え、縦画面ではそれぞれ半分ずつ見える。
     2つの写しは link（同じ番号）で結んでおき、消すときは両方消す */
  function refreshStillInk() {
    if (!st || !st.ink) return;
    var c = st.ink.getContext('2d');
    c.clearRect(0, 0, st.ink.width, st.ink.height);
    drawList(c, S.strokes[st.n] || [], st.ink.width, st.ink.height);
    drawNotes(c, st.n, st.ink.width, st.ink.height);
  }
  function crossStart() { // 書き始め: もう片方のページの位置を控える
    if (!S.spread || !st || st.n < 1 || still.hidden) return null;
    var rs = still.getBoundingClientRect();
    return { n: st.n, rw: S.rc, rs: rs, right: rs.left > S.rc.left, snap: st.ink ? copyOf(st.ink) : null };
  }
  function crossPts(x, pts) {
    var rw = x.rw, rs = x.rs;
    return pts.map(function (p) {
      return [r4((rw.left + p[0] * rw.width - rs.left) / rs.width), r4((rw.top + p[1] * rw.height - rs.top) / rs.height), p[2]];
    });
  }
  function crosses(x, s) { return s.points.some(function (p) { return x.right ? p[0] > 1 : p[0] < 0; }); }
  function crossLive(x) { // 書いている最中: はみ出した所を、もう片方の紙にも描く
    var s = S.live; if (!s || !x.snap || !st || st.n !== x.n || !st.ink || !crosses(x, s)) return;
    var c = st.ink.getContext('2d'), W = st.ink.width, H = st.ink.height;
    c.clearRect(0, 0, W, H); c.drawImage(x.snap, 0, 0);
    drawItem(c, { tool: s.tool, color: s.color, width: s.width, points: crossPts(x, s.points) }, W, H);
  }
  // 消した線と結ばれている、もう片方のページの写しも消す
  function dropLinked(gone) {
    var ids = gone.map(function (x) { return x.link; }).filter(Boolean);
    if (!ids.length || !S.spread || !st) return;
    var arr = S.strokes[st.n] || [], keep = arr.filter(function (x) { return !x.link || ids.indexOf(x.link) < 0; });
    if (keep.length === arr.length) return;
    S.strokes[st.n] = keep; scheduleSave(st.n); refreshStillInk();
  }

  /* ---------- 方眼・罫線の紙 ----------
     追加した白紙のページに引く線。ページの単位（PDFの点、左上が原点）で [x1, y1, x2, y2] の並びを返す。
     画面（app.js）とPDFへの書き出し（pdf-write.js）で同じ線を使う */
  var MM = 72 / 25.4;
  function paperLines(w, h, bg) {
    var out = [], x, y;
    if (bg === 'grid') {
      var g = 5 * MM;
      for (x = g; x < w - 0.5; x += g) out.push([x, 0, x, h]);
      for (y = g; y < h - 0.5; y += g) out.push([0, y, w, y]);
    } else if (bg === 'lined') {
      var gap = 8 * MM, top = 25 * MM, side = 12 * MM;
      for (y = top; y < h - 15 * MM; y += gap) out.push([side, y, w - side, y]);
    }
    return out;
  }
  var PAPER_COLOR = '#c7d1de';
  function drawPaper(ctx, W, H, e) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (!e || !e.bg) return;
    var pw = e.w || A4.w, ph = e.h || A4.h, kx = W / pw, ky = H / ph;
    ctx.save();
    ctx.strokeStyle = PAPER_COLOR; ctx.lineWidth = Math.max(1, 0.6 * kx);
    ctx.beginPath();
    paperLines(pw, ph, e.bg).forEach(function (l) { ctx.moveTo(l[0] * kx, l[1] * ky); ctx.lineTo(l[2] * kx, l[3] * ky); });
    ctx.stroke();
    ctx.restore();
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
      var page = await S.pdf.getPage(e.src), rot = ((page.rotate || 0) + (e.rot || 0)) % 360;
      var b = page.getViewport({ scale: 1, rotation: rot });
      return { page: page, w: b.width, h: b.height, vp: function (k) { return page.getViewport({ scale: k, rotation: rot }); } };
    }
    return { page: null, w: e.w || A4.w, h: e.h || A4.h };
  }

  /* ---------- 見開き（横画面）と、ページの絵の控え ----------
     横画面では2ページを並べる（1-2, 3-4, …）。書ける紙（wrap）は1枚だけなので、
     もう片方は絵（still）で出しておき、ペンが触れたら見た目を変えずに一瞬で入れかえる */
  var flow = $('flow'), still = $('still'), spine = $('spine'), turnEl = $('turn');
  S.spread = false;
  /* 縦スクロール（S.vert）: 見開きにせず、ページを上下につなげて並べる（GoodNotesのように）。
     書ける紙（wrap）は1枚だけなので、上の前のページ（stillUp）と下の次のページ（still）は絵で出し、
     スクロールで画面のまん中に来たページを、見た目を変えずに書ける紙と入れかえる。この端末に覚える */
  S.vert = false;
  try { S.vert = localStorage.getItem('dk:ui:vert') === '1'; } catch (e) {}
  function isSpread() { return S.hasFile && !S.vert && stage.clientWidth > stage.clientHeight * 1.1; }
  // 見開きの組み合わせ。ずらす設定（S.shift）がオンなら、1ページ目は右に1枚だけ、そのあと 2-3, 4-5, …
  S.shift = false;
  function isLeft(n) { return (n + (S.shift ? 1 : 0)) % 2 === 1; }
  function leftOf(n) { return isLeft(n) ? n : n - 1; }   // 0 のときは左がない（ずらしたときの1ページ目）
  function partner(n) { var m = isLeft(n) ? n + 1 : n - 1; return m >= 1 && m <= S.total ? m : 0; }
  function shiftKey() { return 'dk:shift:' + S.key; }
  function loadShift() { try { S.shift = localStorage.getItem(shiftKey()) === '1'; } catch (e) { S.shift = false; } }
  // 「その他」から: このPDFの見開きの組み合わせを1ページずらす（PDFごとに覚えておく）
  function setShift(v) {
    S.shift = !!v;
    try { if (S.shift) localStorage.setItem(shiftKey(), '1'); else localStorage.removeItem(shiftKey()); } catch (e) {}
    if (st) st.n = -1;
    renderPage(); updateUI();
  }
  // 前・次へ移る先（見開きなら2ページずつ。移った先は左のページ）
  function stepPage(d) {
    if (!S.spread) return S.page + d;
    var n = leftOf(S.page) + 2 * d;
    return n === 0 ? 1 : n; // ずらしたときの1ページ目（右に1枚だけ）
  }
  function canStep(d) { var n = stepPage(d); return S.hasFile && n >= 1 && n <= S.total; }
  function pageText() {
    var m = S.spread ? partner(S.page) : 0;
    return (m ? Math.min(S.page, m) + '-' + Math.max(S.page, m) : S.page) + ' / ' + S.total;
  }

  // ページの大きさ（PDFの単位）。元のPDFのページ番号ごとに控える
  var sizes = {};
  function sizeKey(n) { var e = entry(n); return e.src > 0 ? 's' + e.src + (e.rot ? 'r' + e.rot : '') : 'b' + (e.w || A4.w) + 'x' + (e.h || A4.h); }
  async function sizeOf(n) {
    var k = sizeKey(n);
    if (!sizes[k]) { var i = await pageInfo(n); sizes[k] = { w: i.w, h: i.h }; }
    return sizes[k];
  }
  // 今の並べ方での、ページの表示の大きさ（見開きは高さをそろえる）
  function cssOf(sz) {
    return S.spread ? { w: S.cssH * sz.w / sz.h, h: S.cssH } : { w: S.cssW, h: S.cssW * sz.h / sz.w };
  }
  function capDpr(w, h) { return Math.max(0.5, Math.min(Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(1.6e6 / (w * h)))); }

  // ページの紙とPDFだけの絵（手書きは重ねるときに描く）。めくるとき・見開きの片方に使う
  var baseCache = {}, baseList = [], BASE_KEEP = 12;
  function baseKey(n, css) { var e = entry(n); return [S.key, sizeKey(n), e.bg || '', Math.round(css.w)].join('|'); }
  function getBase(n) {
    return sizeOf(n).then(function (sz) {
      var css = cssOf(sz), key = baseKey(n, css), hit = baseCache[key];
      if (hit) return hit.p;
      var slot = { p: null, c: null };
      slot.p = (async function () {
        var info = await pageInfo(n), d = capDpr(css.w, css.h);
        var W = Math.max(1, Math.floor(css.w * d)), H = Math.max(1, Math.floor(css.h * d));
        var c = document.createElement('canvas'); c.width = W; c.height = H;
        var x = c.getContext('2d');
        drawPaper(x, W, H, info.page ? null : entry(n));
        if (info.page) await info.page.render({ canvasContext: x, viewport: info.vp(W / info.w) }).promise;
        slot.c = c;
        return c;
      })();
      baseCache[key] = slot; baseList.push(key);
      while (baseList.length > BASE_KEEP) delete baseCache[baseList.shift()];
      slot.p.catch(function () { if (baseCache[key] === slot) delete baseCache[key]; });
      return slot.p;
    });
  }
  function baseNow(n) { // もう描けていれば返す
    var sz = sizes[sizeKey(n)]; if (!sz) return null;
    var hit = baseCache[baseKey(n, cssOf(sz))]; return hit ? hit.c : null;
  }
  /* 軽い絵: 高速めくりの間だけ使う、小さく速く描ける絵（あとで、きれいな絵に差しかわる） */
  var quick = {}, quickList = [], QUICK_KEEP = 40, QUICK_PX = 2.4e5;
  function quickKey(n) { var e = entry(n); return [S.key, sizeKey(n), e.bg || ''].join('|'); }
  function getQuick(n) {
    var key = quickKey(n), hit = quick[key];
    if (hit) return hit.p;
    var slot = { p: null, c: null };
    slot.p = (async function () {
      var info = await pageInfo(n), a = info.w / info.h;
      var W = Math.max(1, Math.round(Math.sqrt(QUICK_PX * a))), H = Math.max(1, Math.round(W / a));
      var c = document.createElement('canvas'); c.width = W; c.height = H;
      var x = c.getContext('2d');
      drawPaper(x, W, H, info.page ? null : entry(n));
      if (info.page) await info.page.render({ canvasContext: x, viewport: info.vp(W / info.w) }).promise;
      slot.c = c;
      return c;
    })();
    quick[key] = slot; quickList.push(key);
    while (quickList.length > QUICK_KEEP) delete quick[quickList.shift()];
    slot.p.catch(function () { if (quick[key] === slot) delete quick[key]; });
    return slot.p;
  }
  function quickNow(n) { var h = quick[quickKey(n)]; return h ? h.c : null; }
  // ページの絵そのものが変わったとき（スクラップのページを白黒にした など）: 作っておいた絵を捨てて描き直す
  function repaint(n) {
    baseCache = {}; baseList = []; quick = {}; quickList = [];
    if (st) st.n = -1;
    if (upSt) upSt.n = -1;
    hiHide();
    var p = renderPage();
    emit('repaint', n);
    return p;
  }
  function blankCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function copyOf(src) { var c = blankCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
  function inkOf(n, w, h) { var c = blankCanvas(w, h), x = c.getContext('2d'); drawList(x, S.strokes[n] || [], w, h); drawNotes(x, n, w, h); return c; }
  // 紙＋書き込み＋付箋を1枚に
  function compose(n, base) { var c = copyOf(base), x = c.getContext('2d'); drawList(x, S.strokes[n] || [], c.width, c.height); drawNotes(x, n, c.width, c.height); return c; }
  // 今の書ける紙を写しとる
  function snapshotCurrent() {
    var d = capDpr(S.cssW, S.cssH), W = Math.floor(S.cssW * d), H = Math.floor(S.cssH * d);
    var b = blankCanvas(W, H); b.getContext('2d').drawImage(pdfC, 0, 0, W, H);
    var i = blankCanvas(W, H); i.getContext('2d').drawImage(ink, 0, 0, W, H);
    return { n: S.page, base: b, ink: i, w: S.cssW, h: S.cssH, key: baseKey(S.page, { w: S.cssW }) };
  }
  // めくる紙の面に貼る絵（なければ null）
  function faceOf(n) {
    if (!n) return null;
    if (n === S.page) { var s = snapshotCurrent(); s.base.getContext('2d').drawImage(s.ink, 0, 0); return s.base; }
    if (st && st.n === n && st.base) { var c = copyOf(st.base); if (st.ink) c.getContext('2d').drawImage(st.ink, 0, 0); return c; }
    var b = baseNow(n) || quickNow(n); return b ? compose(n, b) : null;
  }

  // 縦スクロールの、上にある前のページ（絵）。高さが変わったら、そのぶんスクロールして書ける紙を動かさない
  var upEl = document.createElement('div'); upEl.id = 'stillUp'; upEl.hidden = true; flow.insertBefore(upEl, $('wrap'));
  var upSt = null, upTok = 0, upHold = false;
  function setUp(o) {
    var h0 = upEl.hidden ? 0 : upEl.offsetHeight;
    upSt = o; upEl.textContent = '';
    if (o) {
      upEl.hidden = false; upEl.dataset.n = o.n;
      upEl.style.width = o.w + 'px'; upEl.style.height = o.h + 'px';
      if (o.base) upEl.appendChild(o.base);
      if (o.ink) upEl.appendChild(o.ink);
    } else upEl.hidden = true;
    var h1 = upEl.hidden ? 0 : upEl.offsetHeight;
    if (!upHold && h1 !== h0) stage.scrollTop += h1 - h0;
  }
  function updateUp() {
    var m = S.vert && S.hasFile && S.page > 1 ? S.page - 1 : 0;
    if (!m) { upTok++; if (upSt) setUp(null); return; }
    var sz = sizes[sizeKey(m)], css = sz ? cssOf(sz) : null;
    if (upSt && upSt.n === m && sz && upSt.key === baseKey(m, css)) return;
    var b = sz && baseNow(m), tok = ++upTok;
    if (b) { setUp(stillFrom(m, b)); return; }
    var q = sz && quickNow(m);
    if (q) { var qs = stillFrom(m, q); qs.key = ''; setUp(qs); }
    else if (!upSt || upSt.n !== m) setUp({ n: m, w: S.cssW, h: sz ? css.h : S.cssH, key: '' }); // 描けるまでは白い紙
    getBase(m).then(function (c) { if (tok === upTok && S.vert && S.page - 1 === m) setUp(stillFrom(m, c)); }, function () {});
  }
  // 縦スクロール: 上か下のページを書ける紙にする（見た目は変えない）
  function goVert(n) {
    if (!S.vert || turning || drawing || n < 1 || n > S.total || n === S.page) return false;
    var sz = sizes[sizeKey(n)]; if (!sz) return false;
    var down = n > S.page, el = down ? still : upEl, o = down ? st : upSt;
    if (!o || o.n !== n || el.hidden) return false;
    var top0 = el.getBoundingClientRect().top, old = snapshotCurrent();
    stTok++; upTok++;
    S.placeholder = o.base || null;
    S.page = n; S.live = null;
    upHold = true;
    if (down) { setUp(old); setStill(null); } else { setStill(old); setUp(null); }
    layoutPage(sz.w, sz.h, null);
    upHold = false;
    stage.scrollTop += wrap.getBoundingClientRect().top - top0;
    renderSoon(); // きれいな絵に描き直すのは、スクロールが止まってから（描いている間にスクロールが引っかからないように）
    flashPager(); emit('page'); updateUI();
    return true;
  }
  var scrolledAt = 0, vrTimer = 0;
  function markScroll() { scrolledAt = performance.now(); }
  function renderSoon() {
    clearTimeout(vrTimer);
    vrTimer = setTimeout(function () {
      if (performance.now() - scrolledAt < 140 || fl) { renderSoon(); return; }
      renderPage();
    }, 160);
  }
  // スクロールのあと: 書ける紙が画面のまん中から外れたら、まん中のページと入れかえる
  function checkVert() {
    if (!S.vert || !S.hasFile || turning || drawing) return;
    var sr = stage.getBoundingClientRect(), mid = sr.top + sr.height / 2, wr = wrap.getBoundingClientRect();
    if (wr.bottom < mid) goVert(S.page + 1);
    else if (wr.top > mid) goVert(S.page - 1);
  }
  function setVert(v) {
    S.vert = !!v;
    try { localStorage.setItem('dk:ui:vert', S.vert ? '1' : '0'); } catch (e) {}
    applyScrub();
    if (st) st.n = -1;
    stTok++; upTok++; setStill(null); upHold = true; setUp(null); upHold = false;
    if (S.hasFile) { S.vjump = S.vert; if (!S.vert) stage.scrollTo(0, 0); renderPage(); updateUI(); }
    emit('vert');
  }

  // 見開きのもう片方（絵）
  var st = null, stTok = 0;
  function setStill(o) {
    st = o; still.textContent = '';
    if (!o) { still.hidden = true; return; }
    still.hidden = false; still.dataset.n = o.n;
    still.style.width = o.w + 'px'; still.style.height = o.h + 'px';
    if (o.base) still.appendChild(o.base);
    if (o.ink) still.appendChild(o.ink);
  }
  function stillFrom(n, base) {
    var css = cssOf(sizes[sizeKey(n)]), b = copyOf(base);
    return { n: n, base: b, ink: inkOf(n, b.width, b.height), w: css.w, h: css.h, key: baseKey(n, css) };
  }
  function layoutSpread() {
    flow.classList.toggle('spread', S.spread);
    flow.classList.toggle('vert', S.vert);
    flow.classList.toggle('act-r', S.spread && !isLeft(S.page));
    var w = S.cssW, lw = S.cssW;
    if (S.spread) {
      if (st) { w += st.w; if (!isLeft(S.page)) lw = st.w; }
      else w *= 2; // 最後の1ページだけのときも、左側に置く
    }
    flow.style.width = w + 'px';
    spine.style.left = lw + 'px'; spine.style.height = S.cssH + 'px';
    layoutEdges(w);
  }
  /* 小口: 紙の左右の外側。厚さは、その向きに残っているページ数で変わる。
     下のバー（scrub）も、ここで紙の幅に合わせる */
  var edgeL = $('edgeL'), edgeR = $('edgeR'), scrub = $('scrub'), scrubMark = scrub.querySelector('.mark');
  var FLOW_PAD = 48, EDGE_ROOM = 36; // 紙の上下の余白（上4 + 下44: バーの分）、小口の場所（片側）
  // 下のバーを出すか（「その他」で切りかえ。この端末に保存）
  var scrubOn = true;
  try { scrubOn = localStorage.getItem('dk:ui:scrub') !== '0'; } catch (e) {}
  function applyScrub() { var on = scrubOn && !S.vert; FLOW_PAD = on ? 48 : 12; flow.classList.toggle('noscrub', !on); }
  applyScrub();
  function setScrub(v) {
    scrubOn = !!v; applyScrub();
    try { localStorage.setItem('dk:ui:scrub', scrubOn ? '1' : '0'); } catch (e) {}
    if (S.hasFile) renderPage();
  }
  function layoutEdges(w) {
    scrub.classList.toggle('on', scrubOn && S.hasFile && S.total > 1 && !S.vert);
    scrub.style.width = w + 'px'; scrub.style.top = (4 + S.cssH + 4) + 'px';
    if (!scrubG) markAt(S.page);
    var room = Math.floor((stage.clientWidth - w) / 2) - 1, h = S.cssH;
    var lo = S.spread ? leftOf(S.page) : S.page, hi = S.spread ? lo + 1 : S.page;
    [[edgeL, lo - 1], [edgeR, S.total - hi]].forEach(function (a) {
      var el = a[0], n = Math.max(0, a[1]);
      var on = S.hasFile && n > 0 && room >= 8 && !S.vert;
      el.classList.toggle('on', on);
      if (!on) return;
      var th = Math.min(room - 2, EDGE_ROOM - 2), k = Math.min(1, n / Math.max(20, S.total));
      el.style.width = room + 'px'; el.style.height = h + 'px';
      el.style.left = (el === edgeL ? -room : w) + 'px';
      el.style.setProperty('--th', Math.round(Math.max(6, Math.min(th, 6 + (th - 6) * Math.sqrt(k)))) + 'px');
    });
  }
  function updateStill() {
    updateUp();
    var m = S.spread ? partner(S.page) : S.vert && S.page < S.total ? S.page + 1 : 0;
    if (!m) { stTok++; setStill(null); layoutSpread(); return; }
    var sz = sizes[sizeKey(m)], css = sz ? cssOf(sz) : { w: S.cssW, h: S.cssH };
    if (!(st && st.n === m && sz && st.key === baseKey(m, css))) {
      var b = sz && baseNow(m), tok = ++stTok;
      if (b) setStill(stillFrom(m, b));
      else {
        var q = quickNow(m);
        if (q && sz) { var qs = stillFrom(m, q); qs.key = ''; setStill(qs); } // 軽い絵があれば、それを先に
        else setStill({ n: m, w: css.w, h: css.h, key: '' }); // 描けるまでは白い紙
        if (rapid) { laterStill(); return layoutSpread(); } // 高速めくりの間は、きれいな絵はあとで
        getBase(m).then(function (c) {
          if (tok !== stTok) return;
          setStill(stillFrom(m, c)); layoutSpread();
        }, function () {});
      }
    }
    layoutSpread();
  }
  on('layout', function () { if (st) st.n = -1; if (upSt) upSt.n = -1; });
  var stillTimer = 0;
  function laterStill() {
    clearTimeout(stillTimer);
    stillTimer = setTimeout(function () {
      if (rapid || T) { laterStill(); return; }
      if (st && !st.key) { st.n = -1; updateStill(); }
    }, 250);
  } // ページの並びが変わったら、絵は描き直す

  // 書ける紙の大きさ・置き場所を決めて、手書きを描く（ここまでは待たずに一度に）
  function layoutPage(bw, bh, msz) {
    S.pageSize = { w: bw, h: bh };
    lastStageW = stage.clientWidth;
    var cssW, cssH;
    if (S.spread) {
      var a = bw / bh + (msz ? msz.w / msz.h : bw / bh);
      cssH = Math.max(160, Math.min(stage.clientHeight - FLOW_PAD, (stage.clientWidth - 24) / a) * S.zoom);
      cssW = cssH * bw / bh;
    } else {
      // 縦スクロールの横向きでは、横幅いっぱいにせず、画面の高さに合わせたほどよい大きさで（GoodNotesのように）
      var fitW = stage.clientWidth - 24;
      if (S.vert && stage.clientWidth > stage.clientHeight) fitW = Math.min(fitW, stage.clientHeight * 0.9);
      cssW = Math.max(240, fitW * S.zoom);
      cssH = cssW * bh / bw;
    }
    var area = cssW * cssH, dw = Math.min(window.devicePixelRatio || 1, 2);
    // 紙全体の絵は、大きくなりすぎないように細かさを下げる（iPadのcanvasの上限をこえると真っ白になる）。
    // 下げたときは、見えている所だけきめ細かい層を重ねる
    var dprPdf = Math.max(0.12, Math.min(dw, Math.sqrt(9e6 / area)));
    var dprInk = Math.max(0.12, Math.min(dw, Math.sqrt(6e6 / area)));
    S.cssW = cssW; S.cssH = cssH;
    hiNeed = Math.min(dprPdf, dprInk) < DPR * 0.95;
    if (!hiNeed || (hv && hv.key !== hiKey())) hiHide();
    wrap.style.width = cssW + 'px'; wrap.style.height = cssH + 'px';
    if (S.swap) { var sw = S.swap; S.swap = null; sw(); } // めくり終わったあとの置きかえ（同じ瞬間に）
    updateStill();
    // 画面より小さいとき（縮小・見開き）は、上下のまん中に
    flow.style.marginTop = S.vert ? '0px' : Math.max(0, Math.floor((stage.clientHeight - cssH - FLOW_PAD) / 2)) + 'px';
    if (S.vjump) { S.vjump = false; stage.scrollTop += wrap.getBoundingClientRect().top - stage.getBoundingClientRect().top - 6; } // 縦スクロールでページへ飛んだ: その上の端へ
    // 同じページの描き直し（拡大・画面の回転）では、描き終わるまで今の絵を引き伸ばして出しておく（白く点滅しないように）
    var shown = S.key + ':' + S.page + ':' + entry().src, changed = shown !== lastShown, old = null;
    var pw = Math.floor(cssW * dprPdf), ph = Math.floor(cssH * dprPdf);
    if (pdfC.width !== pw || pdfC.height !== ph) {
      if (!changed && pdfC.width > 0) { old = copyOf(pdfC); }
      pdfC.width = pw; pdfC.height = ph;
      if (old) { pctx.drawImage(old, 0, 0, pw, ph); old.width = old.height = 0; }
    }
    if (changed) {
      pctx.clearRect(0, 0, pw, ph);
      if (S.placeholder) pctx.drawImage(S.placeholder, 0, 0, pw, ph); // めくってきた絵を、描き終わるまでの代わりに
      lctx.clearRect(0, 0, lc.width, lc.height);
    }
    S.placeholder = null; lastShown = shown;
    var iw = Math.floor(cssW * dprInk), ih = Math.floor(cssH * dprInk);
    [ink, lc, tmp].forEach(function (c) { if (c.width !== iw || c.height !== ih) { c.width = iw; c.height = ih; } });
    [pdfC, ink, lc].forEach(function (c) { c.style.width = cssW + 'px'; c.style.height = cssH + 'px'; });
    if (S.anchor) {
      var an = S.anchor; S.anchor = null;
      var rc = flow.getBoundingClientRect();
      stage.scrollLeft += rc.left + an.fx * rc.width - an.cx;
      stage.scrollTop += rc.top + an.fy * rc.height - an.cy;
    }
    drawInk();
    emit('resize');
    return { cssW: cssW, dprPdf: dprPdf };
  }

  async function renderPage() {
    if (!S.hasFile) return;
    var t0 = performance.now();
    var token = ++renderToken;
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }
    S.spread = isSpread();
    var info = await pageInfo(S.page);
    var m = S.spread ? partner(S.page) : 0, msz = m ? await sizeOf(m) : null;
    if (token !== renderToken) return;
    var page = info.page, bw = info.w, bh = info.h;
    sizes[sizeKey(S.page)] = { w: bw, h: bh };
    var L = layoutPage(bw, bh, msz);
    if (page) {
      // 別の紙に描いてから、できあがったら一度に写す
      var off = blankCanvas(pdfC.width, pdfC.height);
      var task = page.render({ canvasContext: off.getContext('2d'), viewport: info.vp(L.cssW / bw * L.dprPdf) });
      renderTask = task;
      try {
        await task.promise;
        if (token === renderToken) { pctx.clearRect(0, 0, pdfC.width, pdfC.height); pctx.drawImage(off, 0, 0); }
      } catch (e) {
        if (!(e && e.name === 'RenderingCancelledException')) { setStatus('PDFの表示に失敗しました'); console.error(e); }
      }
      off.width = off.height = 0;
      if (token !== renderToken) return;
    } else {
      drawPaper(pctx, pdfC.width, pdfC.height, entry());
    }
    dbg('ページ描き直し ' + Math.round(performance.now() - t0) + 'ms（倍率' + Math.round(S.zoom * 100) + '%）');
    hiSoon(0);
    updateUI();
    if (!rapid) prefetch();
  }
  // めくる先のページを、先に描いておく
  var preTimer = 0;
  function prefetch() {
    clearTimeout(preTimer);
    preTimer = setTimeout(function () {
      var L = leftOf(S.page);
      var list = S.spread ? [L + 2, L + 3, L - 1, L - 2, L + 4, L + 5] : [S.page + 1, S.page - 1, S.page + 2];
      list.filter(function (n) { return n >= 1 && n <= S.total; })
        .reduce(function (p, n) { return p.then(function () { return getBase(n); }).catch(function () {}); }, Promise.resolve());
    }, 150);
  }
  /* 見開きのもう片方を、書ける紙にする（見た目は変えずに、すぐに） */
  function activate(n) {
    if (!S.spread || !st || st.n !== n || !st.base || turning) return false;
    var sz = sizes[sizeKey(n)]; if (!sz) return false;
    var old = snapshotCurrent(), ph = st.base;
    stTok++;
    S.page = n; S.live = null;
    S.placeholder = ph;
    setStill(old);
    layoutPage(sz.w, sz.h, sizes[sizeKey(old.n)]);
    renderPage(); // きれいな絵に描き直す（大きさは変わらないので、手書きは消えない）
    flashPager(); emit('page'); updateUI();
    return true;
  }

  // 画面のその場所にあるページ（書ける紙・見開きのもう片方・縦スクロールの上下のページ）
  function pageAt(x, y) {
    function inside(el) { var r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? r : null; }
    var r = inside(wrap); if (r) return { n: S.page, rect: r };
    if (st && !still.hidden && st.n >= 1 && (r = inside(still))) return { n: st.n, rect: r };
    if (upSt && !upEl.hidden && upSt.n >= 1 && (r = inside(upEl))) return { n: upSt.n, rect: r };
    return null;
  }
  // そのページを書ける紙にする（見た目は変えない）。できたら true
  function focusPage(n) { return n === S.page ? true : !!(S.vert ? goVert(n) : activate(n)); }

  /* ページ一覧用の小さな絵（PDF＋手書き）を canvas に描く */
  async function renderThumb(canvas, n, cssWidth) {
    var info = await pageInfo(n);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = Math.round(cssWidth * dpr), H = Math.round(cssWidth * info.h / info.w * dpr);
    canvas.width = W; canvas.height = H;
    canvas.style.width = cssWidth + 'px'; canvas.style.height = (cssWidth * info.h / info.w) + 'px';
    var ctx = canvas.getContext('2d');
    drawPaper(ctx, W, H, info.page ? null : entry(n));
    if (info.page) await info.page.render({ canvasContext: ctx, viewport: info.vp(W / info.w) }).promise;
    drawList(ctx, S.strokes[n] || [], W, H);
    drawNotes(ctx, n, W, H);
  }
  /* スクラップブックに写すための、ページの絵（紙とPDFだけ。書き込みは線のまま別に写す）
     px: 長い辺の大きさ（ピクセル） */
  async function capturePage(n, px) {
    var info = await pageInfo(n), k = Math.min(4, px / Math.max(info.w, info.h));
    var W = Math.max(1, Math.round(info.w * k)), H = Math.max(1, Math.round(info.h * k));
    var c = blankCanvas(W, H), x = c.getContext('2d');
    drawPaper(x, W, H, info.page ? null : entry(n));
    if (info.page) await info.page.render({ canvasContext: x, viewport: info.vp(W / info.w) }).promise;
    return { canvas: c, w: info.w, h: info.h };
  }

  function updateUI() {
    if (!pagerTimer) setText($('pageLabel'), S.hasFile ? pageText() : '- / -');
    setDis($('prev'), !canStep(-1));
    setDis($('next'), !canStep(1));
    setDis($('undo'), !S.undo.length);
    setDis($('redo'), !S.redo.length);
    emit('ui');
  }

  /* ---------- 保存・復元 ---------- */
  // 元のPDFのままの並び（ページを足したり、並べ替えたり、削除したりしていない）でなければ、並びも保存する
  function layoutCustom() {
    var n = S.pdf ? S.pdf.numPages : 1;
    return S.layout.length !== n || S.layout.some(function (e, i) { return e.added || e.rot || (S.pdf && e.src !== i + 1); });
  }
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
    var nt = {}, any = false;
    for (var q in S.notes) if (S.notes[q] && S.notes[q].length) { nt[q] = S.notes[q]; any = true; }
    if (any) d.notes = nt;
    d.pages = out;
    return d;
  }
  function nid() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
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
          width: num(s.width, 0.5, 200, 4), // 切り抜いて写した線は太くなる（紙が小さくなるぶん）
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
        if (src > 0 && (e.rot === 90 || e.rot === 180 || e.rot === 270)) o.rot = e.rot;
        if (src === 0) {
          o.w = num(e.w, 50, 5000, A4.w); o.h = num(e.h, 50, 5000, A4.h);
          if (e.bg === 'grid' || e.bg === 'lined') o.bg = e.bg;
        }
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
    var notes = {};
    if (d.notes && typeof d.notes === 'object') Object.keys(d.notes).forEach(function (k) {
      var arr = d.notes[k]; if (!Array.isArray(arr)) return;
      var list = [];
      arr.forEach(function (t) {
        if (!t || !isFinite(t.x) || !isFinite(t.y)) return;
        list.push({
          id: typeof t.id === 'string' && t.id ? t.id.slice(0, 40) : nid(),
          x: num(t.x, 0, 1, 0.5), y: num(t.y, 0, 1, 0.5),
          color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#ffd84d',
          text: typeof t.text === 'string' ? t.text.slice(0, 4000) : '', at: +t.at || 0
        });
      });
      if (list.length) notes[k] = list;
    });
    return { pages: res, layout: layout, images: images, notes: notes };
  }
  function applyData(r) {
    S.strokes = r.pages;
    S.images = r.images || {};
    S.notes = r.notes || {};
    imgEls = {};
    S.layout = r.layout || defaultLayout();
    S.total = S.layout.length;
    if (S.page > S.total) S.page = S.total;
    S.undo = []; S.redo = []; S.cache = {}; S.dirty = {};
  }
  // quiet === true のときは「変更あり」を外部（Drive同期）に知らせない（Driveから読み込んだ直後の保存など）
  function doSave(quiet) {
    saveTimer = null;
    if (!S.hasFile) return;
    S.dirty = {};
    try { if (hooks.save) hooks.save(S.key, exportData()); }
    catch (e) { console.error(e); setStatus('この端末への保存に失敗しました（容量がいっぱいの可能性があります）'); }
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
  /* ---------- ファイルを開く ---------- */
  /* saved: この端末にある書き込みデータ（なければ空）。kind: 'book' / 'scrap'。at: 開くページ */
  function openDoc(doc, name, key, saved, kind, at) {
    flushSave(); // 前の本の未保存分を、切り替える前に保存する
    if (S.pdf && S.pdf !== doc && S.pdf._dkClose) { try { S.pdf._dkClose(); } catch (e) {} } // 前の本は閉じて、メモリを空ける
    S.pdf = doc; S.hasFile = true; S.name = name; S.key = key; S.kind = kind || 'book';
    S.page = 1; S.zoom = 1; S.live = null;
    sizes = {}; baseCache = {}; baseList = []; quick = {}; quickList = []; stTok++; setStill(null); upTok++; upHold = true; setUp(null); upHold = false; // 前のファイルの絵は使わない
    loadShift();
    applyData(parseData(saved) || { pages: {}, layout: null, images: {}, notes: {} });
    S.page = Math.min(S.total, Math.max(1, Math.floor(+at) || 1));
    document.documentElement.dataset.kind = S.kind;
    $('hint').style.display = 'none'; wrap.style.display = 'block';
    $('pager').hidden = false;
    document.body.classList.add('has-file');
    stage.scrollTo(0, 0);
    renderPage();
    emit('open');
    emit('page');
    if (hooks.opened) hooks.opened(key, name);
  }

  // 開いている本を閉じる（本棚で、開いている本を端末から消すときなど）
  function closeDoc() {
    if (!S.hasFile) return;
    flushSave();
    if (S.pdf && S.pdf._dkClose) { try { S.pdf._dkClose(); } catch (e) {} }
    renderToken++; if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }
    stTok++; setStill(null); upTok++; upHold = true; setUp(null); upHold = false;
    S.pdf = null; S.hasFile = false; S.key = ''; S.name = ''; S.live = null;
    S.strokes = {}; S.notes = {}; S.undo = []; S.redo = []; S.layout = []; S.total = 1; S.page = 1;
    sizes = {}; baseCache = {}; baseList = []; quick = {}; quickList = []; lastShown = '';
    wrap.style.display = 'none'; $('pager').hidden = true; $('hint').style.display = '';
    document.body.classList.remove('has-file');
    hiHide(); layoutEdges(0); updateUI();
    emit('close');
  }

  /* ---------- 操作 ---------- */
  function goPage(n, keepScroll) {
    n = Math.min(S.total, Math.max(1, n));
    if (n === S.page && S.hasFile) { drawInk(); updateUI(); return Promise.resolve(); }
    if (turning) return Promise.resolve();
    if (S.spread && st && st.n === n && activate(n)) return Promise.resolve(); // 同じ見開きのもう片方
    S.page = n; S.live = null;
    if (S.vert) S.vjump = true; else if (!keepScroll) stage.scrollTo(0, 0);
    var done = renderPage();
    flashPager(scrubG && scrubG.n ? labelOf(scrubG.n) : undefined); // バーをなぞっている間は、行き先の番号
    emit('page');
    return done;
  }
  $('prev').onclick = function () { autoTurn(-1); };
  $('next').onclick = function () { autoTurn(1); };
  function setZoom(z) {
    S.zoom = Math.min(MAXZOOM, Math.max(minZoom(), Math.round(z * 100) / 100));
    flashPager(Math.round(S.zoom * 100) + '%');
    renderPage();
  }

  function pushUndo(page, other) { // other: 見開きのもう片方も一緒に戻すとき、そのページ
    page = page || S.page;
    S.undo.push({ page: page, strokes: (S.strokes[page] || []).slice(),
      also: other ? { page: other, strokes: (S.strokes[other] || []).slice() } : null });
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  // 手書きを変えたあとの共通処理（描き直し・ボタンの状態・保存）
  function commit(page) { drawInk(); updateUI(); scheduleSave(page); emit('data'); }
  function applySnapshot(from, to) {
    var a = from.pop(); if (!a) return;
    emit('beforeUndo');
    to.push({ page: a.page, strokes: (S.strokes[a.page] || []).slice(),
      also: a.also ? { page: a.also.page, strokes: (S.strokes[a.also.page] || []).slice() } : null });
    S.strokes[a.page] = a.strokes;
    scheduleSave(a.page);
    if (a.also) { S.strokes[a.also.page] = a.also.strokes; scheduleSave(a.also.page); refreshStillInk(); }
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
    if (!S.hasFile) return Promise.resolve();
    flushSave();
    var cur = entry();
    // 'same': 今のページと同じもの（白紙・方眼・罫線のページなら同じ紙）。'blank' / 'grid' / 'lined': その紙
    var e = kind !== 'same' || !(cur.src > 0)
      ? { src: 0, w: Math.round(S.pageSize.w), h: Math.round(S.pageSize.h), added: true }
      : { src: cur.src, added: true };
    var bg = kind === 'same' ? cur.bg : kind;
    if (e.src === 0 && (bg === 'grid' || bg === 'lined')) e.bg = bg;
    var at = S.page; // この番号の次に入る
    S.layout.splice(at, 0, e);
    var ns = {};
    Object.keys(S.strokes).forEach(function (k) { var n = +k; ns[n > at ? n + 1 : n] = S.strokes[k]; });
    var nn = {};
    Object.keys(S.notes).forEach(function (k) { var n = +k; nn[n > at ? n + 1 : n] = S.notes[k]; });
    S.notes = nn;
    S.strokes = ns; S.total = S.layout.length;
    S.undo = []; S.redo = []; S.cache = {}; // ページ番号がずれるので、取り消し履歴は消す
    scheduleSave(at + 1);
    emit('layout');
    var done = goPage(at + 1);
    var PAPER = { blank: '白紙のページ', grid: '方眼のページ', lined: '罫線のページ' };
    setStatus(PAPER[kind] ? PAPER[kind] + 'を追加しました' : '同じページを追加しました');
    return done;
  }
  /* ページの並びを作り直す（ページ一覧の並べ替え・複製・削除など）
     plan: 新しい並びの1つずつ { e: layoutの項目, from: 元のページ番号（新しい紙は0）, copy: 書き込みを写すとき true }
     go: 移ったあとに開くページ */
  function rearrange(plan, go, msg) {
    if (!S.hasFile || !plan.length) return;
    flushSave();
    var ns = {}, nn = {};
    plan.forEach(function (p, i) {
      var arr = p.from ? S.strokes[p.from] : null, nt = p.from ? S.notes[p.from] : null;
      if (arr && arr.length) ns[i + 1] = p.copy ? arr.map(function (x) { var y = JSON.parse(JSON.stringify(x)); delete y.link; return y; }) : arr;
      if (nt && nt.length) nn[i + 1] = p.copy ? nt.map(function (x) { var y = JSON.parse(JSON.stringify(x)); y.id = nid(); return y; }) : nt;
    });
    S.layout = plan.map(function (p) { return p.e; });
    S.strokes = ns; S.notes = nn; S.total = S.layout.length;
    S.undo = []; S.redo = []; S.cache = {}; // ページ番号がずれるので、取り消し履歴は消す
    scheduleSave(1);
    emit('layout'); emit('data');
    S.page = 0; goPage(Math.min(S.total, Math.max(1, go)));
    if (msg) setStatus(msg);
  }
  function samePlan() { return S.layout.map(function (e, i) { return { e: e, from: i + 1 }; }); }
  // from ページを to の位置へ動かす
  function movePage(from, to) {
    if (from === to || from < 1 || from > S.total) return;
    var plan = samePlan(), cur = S.page, it = plan.splice(from - 1, 1)[0];
    to = Math.min(S.total, Math.max(1, to));
    plan.splice(to - 1, 0, it);
    var go = 1; plan.forEach(function (p, i) { if (p.from === cur) go = i + 1; });
    rearrange(plan, go, from + 'ページ目を' + to + 'ページ目に動かしました');
  }
  // n ページの前（before）か後ろに、白紙（同じ大きさ）を入れる
  function addPageAt(n, before) {
    var sz = sizes[sizeKey(n)] || S.pageSize;
    var e = { src: 0, w: Math.round(sz.w), h: Math.round(sz.h), added: true }, at = before ? n - 1 : n;
    var plan = samePlan();
    plan.splice(at, 0, { e: e, from: 0 });
    rearrange(plan, at + 1, '白紙のページを追加しました');
  }
  // n ページを書き込みごと写して、すぐ後ろに入れる
  function duplicatePage(n) {
    var src = S.layout[n - 1]; if (!src) return;
    var e = JSON.parse(JSON.stringify(src)); e.added = true;
    var plan = samePlan();
    plan.splice(n, 0, { e: e, from: n, copy: true });
    rearrange(plan, n + 1, n + 'ページ目を複製しました');
  }
  // n ページの書き込みを消す（元に戻せる）
  function clearPageAt(n) {
    if (!(S.strokes[n] || []).length) { setStatus('このページには書き込みがありません'); return; }
    pushUndo(n); S.strokes[n] = []; scheduleSave(n); emit('data');
    if (n === S.page) { drawInk(); updateUI(); } else { refreshStillInk(); goPage(n); }
    setStatus(n + 'ページ目の書き込みを消しました（元に戻すボタンで戻せます）');
  }
  /* n ページを右に90°回す。手書きと貼った画像も一緒に回す（太さは紙に対して同じ見た目のまま）
     - PDFのページ: layout の rot（0・90・180・270）。白紙のページ: 縦と横の長さを入れかえる */
  function rotXY(p) { return [r4(1 - p[1]), p[0], p[2]]; }
  function rotImage(url) { // 画像そのものを右に90°回した data URL
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () {
        var c = blankCanvas(im.naturalHeight, im.naturalWidth), x = c.getContext('2d');
        x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(im, 0, 0);
        resolve(/^data:image\/png/.test(url) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9));
      };
      im.onerror = function () { resolve(null); };
      im.src = url;
    });
  }
  async function rotatePage(n) {
    if (!S.hasFile || !S.layout[n - 1]) return;
    flushSave();
    var sz = await sizeOf(n), k = sz.w / sz.h; // 回したあとの横幅は、今の高さ
    var e = JSON.parse(JSON.stringify(S.layout[n - 1]));
    if (e.src > 0) { e.rot = ((e.rot || 0) + 90) % 360; if (!e.rot) delete e.rot; }
    else { var w = e.w || A4.w; e.w = e.h || A4.h; e.h = w; }
    var out = [];
    for (var i = 0, list = S.strokes[n] || []; i < list.length; i++) {
      var it = JSON.parse(JSON.stringify(list[i]));
      delete it.link;
      if (it.tool === 'image') {
        var url = S.images[it.id] && await rotImage(S.images[it.id]);
        if (url) { var id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); S.images[id] = url; it.id = id; }
        var nx = r4(1 - (it.y + it.h)), ny = it.x, nw = it.h; it.h = it.w; it.w = nw; it.x = nx; it.y = ny;
      } else {
        it.points = it.points.map(rotXY);
        it.width = Math.round(it.width * k * 100) / 100;
      }
      out.push(it);
    }
    (S.notes[n] || []).forEach(function (t) { var nx = r4(1 - t.y); t.y = t.x; t.x = nx; }); // 付箋も一緒に回す
    S.layout[n - 1] = e;
    S.strokes[n] = out;
    S.undo = []; S.redo = []; S.cache = {};
    scheduleSave(n);
    emit('layout'); emit('data');
    var go = S.page; S.page = 0; goPage(go);
    setStatus(n + 'ページ目を右に90°回しました');
  }

  /* ページを削除する（n を省くと今のページ）。元のPDFのページも削除できる（Driveの元のPDFへの反映でも、そのページを外す） */
  function deletePage(n) {
    if (!S.hasFile) return;
    n = n || S.page;
    if (S.total <= 1) { setStatus('最後の1ページは削除できません'); return; }
    var e = S.layout[n - 1];
    if (!window.confirm(n + 'ページ目を、このスクラップブックから削除しますか？\n書き込みと付箋も一緒に消えます。（元の本はそのままです）')) return;
    var plan = samePlan(), cur = S.page;
    plan.splice(n - 1, 1);
    var go = Math.min(n, plan.length); plan.forEach(function (p, i) { if (p.from === cur) go = i + 1; });
    rearrange(plan, go, 'ページを削除しました');
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

  /* 縮小できる限界: 紙（見開きなら2ページぶん）と左右の小口が、画面の横幅にちょうど収まるところまで */
  function minZoom() {
    if (!S.cssW || !S.zoom) return 0.5;
    var w1 = flow.offsetWidth / S.zoom;
    var z = (stage.clientWidth - 2 * EDGE_ROOM) / w1;
    return Math.max(0.3, Math.min(1, Math.round(z * 100) / 100));
  }
  function tMetrics() {
    var ids = Object.keys(touches), a = touches[ids[0]], b = touches[ids[1]];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
  function startPinch() {
    var m = tMetrics(), rc = flow.getBoundingClientRect();
    pinch = { d0: m.d, cx0: m.cx, cy0: m.cy, cx: m.cx, cy: m.cy, z0: S.zoom, s: 1, min: minZoom(), pct: 0, raf: 0, t0: performance.now(),
      fx: (m.cx - rc.left) / rc.width, fy: (m.cy - rc.top) / rc.height };
    flow.style.transformOrigin = (pinch.fx * 100) + '% ' + (pinch.fy * 100) + '%';
    flow.classList.add('pinching'); // 紙を1枚の層にして、拡大縮小を軽く
  }
  // 指が動くたびではなく、画面の書きかえ1回につき1回だけ動かす（カクつかないように）
  function movePinch() {
    if (!pinch || pinch.raf) return;
    pinch.raf = requestAnimationFrame(function () {
      var p = pinch; if (!p) return;
      p.raf = 0;
      var m = tMetrics();
      var z = Math.min(MAXZOOM, Math.max(p.min, p.z0 * m.d / p.d0));
      p.s = z / p.z0; p.cx = m.cx; p.cy = m.cy;
      flow.style.transform = 'translate3d(' + (m.cx - p.cx0) + 'px,' + (m.cy - p.cy0) + 'px,0) scale(' + p.s + ')';
      var pct = Math.round(z * 100);
      if (pct !== p.pct) { p.pct = pct; flashPager(pct + '%'); }
    });
  }
  function clearPinchStyle() { flow.style.transform = ''; flow.style.transformOrigin = ''; flow.classList.remove('pinching'); }
  function cancelPinch() { if (pinch && pinch.raf) cancelAnimationFrame(pinch.raf); pinch = null; clearPinchStyle(); }
  function endPinch() {
    var p = pinch; cancelPinch();
    // 2本指で軽くたたいた（すぐ離して、ほとんど動いていない）: 拡大ではなく、元に戻す
    if (hooks.twoTap && performance.now() - p.t0 < 280 && Math.abs(p.s - 1) < 0.03 && Math.hypot(p.cx - p.cx0, p.cy - p.cy0) < 12) {
      hooks.twoTap(); return;
    }
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
  /* ぐちゃぐちゃ消し: ペンでジグザグに塗りつぶすように書くと、その下の線を消す（GoodNotesと同じ）
     横（または縦）に5回以上行ったり来たりして、ふれ幅が大きく、反対の向きにはあまり進まない線を「ぐちゃぐちゃ」とみなす */
  function swings(P, ax) { // 行ったり来たりの回数と、ふれ幅の平均
    var v0 = P[0][ax], hi = v0, lo = v0, dir = 0, ext = v0, from = v0, n = 0, sum = 0, HYS = 6;
    for (var i = 1; i < P.length; i++) {
      var v = P[i][ax];
      if (!dir) {
        hi = Math.max(hi, v); lo = Math.min(lo, v);
        if (hi - lo > HYS) { dir = v >= hi ? 1 : -1; from = dir > 0 ? lo : hi; ext = v; }
      } else if (dir > 0) {
        if (v > ext) ext = v; else if (ext - v > HYS) { n++; sum += ext - from; from = ext; dir = -1; ext = v; }
      } else {
        if (v < ext) ext = v; else if (v - ext > HYS) { n++; sum += from - ext; from = ext; dir = 1; ext = v; }
      }
    }
    return { n: n, mean: n ? sum / n : 0 };
  }
  function isScribble(st) {
    var W = S.cssW, H = S.cssH, P = st.points.map(function (p) { return [p[0] * W, p[1] * H]; });
    if (P.length < 12) return false;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, i;
    for (i = 0; i < P.length; i++) { x0 = Math.min(x0, P[i][0]); y0 = Math.min(y0, P[i][1]); x1 = Math.max(x1, P[i][0]); y1 = Math.max(y1, P[i][1]); }
    var sw = [x1 - x0, y1 - y0], ok = false;
    for (var ax = 0; ax < 2; ax++) {
      var r = swings(P, ax), span = sw[ax], perp = sw[1 - ax];
      if (span >= 12 && r.n >= 5 && r.mean >= span * 0.55 && perp <= span * 1.5) ok = true;
    }
    return ok ? { x0: x0, y0: y0, x1: x1, y1: y1, P: P } : false;
  }
  // ぐちゃぐちゃの下にある線を探す（線のまん中がぐちゃぐちゃの範囲に入っていて、実際に重なっているもの）
  function underScribble(sc, width) {
    var W = S.cssW, H = S.cssH, pad = 8, r = 5 + width;
    return pages().filter(function (s) {
      if (s.tool === 'image' || !s.points || !s.points.length) return false;
      var a = 1e9, b = 1e9, c = -1e9, d = -1e9;
      s.points.forEach(function (p) { a = Math.min(a, p[0] * W); b = Math.min(b, p[1] * H); c = Math.max(c, p[0] * W); d = Math.max(d, p[1] * H); });
      var cx = (a + c) / 2, cy = (b + d) / 2;
      if (cx < sc.x0 - pad || cx > sc.x1 + pad || cy < sc.y0 - pad || cy > sc.y1 + pad) return false;
      for (var i = 0; i < sc.P.length; i += 2) if (hit(s, sc.P[i][0], sc.P[i][1], r)) return true;
      return false;
    });
  }
  function eraseAt(pt) {
    var arr = pages(), px = pt[0] * S.cssW, py = pt[1] * S.cssH;
    var keep = arr.filter(function (s) { return !hit(s, px, py, S.eraser); });
    if (keep.length !== arr.length) {
      if (!erased) { pushUndo(S.page, S.spread && st ? st.n : 0); erased = true; }
      dropLinked(arr.filter(function (s) { return keep.indexOf(s) < 0; }));
      S.strokes[S.page] = keep; drawInk(); updateUI(); scheduleSave();
    }
  }
  // 蛍光ペンはまっすぐな線にする。ほぼ水平なら水平にそろえる
  function straight(a, b) {
    var dx = (b[0] - a[0]) * S.cssW, dy = (b[1] - a[1]) * S.cssH;
    if (Math.abs(dy) < Math.abs(dx) * 0.12) b = [b[0], a[1], b[2]];
    return [[a[0], a[1], 0.5], [b[0], b[1], 0.5]];
  }
  function drawLive() { pcDraw(); }
  function flushDraw() {
    rafId = 0;
    var s = S.live; if (!s || (s.points.length <= drawnIdx && s.tool !== 'highlighter')) return;
    drawLive(drawnIdx);
    drawnIdx = s.points.length;
    if (drawing && drawing.x) crossLive(drawing.x);
  }

  /* ---------- ページをめくる ----------
     指で左右になぞると、紙がめくれて、下からめくる先のページが見えてくる。
     - 縦画面: 左の端でとじたノートのように、今のページが左へめくれる（戻るときは前のページが左から戻ってくる）
     - 横画面（見開き）: 真ん中の背を軸に、右のページが左へ（戻るときは左のページが右へ）めくれる
     半分以上めくるか、さっと払うと、そのページへ移る。途中で離すと元に戻る */
  var T = null, turning = false;
  function div(cls, parent) { var d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; }
  function boxOf(node) { return { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight }; }
  function place(node, b) { node.style.left = b.x + 'px'; node.style.top = b.y + 'px'; node.style.width = b.w + 'px'; node.style.height = b.h + 'px'; }
  function fillFace(box, n) {
    var c = faceOf(n);
    if (c) { box.appendChild(c); return; }
    getBase(n).then(function (b) { if (box.isConnected && !box.querySelector('canvas')) box.appendChild(compose(n, b)); }, function () {});
  }
  function startTurn(dir) {
    if (S.vert || T || turning || !canStep(dir)) return null;
    var t = { dir: dir, dest: stepPage(dir), t: 0 };
    var wb = boxOf(wrap), sb = st && !still.hidden ? boxOf(still) : null, box, front, back = 0, under = null, origin;
    if (!S.spread) {
      box = wb; origin = 'left';
      if (dir > 0) { front = S.page; under = { b: wb, n: t.dest }; t.a0 = 0; t.a1 = -180; }
      else { front = t.dest; t.a0 = -180; t.a1 = 0; }
    } else {
      var actR = !isLeft(S.page), Lb = actR ? sb : wb, Rb = actR ? wb : sb, L = leftOf(S.page);
      if (dir > 0 ? !Rb : !Lb) return null;
      // 進む: 右のページ(L+1)がめくれ、裏に次の左(L+2)、下に次の右(L+3)。戻る: 左のページ(L)がめくれ、裏に前の右(L-1)、下に前の左(L-2)
      if (dir > 0) { box = Rb; origin = 'left'; front = L + 1; back = L + 2; under = { b: Rb, n: L + 3 <= S.total ? L + 3 : 0 }; t.a0 = 0; t.a1 = -180; }
      else { box = Lb; origin = 'right'; front = L; back = L - 1; under = { b: Lb, n: L - 2 >= 1 ? L - 2 : 0 }; t.a0 = 0; t.a1 = 180; }
    }
    turnEl.textContent = '';
    if (under) {
      t.u = div('tu' + (under.n ? '' : ' none'), turnEl); place(t.u, under.b);
      t.u.style.setProperty('--gd', origin === 'left' ? '90deg' : '270deg');
      if (under.n) fillFace(t.u, under.n);
    }
    t.lf = div('lf', turnEl); place(t.lf, box);
    t.lf.style.transformOrigin = origin === 'left' ? '0 50%' : '100% 50%';
    t.fF = div('fc', t.lf); t.fB = div('fc bk' + (back ? '' : ' blank'), t.lf);
    fillFace(t.fF, front); if (back) fillFace(t.fB, back);
    var sx = origin === 'left' ? box.x : box.x + box.w;
    turnEl.style.perspectiveOrigin = sx + 'px ' + (stage.scrollTop + stage.clientHeight / 2 - flow.offsetTop) + 'px';
    turnEl.classList.add('on');
    // めくれ具合の決め方: 縦画面は、見えている半分（右側）だけを使う。紙の端が指についてくる
    t.W = Math.min(box.w, stage.clientWidth);
    t.mode = S.spread ? 'spread' : dir > 0 ? 'fwd' : 'back';
    t.rest = t.mode === 'back' ? 0.5 : 0;                       // 戻すときの位置（縦画面で戻るときは、背に立った状態＝見えない）
    t.go = t.mode === 'fwd' ? 0.24 : t.mode === 'back' ? 0.6 : 0.3; // ここを越えて離したら、めくる
    t.t = t.rest;
    T = t; turning = true;
    drawTurn();
    return t;
  }
  function drawTurn() {
    var t = T, a = t.a0 + (t.a1 - t.a0) * t.t, back = Math.abs(a) > 90;
    t.lf.style.transform = 'rotateY(' + a.toFixed(2) + 'deg)';
    t.fF.style.visibility = back ? 'hidden' : '';
    t.fB.style.visibility = back ? '' : 'hidden';
    t.lf.style.setProperty('--sh', (0.1 * Math.sin(Math.abs(a) * Math.PI / 180)).toFixed(3)); // 立っているほど少し暗く
    if (t.u) t.u.style.setProperty('--sh', (0.32 * (1 - t.t)).toFixed(3));              // めくっている紙の影
  }
  // 指の動きから、めくれ具合を決める（紙の端が指についてくるように）
  function turnFollow(dx) {
    var p = Math.max(0, -dx * T.dir), W = T.W, c;
    if (T.mode === 'fwd') { c = Math.max(0, 1 - 1.3 * p / W); T.t = Math.acos(c) / Math.PI; }
    else if (T.mode === 'back') { c = Math.min(1, 1.3 * p / W); T.t = 1 - Math.acos(c) / Math.PI; }
    else { c = Math.max(-1, 1 - 1.8 * p / W); T.t = Math.acos(c) / Math.PI; }
    drawTurn();
  }
  /* 指を離したあとの続き。vt: 離したときのめくれる速さ（1ミリ秒あたりの t）
     - 指で勢いよく払った: その速さのまま続けて、だんだんゆっくり止まる（速く払えば速くめくれる）
     - ボタン・引っぱり・ゆっくり離した: 紙がめくれていく様子が見える速さで */
  function settleTurn(go, vt) {
    var t = T; if (!t || t.anim) return;
    t.anim = true;
    var from = t.t, to = go ? 1 : t.rest, d = Math.abs(to - from), t0 = performance.now(), dur, ease;
    var auto = vt === undefined;
    if (go && t.fast) {
      dur = Math.max(70, 180 - 20 * t.fast);                 // 小口を押さえたままの連続めくり: だんだん速く
      ease = function (k) { return k; };
    } else if (go && vt > 0.0005) {
      dur = Math.max(60, Math.min(180, 1.0 * d / vt));          // 指の速さの倍で始まり、減速して止まる
      ease = function (k) { return 1 - (1 - k) * (1 - k); };
    } else if (go && auto) {
      dur = 80 + 150 * d;                                    // 全部めくって 0.23秒くらい
      ease = function (k) { return k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k); }; // ゆっくり始まって、ゆっくり止まる
    } else {
      dur = 70 + 140 * d;
      ease = function (k) { return 1 - (1 - k) * (1 - k); };
    }
    var y0 = stage.scrollTop, y1 = go && !S.spread ? 0 : y0; // 縦画面では、次のページの上の端から
    t.step = function step(now) {
      if (t.done) return;
      var k = t.rush ? 1 : Math.min(1, (now - t0) / dur), e = ease(k);
      t.t = from + (to - from) * e; drawTurn();
      if (y1 !== y0) stage.scrollTop = y0 + (y1 - y0) * e;
      if (k < 1) { requestAnimationFrame(step); return; }
      t.done = true;
      if (!go) { closeTurn(); return; }
      // めくった先へ。めくってきた絵を出したまま入れかえるので、見た目はつながる
      S.placeholder = baseNow(t.dest) || quickNow(t.dest);
      var close = function () { if (T === t) closeTurn(); }; // あとから届いても、次のめくりは閉じない
      S.swap = close;
      turning = false; // goPage を通すため（置きかえが済むまでは T が残っている）
      Promise.resolve(goPage(t.dest, true)).catch(function () {}).then(close);
      // 次の紙の描画がなかなか終わらなくても、めくりが止まったままにならないように
      setTimeout(function () { if (T === t) { dbg('!! めくりの置きかえが遅いので打ち切り'); if (S.swap === close) S.swap = null; closeTurn(); } }, 1500);
    };
    requestAnimationFrame(t.step);
  }
  // めくっている最中に次の操作が来たら、今のめくりをその場で終わらせる
  function rushTurn() { if (T && T.anim && !T.done) { T.rush = true; T.step(performance.now()); } }
  function closeTurn() {
    T = null; turning = false; turnEl.classList.remove('on'); turnEl.textContent = '';
    if (rapid) requestAnimationFrame(rapidNext); // 小口を押さえたまま: 次々めくる
    else if (pan && pan.want) requestAnimationFrame(chainTurn); // 次のめくりを待っている指がある
    else if (queued) { var d = queued > 0 ? 1 : -1; queued -= d; requestAnimationFrame(function () { if (startTurn(d)) settleTurn(true); else queued = 0; }); }
  }
  /* 続けてめくる: めくっている最中に、また指で払ったとき。
     今のめくりを終わらせて、ページが入れかわりしだい、次のめくりを指につける */
  var queued = 0; // 入れかわる前に払った回数（進む: +、戻る: -）
  /* 小口を長押し: 押さえている間、次々にページがめくれる（だんだん速く）。軽くたたくと1ページ */
  var rapid = null, EDGE_HOLD = 250;
  /* めくるときに見える紙のページ（k: 何回先のめくりか。0 = 次のめくり） */
  function turnPages(dir, k) {
    var L = S.spread ? leftOf(S.page) : S.page, o = k * 2, list;
    if (S.spread) list = dir > 0 ? [L + 2 + o, L + 3 + o] : [L - 1 - o, L - 2 - o];
    else list = [S.page + dir * (1 + k)];
    return list.filter(function (n) { return n >= 1 && n <= S.total; });
  }
  // 連続めくりの間は、先の3回ぶんの軽い絵を順に用意しておく
  function ahead(dir) {
    turnPages(dir, 1).concat(turnPages(dir, 2), turnPages(dir, 3)).filter(function (n) { return !baseNow(n) && !quickNow(n); }).reduce(function (p, n) {
      return p.then(function () { return getQuick(n); }).catch(function () {});
    }, Promise.resolve());
  }
  function stepsTo(n) { return S.spread ? Math.round((leftOf(n) - leftOf(S.page)) / 2) : n - S.page; }
  function rapidNext() {
    if (!rapid || T || turning) return;
    if (rapid.target) { // 下のバー: 指の位置のページへ向かってめくる
      var k = stepsTo(rapid.target);
      if (!k) { if (rapid.done) rapid = null; return; }
      if (rapid.done && Math.abs(k) > 3) { var tg = rapid.target; rapid = null; goPage(tg); return; } // 離したあと遠ければ、ひと息に
      var d = k > 0 ? 1 : -1;
      if (d !== rapid.dir) { rapid.dir = d; rapid.n = 0; }
    }
    // 次にめくる紙の絵がまだなら、描けるまで待ってからめくる（白い紙が見えないように）
    var need = turnPages(rapid.dir, 0).filter(function (n) { return !baseNow(n) && !quickNow(n); });
    if (need.length) {
      if (rapid.wait) return;
      var r0 = rapid; r0.wait = true;
      Promise.all(need.map(function (n) { return getQuick(n).catch(function () {}); })).then(function () {
        if (rapid !== r0) return;
        r0.wait = false; rapidNext();
      });
      return;
    }
    var t = startTurn(rapid.dir);
    if (!t) { rapid = null; return; } // 端まで来た
    ahead(rapid.dir);
    t.fast = rapid.target && Math.abs(k) > 2 ? Math.max(6, ++rapid.n) : ++rapid.n;
    settleTurn(true);
  }
  /* 下のバー: なぞった位置のページまで、パラパラめくる。離すとそこで止まる */
  var scrubG = null;
  function labelOf(n) { var m = S.spread ? partner(n) : 0; return (m ? Math.min(n, m) + '-' + Math.max(n, m) : n) + ' / ' + S.total; }
  function markAt(n) { scrubMark.style.left = (S.total > 1 ? (n - 1) / (S.total - 1) * 100 : 50) + '%'; }
  function scrubAt(x) {
    var r = scrub.getBoundingClientRect(), f = Math.min(1, Math.max(0, (x - r.left) / (r.width || 1)));
    var n = Math.round(1 + f * (S.total - 1));
    markAt(n);
    if (n === scrubG.n) return;
    scrubG.n = n; flashPager(labelOf(n));
    if (!rapid || !rapid.target) rapid = { dir: 0, n: 0, target: n }; else rapid.target = n;
    if (!T && !turning) rapidNext();
  }
  scrub.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (scrubG || !S.hasFile) return;
    try { scrub.setPointerCapture(e.pointerId); } catch (er) {}
    scrubG = { id: e.pointerId, n: 0 }; scrub.classList.add('press');
    scrubAt(e.clientX);
  });
  scrub.addEventListener('pointermove', function (e) { if (scrubG && e.pointerId === scrubG.id) scrubAt(e.clientX); });
  function scrubEnd(e) {
    if (!scrubG || e.pointerId !== scrubG.id) return;
    scrubG = null; scrub.classList.remove('press');
    if (rapid && rapid.target) { rapid.done = true; if (!T && !turning) rapidNext(); }
    if (!rapid) markAt(S.page);
  }
  scrub.addEventListener('pointerup', scrubEnd);
  scrub.addEventListener('pointercancel', scrubEnd);
  scrub.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  [edgeL, edgeR].forEach(function (el) {
    var hold = null;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (hold || !S.hasFile) return;
      try { el.setPointerCapture(e.pointerId); } catch (er) {}
      var dir = +el.dataset.dir;
      el.classList.add('press');
      hold = { id: e.pointerId, dir: dir, timer: setTimeout(function () {
        hold.long = true;
        if (scrubG) return;
        rapid = { dir: dir, n: 0 };
        if (T) rushTurn(); else rapidNext();
      }, EDGE_HOLD) };
    });
    function up(e) {
      if (!hold || e.pointerId !== hold.id) return;
      clearTimeout(hold.timer); el.classList.remove('press');
      if (!hold.long && e.type === 'pointerup') { if (T || turning) queued += hold.dir; else autoTurn(hold.dir); }
      hold = null; rapid = null;
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });
  function chainTurn() {
    if (!pan || !pan.want || pan.turn || T || turning) return;
    var dir = pan.want;
    if (startTurn(dir)) { pan.want = 0; pan.turn = { x0: pan.x0, hist: [] }; if (pan.last) turnMove(pan.last); }
    else pan.want = 0;
  }
  // ボタンや引っぱりから: 自動でめくる
  function autoTurn(dir) {
    if (S.vert) { if (canStep(dir)) goPage(stepPage(dir)); return; }
    if (startTurn(dir)) settleTurn(true);
  }

  /* ---------- 下の端で引っぱって次のページへ ----------
     ページの下の端で、さらに指を上へ引っぱる → 次のページ（めくって移る）
     上の端で下へ引っぱって前のページへ行くのは、ユーザーの希望でなくした（2026-11-18。上の端では何も起きない） */
  var pullEl = $('pull'), PULL_MAX = 150, PULL_READY = 64;
  function pullKind(dir) { return dir > 0 && canStep(1) ? 'next' : null; } // 本は、最後のページで引っぱってもページを足さない
  var PULL_TEXT = {
    next: ['引っぱると次のページ', '離すと次のページへ'],
    add: ['引っぱるとページを追加', '離すとページを追加']
  };
  function setFlow(y) { flow.style.transform = y ? 'translateY(' + y + 'px)' : ''; }
  // pull: 引っぱった量（正: 上へ、負: 下へ）。紙をゴムのように少し動かし、案内を出す
  function showPull(p) {
    var off = (p > 0 ? 1 : -1) * Math.min(PULL_MAX, Math.abs(p) * 0.5);
    setFlow(p ? -off : 0);
    var kind = p ? pullKind(p) : null;
    if (!kind) { pullEl.className = ''; return null; }
    var ready = Math.abs(off) >= PULL_READY;
    pullEl.className = 'show ' + kind + (p < 0 ? ' top' : '') + (ready ? ' ready' : '');
    pullEl.style.setProperty('--k', Math.min(1, Math.abs(off) / PULL_READY).toFixed(2));
    setText($('pullText'), PULL_TEXT[kind][ready ? 1 : 0]);
    return ready ? kind : null;
  }
  function panMove(e) {
    if (pan.turn) { turnMove(e); return; }
    if (pan.want) { pan.last = e; chainTurn(); return; } // 入れかわりを待っている
    if (!pan.axis) {
      // 動き始めの向きで決める: 横 → (横スクロールが端なら) めくる / それ以外 → スクロール
      // 拡大していないときは、いつも端なので、横に払えばめくれる
      // 拡大しているときは、紙の端までスクロールしてから、もう一度払うとめくれる
      var ax = e.clientX - pan.x0, ay = e.clientY - pan.y0;
      if (Math.hypot(ax, ay) < 10) return;
      pan.axis = Math.abs(ax) > Math.abs(ay) ? 'x' : 'y';
      var busy = !!T;
      if (busy) rushTurn(); // 前のめくりが終わっていなければ、すぐ終わらせる
      if (pan.axis === 'x') {
        var dir = ax < 0 ? 1 : -1;
        if (busy && (dir > 0 ? pan.atR : pan.atL) && (T || turning)) { pan.want = dir; pan.last = e; return; }
        if ((dir > 0 ? pan.atR : pan.atL) && startTurn(dir)) {
          pan.turn = { x0: pan.x0, hist: [] };
          turnMove(e); return;
        }
      }
    }
    var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    pan.x = e.clientX; pan.y = e.clientY;
    stage.scrollLeft -= dx;
    var want = -dy; // 正: 下へスクロールしたい
    if (pan.pull) { // 引っぱっている最中は、まず引っぱりを戻す
      var np = pan.pull + want;
      if ((pan.pull > 0) !== (np > 0) || np === 0) { want = np; pan.pull = 0; } else { pan.pull = np; want = 0; }
    }
    var now = performance.now();
    (pan.vh || (pan.vh = [])).push([now, e.clientX, e.clientY]); while (pan.vh.length > 8) pan.vh.shift();
    markScroll();
    if (want) {
      var before = stage.scrollTop;
      stage.scrollTop += want;
      var rest = want - (stage.scrollTop - before); // 端まで来て、スクロールしきれなかった分
      if (rest > 0.5 && pan.atB) pan.pull += rest;
    }
    if (pan.pull || pan.ready !== undefined) pan.ready = showPull(pan.pull);
    checkVert();
  }
  /* 指を離したあとも、勢いのままスクロールが続いて、だんだん止まる（惰性） */
  var fl = null;
  // 勢いの強さ（「その他」で選ぶ。この端末に覚える）: 0 なし / 1 弱め / 2 ふつう / 3 強め
  // tau: 減速の速さ（大きいほど長く流れる）、gain: 離したときの速さにかける数
  var FLING = [null, { tau: 200, gain: 0.8 }, { tau: 325, gain: 1 }, { tau: 480, gain: 1.15 }], flingLv = 2;
  try { var fv = localStorage.getItem('dk:ui:fling'); if (fv !== null && FLING.hasOwnProperty(+fv)) flingLv = +fv; } catch (e) {}
  function setFling(v) {
    flingLv = Math.max(0, Math.min(3, v | 0));
    try { localStorage.setItem('dk:ui:fling', String(flingLv)); } catch (e) {}
    if (!FLING[flingLv]) stopFling();
  }
  function stopFling() { if (fl) { cancelAnimationFrame(fl.raf); fl = null; } }
  function fling(p) {
    stopFling();
    var h = (p.vh || []).filter(function (x) { return performance.now() - x[0] < 100; });
    if (h.length < 2) return;
    var a = h[0], b = h[h.length - 1], dt = Math.max(8, b[0] - a[0]);
    var vx = -(b[1] - a[1]) / dt, vy = -(b[2] - a[2]) / dt; // 1ミリ秒あたり（正: 下・右へスクロール）
    var cfgF = FLING[flingLv];
    if (!cfgF || (Math.abs(vy) < 0.25 && Math.abs(vx) < 0.25)) return;
    vx *= cfgF.gain; vy *= cfgF.gain;
    var last = performance.now(), f = fl = { vx: vx, vy: vy, y: stage.scrollTop, x: stage.scrollLeft, tau: cfgF.tau };
    f.sy = stage.scrollTop; f.sx = stage.scrollLeft;
    f.raf = requestAnimationFrame(function step(now) {
      if (fl !== f) return;
      var d = Math.min(40, now - last); last = now;
      // 位置は小数で持つ（1回に1ピクセル未満しか動かないときも、止まらずに進むように）。
      // ページの入れかえでスクロール位置がずれたら、そのぶんを足す
      f.y += stage.scrollTop - f.sy || 0; f.x += stage.scrollLeft - f.sx || 0;
      f.y += f.vy * d; f.x += f.vx * d;
      var maxY = stage.scrollHeight - stage.clientHeight, maxX = stage.scrollWidth - stage.clientWidth;
      if (f.y <= 0 || f.y >= maxY) { f.y = Math.max(0, Math.min(maxY, f.y)); f.vy = 0; } // 端まで来た
      if (f.x <= 0 || f.x >= maxX) { f.x = Math.max(0, Math.min(maxX, f.x)); f.vx = 0; }
      stage.scrollTop = f.y; stage.scrollLeft = f.x;
      markScroll();
      var k = Math.exp(-d / f.tau); f.vy *= k; f.vx *= k;
      // ページが入れかわると、見た目を変えないようにスクロール位置が動く。そのぶんを、持っている位置にも足す
      // （足さないと、次の回に元の位置へ戻され、1ページずつ先へ飛び続けていた。2026-11-15）
      var b = stage.scrollTop;
      checkVert();
      f.y += stage.scrollTop - b;
      f.sy = stage.scrollTop; f.sx = stage.scrollLeft;
      if (Math.abs(f.vy) < 0.015 && Math.abs(f.vx) < 0.015) { fl = null; return; }
      f.raf = requestAnimationFrame(step);
    });
  }
  function turnMove(e) {
    var g = pan.turn, now = performance.now();
    if (T && !T.anim) turnFollow(e.clientX - g.x0);
    g.hist.push([now, e.clientX, T ? T.t : 0]); while (g.hist.length > 8) g.hist.shift();
  }
  // 指を離したとき: 半分以上めくったか、めくる向きにさっと払っていれば移る
  function turnUp(g, cancel) {
    if (!T || T.anim) return;
    if (cancel) { settleTurn(false); return; }
    // 離す直前（0.1秒）の動きから、指の速さ（px/ms）と、めくれる速さ（t/ms）を出す
    var h = g.hist, now = performance.now(), v = 0, vt = 0;
    var r = h.filter(function (x) { return now - x[0] < 100; });
    if (r.length > 1) {
      var a = r[0], b = r[r.length - 1], dt = Math.max(8, b[0] - a[0]);
      v = (b[1] - a[1]) / dt * -T.dir; vt = (b[2] - a[2]) / dt;
    }
    var go = v > 0.25 ? T.t > T.rest + 0.01 : v < -0.3 ? false : T.t > T.go;
    // 払った速さが紙の動きより速いとき（指が紙より先に行った）は、指の速さで続ける
    if (go && v > 0.25) vt = Math.max(vt, v / (T.W * (T.mode === 'spread' ? 1.1 : 1.6)));
    settleTurn(go, vt);
  }
  function settle() { setTimeout(function () { flow.style.transition = ''; }, 460); }
  function endPull(p, cancel) {
    var kind = cancel ? null : p.ready;
    pullEl.classList.remove('show', 'ready');
    flow.style.transition = 'transform .32s cubic-bezier(.2,1.3,.4,1)';
    if (kind === 'add') { addTurn(); return; }
    setFlow(0); settle();
    if (kind) autoTurn(1);
  }
  // 最後のページで引っぱったとき: ページを足して、にゅっと出す
  function addTurn() {
    var h = stage.clientHeight;
    turning = true;
    flow.style.transition = 'transform .18s ease-in, opacity .18s ease-in';
    setFlow(-h * 0.5); flow.style.opacity = '0';
    setTimeout(function () {
      flow.style.transition = 'none';
      turning = false;
      var done = insertPage('same');
      turning = true;
      flow.style.transform = 'translateY(' + (h * 0.45) + 'px) scale(.9)';
      Promise.resolve(done).catch(function () {}).then(function () {
        void flow.offsetWidth; // 置いた位置を確定させてから動かす
        flow.style.transition = 'transform .46s cubic-bezier(.2,1.25,.35,1), opacity .2s ease-out';
        setFlow(0); flow.style.opacity = '';
        turning = false; settle();
      });
    }, 180);
  }

  /* 指1本を離したとき: 2回タップ → 拡大・元に戻す */
  var lastTap = null;
  function fingerUp(p, e) {
    var dx = e.clientX - p.x0, dy = e.clientY - p.y0, dt = performance.now() - p.t0;
    if (dt < 300 && Math.hypot(dx, dy) < 12) {
      if (hooks.tap && hooks.tap(e)) { lastTap = null; return; } // 付箋を貼った・開いた
      var now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = null;
        var rc = flow.getBoundingClientRect();
        S.anchor = { fx: (e.clientX - rc.left) / rc.width, fy: (e.clientY - rc.top) / rc.height, cx: e.clientX, cy: e.clientY };
        setZoom(Math.abs(S.zoom - 1) < 0.01 ? 2 : 1);
        return;
      }
      var lt = lastTap = { t: now, x: e.clientX, y: e.clientY };
      // 2回目が来なければ「1回たたいた」（流れているスクロールを止めたたたき・めくりの最中は数えない）
      if (hooks.singleTap && !p.fling && !T && !turning) {
        setTimeout(function () { if (lastTap === lt) { lastTap = null; hooks.singleTap(lt.x, lt.y); } }, 360);
      }
    } else lastTap = null;
  }

  /* ペンを離した知らせが届かず「書いている最中」のまま残ると、指もペンも効かなくなる。
     4秒以上まったく動いていなければ、離したことにして線を確定させる */
  var drawAt = 0, drawLast = null;
  function dropStaleDrawing(e) {
    if (!drawing || e.pointerId === drawing.id || performance.now() - drawAt < 4000) return;
    dbg('!! 離した知らせが届かなかった線#' + drawing.id + 'を確定');
    var l = drawLast || e;
    endPointer({ pointerId: drawing.id, type: 'pointerup', pointerType: l.pointerType, clientX: l.clientX, clientY: l.clientY, pressure: l.pressure });
    lastPenUp = 0; // ペンはずっと前に離れているので、いまの指を手のひらとして無視しない
  }
  function onInkDown(e) {
    if (!S.hasFile) return;
    e.preventDefault();
    var wasFling = !!fl;
    stopFling();
    dropStaleDrawing(e);
    // 指はスクロール・ページめくり（1本で横に払う）・拡大縮小（2本）に使う（書くのはペンだけ）
    if (e.pointerType === 'touch') {
      if (drawing || performance.now() - lastPenUp < 500) { // 手のひらの接触は無視
        dbg('指#' + e.pointerId + ' 無視（' + (drawing ? 'ペンで書いている最中' : 'ペンを離した直後') + '）');
        return;
      }
      // 1本目の指なのに、前の指が残っている（離した知らせが届かなかった）: 片づけてから始める
      if (e.isPrimary && Object.keys(touches).length) {
        dbg('!! 離れたはずの指が残っていたので片づけ');
        touches = {};
        if (pinch) cancelPinch();
        if (pan && pan.turn) turnUp(pan.turn, true);
        else if (pan && pan.pull) endPull(pan, true);
        pan = null;
      }
      if (T && !T.anim && !pan) settleTurn(false); // 指が離れたのに途中で止まっているめくり: 戻す
      if (turning && !(T && T.anim)) return; // めくっている最中の指は、続けてめくれるように受け付ける
      // 付箋は、どの道具のときでも、指でつかんで動かせる
      var gh = tools.note;
      if (gh && gh.grab && !Object.keys(touches).length) {
        S.rc = ink.getBoundingClientRect();
        if (gh.grab(pos(e), e)) {
          drawing = { id: e.pointerId, h: gh, touch: true }; drawAt = performance.now(); drawLast = e;
          try { ink.setPointerCapture(e.pointerId); } catch (er) {}
          return;
        }
      }
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { ink.setPointerCapture(e.pointerId); } catch (er) {}
      var n = Object.keys(touches).length;
      dbg('指#' + e.pointerId + ' 接触 → ' + (n === 1 ? 'スクロール扱い' : n === 2 ? 'ピンチ扱い' : n + '本目'));
      if (n === 1) {
        pan = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(),
          // 払う前に、横スクロールが端まで来ていたか（端なら、払うとページをめくる）
          atL: stage.scrollLeft <= 1, atR: stage.scrollLeft >= stage.scrollWidth - stage.clientWidth - 1,
          // 縦も同じ: 端まで来てから引っぱると、ページを移る
          atT: stage.scrollTop <= 1, atB: stage.scrollTop >= stage.scrollHeight - stage.clientHeight - 1, pull: 0, fling: wasFling };
        if (hooks.hold) {
          var hp = pan;
          hp.holdT = setTimeout(function () {
            hp.holdT = 0;
            if (pan !== hp || hp.axis || hp.turn || hp.pull || T || turning || drawing || Object.keys(touches).length !== 1) return;
            var hh = hooks.hold(hp.x0, hp.y0);
            if (!hh) return;
            dbg('指#' + hp.id + ' 長押し → つかむ');
            pan = null; delete touches[hp.id]; lastTap = null;
            drawing = { id: hp.id, h: hh, touch: true }; drawAt = performance.now();
          }, 450);
        }
      }
      else if (n === 2) {
        if (pan) clearTimeout(pan.holdT);
        if (pan && pan.turn) turnUp(pan.turn, true);
        else if (pan && pan.pull) endPull(pan, true);
        pan = null; startPinch();
      }
      return;
    }
    if (turning) return; // ページを移っている最中は書かない
    if (drawing) { dbg('!! ペン#' + e.pointerId + ' 無視（前の線#' + drawing.id + 'が終わっていない）'); return; }
    dbg('ペン#' + e.pointerId + '(' + e.pointerType + ') 書き始め' + (Object.keys(touches).length ? '（指' + Object.keys(touches).length + '本を解除）' : ''));
    if (pan && pan.pull) endPull(pan, true);
    pan = null; touches = {}; if (pinch) cancelPinch();
    drawAt = performance.now(); drawLast = e;
    try { ink.setPointerCapture(e.pointerId); } catch (er) {}
    S.rc = ink.getBoundingClientRect(); // 書き始めに1回だけ取得
    var pt = pos(e);
    // ペンが付箋に触れたら、どの道具のときでも付箋を扱う（軽くたたくと開く・引っぱると動く）
    // スクラップの「一部を切り抜く」の最中は、ペンは囲むのに使う（scrap.js が hooks.penGrab を置く）
    var onNote = !hooks.penGrab && hooks.noteAt ? hooks.noteAt(pt) : null;
    var h = hooks.penGrab || (onNote ? tools.note : tools[S.tool]);
    if (h) { drawing = { id: e.pointerId, h: h }; h.down(pt, e, onNote); return; }
    if (S.tool === 'eraser') { drawing = { id: e.pointerId, erase: true }; erased = false; eraseAt(pt); return; }
    if (!PENS[S.tool]) return;
    S.live = { tool: S.tool, color: S.color, width: S.width, points: [pt] };
    drawing = { id: e.pointerId, start: pt, x: crossStart() };
    drawnIdx = 1;
    pcStart();
    drawLive(0);
  }
  ink.addEventListener('pointerdown', onInkDown);
  // 見開きのもう片方（絵）: ペンが触れたら、そのページを書ける紙にしてそのまま書き始める。指はふつうに扱う
  still.addEventListener('pointerdown', function (e) {
    if (!S.hasFile || !st) return;
    e.preventDefault();
    if (e.pointerType !== 'touch') {
      if (drawing || turning) return;
      if (!(S.vert ? goVert(st.n) : activate(st.n))) return;
    }
    onInkDown(e);
  });
  // 縦スクロールの上のページ: 同じく、ペンが触れたら書ける紙にする
  upEl.addEventListener('pointerdown', function (e) {
    if (!S.hasFile || !upSt) return;
    e.preventDefault();
    if (e.pointerType !== 'touch') {
      if (drawing || turning) return;
      if (!goVert(upSt.n)) return;
    }
    onInkDown(e);
  });
  upEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  still.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  function onInkMove(e) {
    if (touches[e.pointerId]) {
      touches[e.pointerId].x = e.clientX; touches[e.pointerId].y = e.clientY;
      if (pinch && Object.keys(touches).length === 2) { movePinch(); return; }
    }
    if (pan && e.pointerId === pan.id) {
      if (pan.holdT && Math.hypot(e.clientX - pan.x0, e.clientY - pan.y0) >= 10) { clearTimeout(pan.holdT); pan.holdT = 0; }
      panMove(e); return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    e.preventDefault();
    drawAt = performance.now(); drawLast = e;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    if (drawing.h) { evs.forEach(function (ev) { drawing.h.move(pos(ev), ev); }); return; }
    if (drawing.erase) { evs.forEach(function (ev) { eraseAt(pos(ev)); }); return; }
    if (drawing.shaped) return; // 図形に直したあとは、離すまでそのまま
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
    holdWatch(e);
  }
  ink.addEventListener('pointermove', onInkMove);
  /* 書いたあと、ペンを離さずに止めておくと（約1秒）、きれいな図形に直す */
  var SHAPE_HOLD = 1000;
  function holdWatch(e) {
    var d = drawing; if (!d || !S.live || S.live.tool === 'highlighter') return;
    if (d.hx !== undefined && Math.hypot(e.clientX - d.hx, e.clientY - d.hy) < 4) return; // ほぼ止まっている
    d.hx = e.clientX; d.hy = e.clientY;
    clearTimeout(d.holdT);
    d.holdT = setTimeout(function () { holdShape(d); }, SHAPE_HOLD);
  }
  function holdShape(d) {
    if (drawing !== d || d.shaped || !S.live || !window.Shapes) return;
    var s = S.live, fixed = Shapes.recognize(s.points, S.cssW, S.cssH);
    if (!fixed) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    s.points = fixed; d.shaped = true;
    drawLive(0); drawnIdx = s.points.length;
    if (d.x) crossLive(d.x);
  }
  function endPointer(e) {
    if (touches[e.pointerId]) {
      dbg('指#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '取り消し' : '離す'));
      delete touches[e.pointerId];
      if (pinch) { if (e.type === 'pointerup') endPinch(); else cancelPinch(); }
      if (pan && pan.id === e.pointerId) {
        clearTimeout(pan.holdT);
        if (pan.turn) turnUp(pan.turn, e.type !== 'pointerup');
        else if (pan.want) { if (e.type === 'pointerup') { if (T || turning) queued += pan.want; else autoTurn(pan.want); } } // 入れかわる前に離した: そのままめくる
        else if (pan.pull || pan.ready) endPull(pan, e.type !== 'pointerup');
        else if (e.type === 'pointerup') { fingerUp(pan, e); fling(pan); }
        pan = null;
      }
      return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    dbg('ペン#' + e.pointerId + ' ' + (e.type === 'pointercancel' ? '!! 取り消し（OSに中断された）' : '離す') +
      (S.live ? '（' + S.live.points.length + '点）' : ''));
    if (drawing.h) {
      var h = drawing.h, byFinger = drawing.touch; drawing = null;
      if (!byFinger) lastPenUp = performance.now();
      h.up(e);
      return;
    }
    if (!drawing.erase && S.live) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flushDraw();
      var s = S.live;
      // ぐちゃぐちゃ消し: 下に線があれば、その線を消して、ぐちゃぐちゃ自体も残さない
      if ((s.tool === 'pen' || s.tool === 'pencil') && !drawing.shaped) {
        var sc = isScribble(s), gone = sc ? underScribble(sc, widthAt(s, S.cssW, 1) / 2) : [];
        if (gone.length) {
          pushUndo(S.page, S.spread && st ? st.n : 0);
          dropLinked(gone); if (drawing.x) refreshStillInk(); // はみ出して描いた所も消す
          S.strokes[S.page] = pages().filter(function (x) { return gone.indexOf(x) < 0; });
          S.live = null;
          pcClear();
          drawInk(); updateUI(); scheduleSave(); emit('data');
          drawing = null; lastPenUp = performance.now();
          return;
        }
      }
      // 図形モード: 手書きの丸・四角・三角・直線を、きれいな図形に直す
      var fixed = drawing.shaped || null; clearTimeout(drawing.holdT);
      if (!fixed && S.shape && s.tool !== 'highlighter' && window.Shapes) {
        fixed = Shapes.recognize(s.points, S.cssW, S.cssH);
        if (fixed) s.points = fixed;
      }
      var xo = drawing.x && crosses(drawing.x, s) ? drawing.x : null;
      pushUndo(S.page, xo ? xo.n : 0);
      (S.strokes[S.page] = S.strokes[S.page] || []).push(s);
      if (xo) { // もう片方のページにも写しを入れる
        s.link = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        (S.strokes[xo.n] = S.strokes[xo.n] || []).push({ tool: s.tool, color: s.color, width: s.width, points: crossPts(xo, s.points), link: s.link });
        scheduleSave(xo.n); refreshStillInk();
      }
      S.live = null;
      drawItem(ictx, s, ink.width, ink.height); hiAdd(s);
      pcClear();
      updateUI(); scheduleSave(); emit('data');
    }
    drawing = null;
    lastPenUp = performance.now();
  }
  ink.addEventListener('pointerup', endPointer);
  ink.addEventListener('pointercancel', endPointer);
  /* 見開きのもう片方（still）・縦スクロールの上のページ（upEl）で始まった指は、書ける紙（ink）に捕まえ直しているが、
     iPad では指の動き・離した知らせが、始まった部品のほうに届くことがある。
     届かないと、右のページをたたいても「1回たたいた」にならず、全画面で道具の帯が出なかった（2026-11-18） */
  [still, upEl].forEach(function (el) {
    el.addEventListener('pointermove', onInkMove);
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
  });
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
    openDoc: openDoc, closeDoc: closeDoc, setStatus: setStatus, pageText: pageText, dbg: dbg, hooks: hooks, flashPager: flashPager,
    activate: activate, pageAt: pageAt, focusPage: focusPage, pageInfo: pageInfo, capturePage: capturePage, r4: r4, nid: nid,
    stillPage: function () { return st && !still.hidden ? st.n : 0; }, stillEl: still, refreshStillInk: refreshStillInk,
    busy: function () { return !!(drawing || turning); },
    drawInk: drawInk, drawList: drawList, renderPage: renderPage, renderThumb: renderThumb, repaint: repaint,
    goPage: goPage, updateUI: updateUI, pushUndo: pushUndo, commit: commit,
    scheduleSave: scheduleSave, flushSave: flushSave, exportData: exportData,
    setTool: setTool, insertPage: insertPage, deletePage: deletePage, movePage: movePage, rotatePage: rotatePage, addPageAt: addPageAt, duplicatePage: duplicatePage, clearPageAt: clearPageAt, addImage: addImage,
    setShift: setShift, setVert: setVert, setFling: setFling, flingLevel: function () { return flingLv; },
    setScrub: setScrub, scrubOn: function () { return scrubOn; },
    pageEntry: entry, paperLines: paperLines, liveCtx: lctx, liveCanvas: lc, wrap: wrap, stage: stage,
    currentKey: function () { return S.hasFile ? S.key : ''; },
    hasStrokes: function () {
      for (var k in S.strokes) if (S.strokes[k].length) return true;
      for (var q in S.notes) if (S.notes[q].length) return true;
      return false;
    },
    exportJson: function () { return JSON.stringify(exportData()); },
    // 外から受け取った手書きデータで置き換える（取り消し履歴は消える）
    replaceData: function (obj) {
      var res = parseData(obj); if (!res) return false;
      if (drawing) return false;
      applyData(res);
      if (st) st.n = -1; // 見開きのもう片方も描き直す
      clearTimeout(saveTimer); saveTimer = null;
      renderPage(); updateUI(); doSave(true); emit('layout'); emit('data');
      return true;
    }
  };
})();
