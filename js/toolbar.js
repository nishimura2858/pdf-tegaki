/* 道具のボタン（上の藍色のバー）、設定のパレット、ポップアップ
   - ボールペン・えんぴつ・マーカーは、それぞれ「よく使う4色」と太さを覚える（この端末に保存）
   - 色・太さ・図形・消しゴムの大きさは、動かせるパレットで選ぶ
   - 選んでいる色をもう一度タップすると、その枠の色を選び直せる（GoodNotesと同じ） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var PENS = { pen: 1, pencil: 1, highlighter: 1 };
  var KEY = 'ui:tools2';

  var cfg = {
    tool: 'pen', lastPen: 'pen', shape: false, eraser: 14,
    pen: { slots: ['#1b2430', '#e53935', '#1e5fd6', '#f57c00'], sel: 1, w: 4 },
    pencil: { slots: ['#1b2430', '#6b7280', '#e53935', '#1e5fd6'], sel: 0, w: 4 },
    highlighter: { slots: ['#f2c500', '#8bc34a', '#ff8a80', '#4fc3f7'], sel: 0, w: 4 }
  };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) Object.keys(cfg).forEach(function (k) {
      if (saved[k] === undefined) return;
      if (PENS[k]) {
        var c = saved[k];
        if (c && Array.isArray(c.slots) && c.slots.length === 4 && c.slots.every(function (x) { return /^#[0-9a-f]{6}$/i.test(x); }))
          cfg[k] = { slots: c.slots, sel: Math.min(3, Math.max(0, c.sel | 0)), w: +c.w || 4 };
      } else cfg[k] = saved[k];
    });
  } catch (e) {}
  if (!/^(pen|pencil|highlighter|eraser|lasso|laser)$/.test(cfg.tool)) cfg.tool = 'pen';
  if (!PENS[cfg.lastPen]) cfg.lastPen = 'pen';

  function group(t) { return PENS[t] ? 'pens' : t; }
  function penCfg() { return PENS[S.tool] ? cfg[S.tool] : null; } // 消しゴム等は色・太さを持たない
  function apply() {
    var c = penCfg();
    if (c) { S.color = c.slots[c.sel]; S.width = c.w; }
    S.shape = !!cfg.shape; S.eraser = +cfg.eraser || 14;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} }

  function slotsHtml(c) {
    return c.slots.map(function (col, i) {
      return '<button class="swatch' + (i === c.sel ? ' on' : '') + '" data-slot="' + i + '" style="--c:' + col +
        '" aria-label="色' + (i + 1) + '"></button>';
    }).join('');
  }
  function sync() {
    var t = S.tool, g = group(t), c = penCfg();
    document.querySelectorAll('[data-tool]').forEach(function (x) { x.classList.toggle('on', x.dataset.tool === t); });
    var root = document.documentElement;
    root.dataset.group = g; root.dataset.tool = t;
    if (c) {
      $('palSlots').innerHTML = slotsHtml(c);
      root.style.setProperty('--cur', S.color);
      root.style.setProperty('--curd', Math.round(3 + S.width * 2) + 'px');
      document.querySelectorAll('[data-width]').forEach(function (x) { x.classList.toggle('on', +x.dataset.width === S.width); });
    }
    $('shapeBtn').classList.toggle('on', !!cfg.shape);
    document.querySelectorAll('[data-esize]').forEach(function (x) { x.classList.toggle('on', +x.dataset.esize === S.eraser); });
    document.querySelectorAll('[data-pick]').forEach(function (x) {
      x.classList.toggle('on', !!c && x.dataset.pick.toLowerCase() === S.color.toLowerCase());
    });
    var icon = document.querySelector('.topbar [data-tool="' + t + '"] svg');
    if (icon) $('palIcon').innerHTML = icon.outerHTML;
    cfg.tool = t;
    save();
  }
  function setTool(t) {
    if (PENS[t]) cfg.lastPen = t;
    App.setTool(t); apply(); sync();
  }

  /* ---------- ポップアップ（ボタンの下にふわっと出る） ---------- */
  var openPop = null;
  function closePops() {
    document.querySelectorAll('.pop.open').forEach(function (p) { p.classList.remove('open'); });
    openPop = null;
    App.emit('popClosed');
  }
  function showPop(pop, anchor) {
    if (openPop && openPop.pop === pop && openPop.anchor === anchor) { closePops(); return; }
    closePops();
    var r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    var cx = r.left + r.width / 2;
    // 横画面で道具のバーが左に縦に並んでいるときは、ボタンの右に出す
    var bar = anchor.closest('.topbar');
    pop.classList.toggle('side', !!bar && bar.offsetHeight > bar.offsetWidth * 2);
    if (pop.classList.contains('side')) {
      var cy = r.top + r.height / 2, top = Math.max(8, Math.min(window.innerHeight - h - 8, cy - h / 2));
      pop.classList.remove('up');
      pop.style.left = (r.right + 12) + 'px'; pop.style.top = top + 'px';
      pop.style.setProperty('--ay', (cy - top) + 'px');
      pop.classList.add('open');
      openPop = { pop: pop, anchor: anchor };
      return;
    }
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, cx - w / 2));
    // 下に入りきらないときは、ボタンの上に出す（パレットが画面の下にあるときなど）
    var up = r.bottom + 10 + h > window.innerHeight - 8 && r.top - 10 - h > 8;
    pop.classList.toggle('up', up);
    pop.style.left = left + 'px';
    pop.style.top = (up ? r.top - 10 - h : r.bottom + 10) + 'px';
    pop.style.setProperty('--ax', (cx - left) + 'px');
    pop.classList.add('open');
    openPop = { pop: pop, anchor: anchor };
  }
  document.addEventListener('pointerdown', function (e) {
    if (!openPop) return;
    if (e.target.closest('.pop') || openPop.anchor.contains(e.target)) return;
    closePops();
  }, true);

  /* ---------- ボタンの操作 ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var d = b.dataset, c = penCfg();
    if (d.tool) { setTool(d.tool); return; }
    if (d.slot !== undefined) {
      if (!c) return;
      var i = +d.slot;
      if (i === c.sel) { showPop($('colorPop'), b); return; }
      c.sel = i; apply(); sync(); return;
    }
    if (d.pick) {
      if (c) { c.slots[c.sel] = d.pick; apply(); sync(); }
      setTimeout(closePops, 140); return;
    }
    if (d.width) {
      if (c) { c.w = +d.width; apply(); sync(); }
      return;
    }
    if (d.esize) { cfg.eraser = +d.esize; apply(); sync(); return; }
    if (d.add) {
      closePops();
      if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); return; }
      App.insertPage(d.add); return;
    }
    switch (b.id) {
      case 'shapeBtn':
        cfg.shape = !cfg.shape; apply(); sync();
        App.setStatus(cfg.shape ? '図形モード：丸・四角・三角・直線を書くと、きれいな形に直します' : '図形モードを切りました');
        break;
      case 'moreBtn':
        $('delPageBtn').disabled = !S.hasFile || !App.pageEntry().added;
        $('shiftBtn').setAttribute('aria-pressed', S.shift ? 'true' : 'false');
        $('scrubBtn').setAttribute('aria-pressed', App.scrubOn() ? 'true' : 'false');
        showPop($('moreMenu'), b); break;
      case 'focusBtn': setFocus(true); break;
      case 'focusExit': setFocus(false); break;
      case 'shareBtn': closePops(); break; // 共有そのものは share.js が受け持つ
      case 'shiftBtn':
        if (!S.hasFile) { closePops(); App.setStatus('先にPDFを開いてください'); break; }
        App.setShift(!S.shift);
        b.setAttribute('aria-pressed', S.shift ? 'true' : 'false');
        App.setStatus(S.shift ? '見開きを1ページずらしました（1ページ目は右に1枚だけ）' : '見開きのずらしを元に戻しました');
        break;
      case 'scrubBtn':
        App.setScrub(!App.scrubOn());
        b.setAttribute('aria-pressed', App.scrubOn() ? 'true' : 'false');
        App.setStatus(App.scrubOn() ? '紙の下にめくるバーを出しました' : '紙の下のめくるバーを消しました');
        break;
      case 'blankBtn': closePops(); App.blank(); break;
      case 'jsonBtn': closePops(); App.openJson(); break;
      case 'delPageBtn': closePops(); App.deletePage(); break;
      case 'imageBtn':
        if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); break; }
        $('imgFile').click(); break;
    }
  });

  /* ---------- 集中モード: 道具のバーを隠して、紙を大きく ---------- */
  // 右上の小さなバーに、上のバーと同じペン・消しゴムのボタンを写して並べる（押すと同じ動き）
  (function () {
    var box = document.querySelector('#focusBar .ftools');
    ['pen', 'pencil', 'highlighter', 'eraser'].forEach(function (t) {
      var src = document.querySelector('.topbar [data-tool="' + t + '"]');
      if (!src) return;
      var b = document.createElement('button');
      b.dataset.tool = t; b.title = src.title; b.setAttribute('aria-label', src.getAttribute('aria-label') || t);
      b.innerHTML = src.querySelector('svg').outerHTML;
      box.appendChild(b);
    });
  })();
  function setFocus(on) {
    closePops();
    document.body.classList.toggle('focus', on);
    if (S.hasFile) App.renderPage(); // 紙の大きさを、広くなった（狭くなった）場所に合わせ直す
    window.dispatchEvent(new Event('resize')); // パレットの位置も合わせ直す
    if (on) { placeBar(); App.setStatus('集中モード：右上のバーは指で動かせます。いちばん端のボタンで元に戻ります'); }
  }

  // 集中モードのバーの場所: どの辺（top/bottom/left/right）の、どのあたり（0〜1）か。この端末に覚える
  var FKEY = 'ui:focusBar', fb = $('focusBar'), fpos = { edge: 'top', t: 1 };
  try { var fp = JSON.parse(localStorage.getItem(FKEY)); if (fp && /^(top|bottom|left|right)$/.test(fp.edge) && isFinite(fp.t)) fpos = fp; } catch (e) {}
  function insets() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n) { return parseFloat(cs.getPropertyValue(n)) || 0; };
    return { t: v('--sat'), b: v('--sab'), l: v('--sal'), r: v('--sar') };
  }
  function placeBar() {
    if (!document.body.classList.contains('focus')) return;
    var vert = fpos.edge === 'left' || fpos.edge === 'right', m = 10, ins = insets();
    fb.classList.toggle('vert', vert);
    fb.style.right = 'auto';
    var W = window.innerWidth, H = window.innerHeight, w = fb.offsetWidth, h = fb.offsetHeight, x, y;
    var t = Math.max(0, Math.min(1, fpos.t));
    if (vert) {
      x = fpos.edge === 'left' ? m + ins.l : W - w - m - ins.r;
      var y0 = m + ins.t, y1 = H - h - m - ins.b; y = y0 + (y1 - y0) * t;
    } else {
      y = fpos.edge === 'top' ? m + ins.t : H - h - m - ins.b;
      var x0 = m + ins.l, x1 = W - w - m - ins.r; x = x0 + (x1 - x0) * t;
    }
    fb.style.left = Math.round(x) + 'px'; fb.style.top = Math.round(y) + 'px';
  }
  // いちばん近い辺を選ぶ（指の位置で決める）
  function nearEdge(px, py) {
    var W = window.innerWidth, H = window.innerHeight;
    var d = { left: px, right: W - px, top: py, bottom: H - py }, best = 'top';
    Object.keys(d).forEach(function (k) { if (d[k] < d[best]) best = k; });
    return best;
  }
  var fdrag = null, eatClick = false;
  fb.addEventListener('pointerdown', function (e) {
    var r = fb.getBoundingClientRect();
    fdrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, moved: false };
  });
  fb.addEventListener('pointermove', function (e) {
    if (!fdrag || e.pointerId !== fdrag.id) return;
    if (!fdrag.moved) {
      if (Math.hypot(e.clientX - fdrag.x0, e.clientY - fdrag.y0) < 8) return;
      fdrag.moved = true; fb.classList.add('dragging');
      try { fb.setPointerCapture(e.pointerId); } catch (err) {}
    }
    // 指に近い辺の向きに、その場で並べ替えながら動かす
    var vert = /left|right/.test(nearEdge(e.clientX, e.clientY));
    fb.classList.toggle('vert', vert);
    var w = fb.offsetWidth, h = fb.offsetHeight;
    var fx = vert ? 0.5 : fdrag.fx, fy = vert ? fdrag.fy : 0.5;
    if (fdrag.vert !== undefined && vert !== fdrag.vert) { fdrag.fx = fdrag.fy = 0.5; fx = fy = 0.5; } // 向きが変わったら、指をバーの真ん中に
    fdrag.vert = vert;
    fb.style.left = Math.round(Math.max(0, Math.min(window.innerWidth - w, e.clientX - w * fx))) + 'px';
    fb.style.top = Math.round(Math.max(0, Math.min(window.innerHeight - h, e.clientY - h * fy))) + 'px';
  });
  function fend(e) {
    if (!fdrag || e.pointerId !== fdrag.id) return;
    var d = fdrag; fdrag = null;
    if (!d.moved) return;
    fb.classList.remove('dragging');
    eatClick = true; setTimeout(function () { eatClick = false; }, 300);
    var edge = nearEdge(e.clientX, e.clientY), vert = edge === 'left' || edge === 'right';
    fb.classList.toggle('vert', vert);
    var r = fb.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    var t = vert ? (r.top) / Math.max(1, H - r.height) : (r.left) / Math.max(1, W - r.width);
    fpos = { edge: edge, t: Math.max(0, Math.min(1, t)) };
    try { localStorage.setItem(FKEY, JSON.stringify(fpos)); } catch (err) {}
    placeBar();
  }
  fb.addEventListener('pointerup', fend);
  fb.addEventListener('pointercancel', fend);
  // 動かしたあとの「指を離した」で、ボタンが押されないように
  fb.addEventListener('click', function (e) { if (eatClick) { e.stopPropagation(); e.preventDefault(); eatClick = false; } }, true);
  fb.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  var frt = null;
  window.addEventListener('resize', function () { clearTimeout(frt); frt = setTimeout(placeBar, 150); });

  /* ---------- 画像を貼る ---------- */
  // 大きな写真は、保存しやすい大きさ（長い辺1600px）に縮めてから貼る
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var x = c.getContext('2d');
        var png = /png|gif|webp/.test(file.type);
        if (!png) { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }
        x.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var data = c.toDataURL('image/jpeg', 0.82);
        if (png) { var p = c.toDataURL('image/png'); if (p.length < data.length * 1.6) data = p; }
        resolve({ data: data, w: w, h: h });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }
  $('imgFile').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      var r = await loadImage(f);
      var it = App.addImage(r.data, r.w, r.h);
      if (!it) return;
      setTool('lasso');
      App.emit('select', [it]); // 貼った画像をすぐ動かせるように選んでおく
      App.setStatus('画像を貼りました。ドラッグで移動、右下の丸で大きさを変えられます');
    } catch (err) {
      console.error(err);
      App.setStatus('画像を読み込めませんでした');
    }
  });

  // 「その他」のいちばん下に、バージョン番号（読み込んだ app.js の ?v=）を出す
  var vm = /[?&]v=(\d+)/.exec((document.querySelector('script[src*="js/app.js"]') || {}).src || '');
  $('verText').textContent = 'バージョン ' + (vm ? vm[1] : '?');

  App.on('open', function () { closePops(); });
  App.toolbar = { setTool: setTool, closePops: closePops, showPop: showPop };
  S.tool = cfg.tool;
  apply(); sync();
})();
