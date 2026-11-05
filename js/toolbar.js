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
    if (d.add) { closePops(); App.insertPage(d.add); return; }
    switch (b.id) {
      case 'shapeBtn':
        cfg.shape = !cfg.shape; apply(); sync();
        App.setStatus(cfg.shape ? '図形モード：丸・四角・三角・直線を書くと、きれいな形に直します' : '図形モードを切りました');
        break;
      case 'moreBtn':
        $('delPageBtn').disabled = !S.hasFile || !App.pageEntry().added;
        showPop($('moreMenu'), b); break;
      case 'addPageBtn':
        if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); break; }
        showPop($('addMenu'), b); break;
      case 'blankBtn': closePops(); App.blank(); break;
      case 'jsonBtn': closePops(); App.openJson(); break;
      case 'delPageBtn': closePops(); App.deletePage(); break;
      case 'imageBtn':
        if (!S.hasFile) { App.setStatus('先にPDFを開いてください'); break; }
        $('imgFile').click(); break;
    }
  });

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

  App.on('open', function () { closePops(); });
  App.toolbar = { setTool: setTool, closePops: closePops, showPop: showPop };
  S.tool = cfg.tool;
  apply(); sync();
})();
