/* 投げ縄（囲んで選ぶ → 動かす・大きさを変える・複製・削除）と、レーザーポインター */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var lc = App.liveCanvas, lctx = App.liveCtx;
  var box = $('selBox'), menu = $('selMenu');

  function plain() { lc.style.opacity = '1'; lc.style.webkitMaskImage = ''; lc.style.maskImage = ''; }
  function clearLive() { lctx.clearRect(0, 0, lc.width, lc.height); }

  /* ---------- 選んだもの ---------- */
  var sel = null; // { items, set, page, b: {x0,y0,x1,y1}, dx, dy, s }

  function bounds(items) {
    var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    items.forEach(function (s) {
      if (s.tool === 'image') {
        b.x0 = Math.min(b.x0, s.x); b.y0 = Math.min(b.y0, s.y);
        b.x1 = Math.max(b.x1, s.x + s.w); b.y1 = Math.max(b.y1, s.y + s.h);
        return;
      }
      var hw = (s.tool === 'highlighter' ? s.width * 5 : s.width * 1.4) / 1000 / 2;
      var hh = hw * S.cssW / S.cssH;
      s.points.forEach(function (p) {
        b.x0 = Math.min(b.x0, p[0] - hw); b.y0 = Math.min(b.y0, p[1] - hh);
        b.x1 = Math.max(b.x1, p[0] + hw); b.y1 = Math.max(b.y1, p[1] + hh);
      });
    });
    return b;
  }
  function r4(n) { return Math.round(n * 10000) / 10000; }
  // 動かす・大きさを変えたあとの形（左上を基準に s 倍して、dx, dy ずらす）
  function moved(s, dx, dy, k, ox, oy) {
    function X(x) { return r4(ox + (x - ox) * k + dx); }
    function Y(y) { return r4(oy + (y - oy) * k + dy); }
    if (s.tool === 'image') return { tool: 'image', id: s.id, x: X(s.x), y: Y(s.y), w: r4(s.w * k), h: r4(s.h * k) };
    return {
      tool: s.tool, color: s.color, width: Math.min(40, Math.max(0.5, Math.round(s.width * k * 100) / 100)),
      points: s.points.map(function (p) { return [X(p[0]), Y(p[1]), p[2]]; })
    };
  }
  function xform(s) {
    if (!sel || !sel.set.has(s) || (!sel.dx && !sel.dy && sel.s === 1)) return s;
    return moved(s, sel.dx, sel.dy, sel.s, sel.b.x0, sel.b.y0);
  }
  function current() {
    return { x0: sel.b.x0 + sel.dx, y0: sel.b.y0 + sel.dy,
      x1: sel.b.x0 + (sel.b.x1 - sel.b.x0) * sel.s + sel.dx, y1: sel.b.y0 + (sel.b.y1 - sel.b.y0) * sel.s + sel.dy };
  }
  function place() {
    if (!sel) { box.hidden = true; menu.hidden = true; return; }
    var b = current(), W = S.cssW, H = S.cssH;
    box.hidden = false;
    box.style.left = (b.x0 * W - 4) + 'px'; box.style.top = (b.y0 * H - 4) + 'px';
    box.style.width = ((b.x1 - b.x0) * W + 8) + 'px'; box.style.height = ((b.y1 - b.y0) * H + 8) + 'px';
    var busy = !!(sel.dx || sel.dy || sel.s !== 1);
    menu.hidden = busy;
    if (!busy) {
      var mw = menu.offsetWidth || 120;
      menu.style.left = Math.max(0, Math.min(W - mw, (b.x0 + b.x1) / 2 * W - mw / 2)) + 'px';
      var top = b.y0 * H - 52;
      menu.style.top = (top < 0 ? b.y1 * H + 12 : top) + 'px';
    }
  }
  function setSel(items) {
    if (!items || !items.length) { clearSel(); return; }
    sel = { items: items, set: new Set(items), page: S.page, b: bounds(items), dx: 0, dy: 0, s: 1 };
    S.xform = xform;
    place();
  }
  function clearSel() {
    if (drag) { drag = null; lc.style.transform = ''; lc.style.transformOrigin = ''; clearLive(); }
    if (!sel) return;
    sel = null; S.xform = null; place(); App.drawInk();
  }
  // 動かした結果を手書きデータに確定する（元に戻せるように）
  function finish() {
    if (!sel || (!sel.dx && !sel.dy && sel.s === 1)) { place(); App.drawInk(); return; }
    App.pushUndo();
    var list = (S.strokes[S.page] || []).slice(), out = [];
    var ox = sel.b.x0, oy = sel.b.y0;
    for (var i = 0; i < list.length; i++) {
      if (sel.set.has(list[i])) { list[i] = moved(list[i], sel.dx, sel.dy, sel.s, ox, oy); out.push(list[i]); }
    }
    S.strokes[S.page] = list;
    S.xform = null;
    setSel(out);
    App.commit();
  }

  /* ---------- 動かしている最中 ----------
     選んだものだけを上の透明な紙に描き、その紙をCSSで動かす（毎回すべてを描き直さないので、なめらか） */
  var drag = null;
  function hideSel(s) { return sel && sel.set.has(s) ? null : s; }
  function startDrag(mode, pt) {
    drag = { mode: mode, p0: pt };
    menu.hidden = true;
    S.xform = hideSel; App.drawInk();
    plain(); clearLive();
    App.drawList(lctx, sel.items, lc.width, lc.height);
    lc.style.transformOrigin = (sel.b.x0 * S.cssW) + 'px ' + (sel.b.y0 * S.cssH) + 'px';
  }
  function moveDrag(pt) {
    if (drag.mode === 'move') { sel.dx = pt[0] - drag.p0[0]; sel.dy = pt[1] - drag.p0[1]; }
    else {
      var b = sel.b, bw = (b.x1 - b.x0) * S.cssW || 1, bh = (b.y1 - b.y0) * S.cssH || 1;
      var sx = (pt[0] - b.x0) * S.cssW / bw, sy = (pt[1] - b.y0) * S.cssH / bh;
      sel.s = Math.max(0.1, Math.min(10, Math.max(sx, sy)));
    }
    lc.style.transform = 'translate(' + (sel.dx * S.cssW) + 'px,' + (sel.dy * S.cssH) + 'px) scale(' + sel.s + ')';
    place();
  }
  function endDrag() {
    drag = null;
    lc.style.transform = ''; lc.style.transformOrigin = '';
    clearLive();
    S.xform = xform;
    finish();
  }
  // pt が選んだものの上（または右下の丸の上）なら、そのモードを返す
  function onSel(pt) {
    if (!sel || sel.page !== S.page) return null;
    var b = sel.b, px = pt[0] * S.cssW, py = pt[1] * S.cssH, pad = 14;
    if (Math.hypot(px - b.x1 * S.cssW, py - b.y1 * S.cssH) < 28) return 'resize';
    if (px > b.x0 * S.cssW - pad && px < b.x1 * S.cssW + pad && py > b.y0 * S.cssH - pad && py < b.y1 * S.cssH + pad) return 'move';
    return null;
  }
  // pt の場所にあるもの（上に描かれているものを優先）。画像は中を、線は近くを触ったとき
  function itemAt(pt, imagesOnly) {
    var list = S.strokes[S.page] || [], px = pt[0] * S.cssW, py = pt[1] * S.cssH, i;
    for (i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      if (s.tool !== 'image' && !imagesOnly && near(s, px, py, 12)) return s;
    }
    for (i = list.length - 1; i >= 0; i--) {
      var m = list[i];
      if (m.tool === 'image' && pt[0] >= m.x && pt[0] <= m.x + m.w && pt[1] >= m.y && pt[1] <= m.y + m.h) return m;
    }
    return null;
  }
  function near(s, px, py, r) {
    var p = s.points, W = S.cssW, H = S.cssH;
    r += (s.tool === 'highlighter' ? s.width * 5 : s.width) * W / 1000 / 2;
    for (var i = 0; i < p.length; i++) {
      var ax = p[i][0] * W, ay = p[i][1] * H;
      if (i === 0) { if (Math.hypot(px - ax, py - ay) < r) return true; continue; }
      var bx = p[i - 1][0] * W, by = p[i - 1][1] * H, dx = ax - bx, dy = ay - by, l2 = dx * dx + dy * dy;
      var t = l2 ? Math.max(0, Math.min(1, ((px - bx) * dx + (py - by) * dy) / l2)) : 0;
      if (Math.hypot(px - (bx + t * dx), py - (by + t * dy)) < r) return true;
    }
    return false;
  }

  /* ---------- 投げ縄の道具 ---------- */
  var path = null;
  function inside(pt, poly) {
    var x = pt[0] * S.cssW, y = pt[1] * S.cssH, c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0] * S.cssW, yi = poly[i][1] * S.cssH, xj = poly[j][0] * S.cssW, yj = poly[j][1] * S.cssH;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function drawPath() {
    clearLive();
    var W = lc.width, H = lc.height, k = W / S.cssW;
    lctx.save();
    lctx.setLineDash([6 * k, 5 * k]); lctx.lineWidth = 1.6 * k; lctx.strokeStyle = '#3d5fc4';
    lctx.fillStyle = 'rgba(61,95,196,.06)';
    lctx.beginPath(); lctx.moveTo(path[0][0] * W, path[0][1] * H);
    for (var i = 1; i < path.length; i++) lctx.lineTo(path[i][0] * W, path[i][1] * H);
    lctx.closePath(); lctx.fill(); lctx.stroke();
    lctx.restore();
  }
  App.tools.lasso = {
    // 指で触ったとき: 選んだもの・画像の上なら、つかんで動かす（true を返す）。それ以外は指のスクロールにまかせる
    grab: function (pt) {
      var mode = onSel(pt);
      if (!mode) {
        var img = itemAt(pt, true);
        if (!img) return false;
        setSel([img]); mode = 'move';
      }
      startDrag(mode, pt);
      return true;
    },
    down: function (pt) {
      plain();
      var mode = onSel(pt);
      if (mode) { startDrag(mode, pt); return; }
      clearSel();
      path = [pt];
    },
    move: function (pt) {
      if (drag) { if (sel) moveDrag(pt); return; }
      if (!path) return;
      var last = path[path.length - 1];
      if (Math.hypot((pt[0] - last[0]) * S.cssW, (pt[1] - last[1]) * S.cssH) < 3) return;
      path.push(pt);
      drawPath();
    },
    up: function () {
      if (drag) { endDrag(); return; }
      if (!path) return;
      var poly = path; path = null; clearLive();
      // ほとんど動かさずに離した → タップした所にあるものを選ぶ
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      poly.forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
      if ((x1 - x0) * S.cssW < 10 && (y1 - y0) * S.cssH < 10) {
        var it = itemAt(poly[0]);
        if (it) setSel([it]);
        return;
      }
      if (poly.length < 3) return;
      var picked = (S.strokes[S.page] || []).filter(function (s) {
        if (s.tool === 'image') {
          // 画像は、中心か四隅のどれかが囲みの中に入っていれば選ぶ
          return [[s.x + s.w / 2, s.y + s.h / 2], [s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h]]
            .some(function (q) { return inside(q, poly); });
        }
        var n = 0; s.points.forEach(function (p) { if (inside(p, poly)) n++; });
        return n >= s.points.length / 2;
      });
      if (!picked.length) { App.setStatus('囲んだ中に、選べるものがありませんでした'); return; }
      setSel(picked);
    }
  };

  menu.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !sel) return;
    var list = (S.strokes[S.page] || []).slice();
    App.pushUndo();
    if (b.dataset.sel === 'del') {
      S.strokes[S.page] = list.filter(function (s) { return !sel.set.has(s); });
      sel = null; S.xform = null; place();
      App.commit();
      App.setStatus('削除しました（元に戻すボタンで戻せます）');
    } else {
      // 少しずらして複製し、複製したほうを選ぶ
      var off = 20 / S.cssW, offY = 20 / S.cssH;
      var copies = sel.items.map(function (s) { return moved(s, off, offY, 1, 0, 0); });
      S.strokes[S.page] = list.concat(copies);
      App.commit();
      setSel(copies);
    }
  });
  // ペンで選択枠の上を触ったときに、手書き面に届くように（枠は見た目だけ）
  box.style.pointerEvents = 'none';

  /* ---------- レーザーポインター（書いた線がすぐに消える） ----------
     ひと続きの線として描く（短い線を重ねると、つなぎ目が点々に見えていた）。古い所から順に消えていく */
  var runs = [], laserDown = false, raf = 0, LIFE = 800;
  function smooth(pts, W, H) {
    lctx.beginPath();
    lctx.moveTo(pts[0].x * W, pts[0].y * H);
    if (pts.length === 1) { lctx.lineTo(pts[0].x * W + 0.01, pts[0].y * H); return; }
    for (var i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      lctx.quadraticCurveTo(pts[i].x * W, pts[i].y * H, mx * W, my * H);
    }
    var l = pts[pts.length - 1];
    lctx.lineTo(l.x * W, l.y * H);
  }
  function laserFrame() {
    raf = 0;
    var now = performance.now();
    runs.forEach(function (r) { r.pts = r.pts.filter(function (p) { return now - p.t < LIFE; }); });
    runs = runs.filter(function (r) { return r.pts.length || (r.live && laserDown); });
    clearLive();
    var W = lc.width, H = lc.height, k = W / S.cssW;
    lctx.save();
    lctx.lineCap = 'round'; lctx.lineJoin = 'round';
    [[11, 'rgba(255,45,45,.22)'], [6.5, 'rgba(255,45,45,.55)'], [3.4, '#ff3b3b'], [1.4, '#fff3f3']].forEach(function (pass) {
      lctx.lineWidth = pass[0] * k; lctx.strokeStyle = pass[1];
      runs.forEach(function (r) { if (r.pts.length) { smooth(r.pts, W, H); lctx.stroke(); } });
    });
    // ペンの先の光る点
    var cur = runs.length && runs[runs.length - 1];
    if (laserDown && cur && cur.last) {
      var x = cur.last.x * W, y = cur.last.y * H;
      lctx.fillStyle = 'rgba(255,45,45,.3)'; lctx.beginPath(); lctx.arc(x, y, 9 * k, 0, 7); lctx.fill();
      lctx.fillStyle = '#ff3b3b'; lctx.beginPath(); lctx.arc(x, y, 4 * k, 0, 7); lctx.fill();
      lctx.fillStyle = '#fff3f3'; lctx.beginPath(); lctx.arc(x, y, 1.6 * k, 0, 7); lctx.fill();
    }
    lctx.restore();
    if (runs.some(function (r) { return r.pts.length; }) || laserDown) raf = requestAnimationFrame(laserFrame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(laserFrame); }
  App.tools.laser = {
    down: function (pt) {
      plain(); laserDown = true;
      runs.forEach(function (r) { r.live = false; });
      var p = { x: pt[0], y: pt[1], t: performance.now() };
      runs.push({ pts: [p], last: p, live: true });
      kick();
    },
    move: function (pt) {
      var r = runs[runs.length - 1]; if (!r) return;
      var l = r.last;
      if (Math.hypot((pt[0] - l.x) * S.cssW, (pt[1] - l.y) * S.cssH) < 1.5) { l.t = performance.now(); return; }
      var p = { x: pt[0], y: pt[1], t: performance.now() };
      r.pts.push(p); r.last = p;
      kick();
    },
    up: function () { laserDown = false; kick(); }
  };

  /* ---------- まわりの変化に合わせる ---------- */
  App.on('select', function (items) { setSel(items); });
  App.on('tool', function (t) {
    if (t !== 'lasso') clearSel();
    if (drag) { lc.style.transform = ''; S.xform = sel ? xform : null; }
    path = null; drag = null; runs = []; clearLive();
  });
  ['page', 'open', 'layout', 'beforeUndo'].forEach(function (ev) { App.on(ev, clearSel); });
  App.on('resize', place);
})();
