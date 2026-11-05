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
    if (!sel) return;
    sel = null; S.xform = null; place(); App.drawInk();
  }
  // 動かした結果を手書きデータに確定する（元に戻せるように）
  function finish() {
    if (!sel || (!sel.dx && !sel.dy && sel.s === 1)) { place(); return; }
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

  /* ---------- 投げ縄の道具 ---------- */
  var path = null, drag = null;
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
    down: function (pt) {
      plain();
      if (sel && sel.page === S.page) {
        var b = sel.b, px = pt[0] * S.cssW, py = pt[1] * S.cssH;
        var pad = 14;
        var nearHandle = Math.hypot(px - b.x1 * S.cssW, py - b.y1 * S.cssH) < 26;
        var inBox = px > b.x0 * S.cssW - pad && px < b.x1 * S.cssW + pad && py > b.y0 * S.cssH - pad && py < b.y1 * S.cssH + pad;
        if (nearHandle || inBox) { drag = { mode: nearHandle ? 'resize' : 'move', p0: pt }; menu.hidden = true; return; }
      }
      clearSel();
      path = [pt];
    },
    move: function (pt) {
      if (drag) {
        if (drag.mode === 'move') { sel.dx = pt[0] - drag.p0[0]; sel.dy = pt[1] - drag.p0[1]; }
        else {
          var b = sel.b, bw = (b.x1 - b.x0) * S.cssW || 1, bh = (b.y1 - b.y0) * S.cssH || 1;
          var sx = (pt[0] - b.x0) * S.cssW / bw, sy = (pt[1] - b.y0) * S.cssH / bh;
          sel.s = Math.max(0.1, Math.min(10, Math.max(sx, sy)));
        }
        App.drawInk(); place();
        return;
      }
      if (!path) return;
      var last = path[path.length - 1];
      if (Math.hypot((pt[0] - last[0]) * S.cssW, (pt[1] - last[1]) * S.cssH) < 3) return;
      path.push(pt);
      drawPath();
    },
    up: function () {
      if (drag) { drag = null; finish(); return; }
      if (!path) return;
      var poly = path; path = null; clearLive();
      if (poly.length < 3) return;
      var picked = (S.strokes[S.page] || []).filter(function (s) {
        if (s.tool === 'image') return inside([s.x + s.w / 2, s.y + s.h / 2], poly);
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

  /* ---------- レーザーポインター（書いた線がすぐに消える） ---------- */
  var trail = [], laserDown = false, raf = 0, LIFE = 900;
  function laserFrame() {
    raf = 0;
    var now = performance.now();
    trail = trail.filter(function (p) { return now - p.t < LIFE; });
    clearLive();
    if (trail.length) {
      var W = lc.width, H = lc.height, k = W / S.cssW;
      lctx.save();
      lctx.lineCap = 'round'; lctx.lineJoin = 'round';
      for (var pass = 0; pass < 2; pass++) {
        lctx.shadowBlur = pass ? 0 : 10 * k; lctx.shadowColor = 'rgba(255,40,40,.9)';
        lctx.strokeStyle = pass ? 'rgba(255,235,235,1)' : '#ff2d2d';
        lctx.lineWidth = (pass ? 1.6 : 4.5) * k;
        for (var i = 1; i < trail.length; i++) {
          if (trail[i].gap) continue;
          lctx.globalAlpha = Math.max(0, 1 - (now - trail[i].t) / LIFE);
          lctx.beginPath();
          lctx.moveTo(trail[i - 1].x * W, trail[i - 1].y * H);
          lctx.lineTo(trail[i].x * W, trail[i].y * H);
          lctx.stroke();
        }
      }
      lctx.restore();
    }
    if (trail.length || laserDown) raf = requestAnimationFrame(laserFrame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(laserFrame); }
  App.tools.laser = {
    down: function (pt) { plain(); laserDown = true; trail.push({ x: pt[0], y: pt[1], t: performance.now(), gap: true }); kick(); },
    move: function (pt) { trail.push({ x: pt[0], y: pt[1], t: performance.now() }); kick(); },
    up: function () { laserDown = false; kick(); }
  };

  /* ---------- まわりの変化に合わせる ---------- */
  App.on('select', function (items) { setSel(items); });
  App.on('tool', function (t) {
    if (t !== 'lasso') clearSel();
    path = null; drag = null; trail = []; clearLive();
  });
  ['page', 'open', 'layout', 'beforeUndo'].forEach(function (ev) { App.on(ev, clearSel); });
  App.on('resize', place);
})();
