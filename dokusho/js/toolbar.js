/* 道具のボタン（上のバー）、設定のパレット、ポップアップ
   - 道具は、マーカー・ペン・消しゴム・付箋の4つ
   - マーカーとペンは、それぞれ「よく使う4色」と太さを覚える（この端末に保存）
   - 色・太さ・消しゴムの大きさ・付箋の色は、動かせるパレットで選ぶ
   - 選んでいる色をもう一度タップすると、その枠の色を選び直せる */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var PENS = { pen: 1, highlighter: 1 };
  var KEY = 'dk:ui:tools';
  var NOTE_COLORS = ['#ffd84d', '#ff9eb5', '#8fd3ff', '#a8e28a', '#ffb468', '#cdb4ff'];

  var cfg = {
    tool: 'highlighter', lastPen: 'highlighter', eraser: 14, note: NOTE_COLORS[0],
    pen: { slots: ['#e53935', '#1b2430', '#1e5fd6', '#2e9e55'], sel: 0, w: 2.5 },
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
  if (!/^(pen|highlighter|eraser)$/.test(cfg.tool)) cfg.tool = 'highlighter'; // 付箋は貼ったら元の道具に戻るので、開いたときは選ばない
  if (!PENS[cfg.lastPen]) cfg.lastPen = 'highlighter';
  if (NOTE_COLORS.indexOf(cfg.note) < 0) cfg.note = NOTE_COLORS[0];

  function group(t) { return PENS[t] ? 'pens' : t; }
  function penCfg() { return PENS[S.tool] ? cfg[S.tool] : null; } // 消しゴム・付箋は色の枠・太さを持たない
  function apply() {
    var c = penCfg();
    if (c) { S.color = c.slots[c.sel]; S.width = c.w; }
    S.shape = false; S.eraser = +cfg.eraser || 14; S.noteColor = cfg.note;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} }

  function slotsHtml(c) {
    return c.slots.map(function (col, i) {
      return '<button class="swatch' + (i === c.sel ? ' on' : '') + '" data-slot="' + i + '" style="--c:' + col +
        '" aria-label="色' + (i + 1) + '"></button>';
    }).join('');
  }
  $('palNotes').innerHTML = NOTE_COLORS.map(function (col) {
    return '<button class="swatch" data-ncolor="' + col + '" style="--c:' + col + '" aria-label="付箋の色"></button>';
  }).join('');
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
    root.style.setProperty('--note', cfg.note);
    document.querySelectorAll('[data-esize]').forEach(function (x) { x.classList.toggle('on', +x.dataset.esize === S.eraser); });
    document.querySelectorAll('[data-ncolor]').forEach(function (x) { x.classList.toggle('on', x.dataset.ncolor === cfg.note); });
    document.querySelectorAll('[data-pick]').forEach(function (x) {
      x.classList.toggle('on', !!c && x.dataset.pick.toLowerCase() === S.color.toLowerCase());
    });
    var icon = document.querySelector('.topbar [data-tool="' + t + '"] svg');
    if (icon) $('palIcon').innerHTML = icon.outerHTML;
    if (t !== 'note') cfg.tool = t;
    save();
  }
  function setTool(t) {
    if (PENS[t]) cfg.lastPen = t;
    App.setTool(t); apply(); sync();
    if (t === 'note') App.setStatus('付箋: 貼りたい場所を軽くたたいてください（指でもペンでも）');
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

  function markFling() {
    Array.prototype.forEach.call(document.querySelectorAll('#flingSeg [data-fling]'), function (x) {
      x.classList.toggle('on', +x.dataset.fling === App.flingLevel());
    });
  }
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
    if (d.ncolor) { cfg.note = d.ncolor; apply(); sync(); return; }
    if (d.fling !== undefined) {
      App.setFling(+d.fling); markFling();
      App.setStatus('スクロールの勢い: ' + b.textContent);
      return;
    }
    switch (b.id) {
      case 'moreBtn':
        $('shiftBtn').setAttribute('aria-pressed', S.shift ? 'true' : 'false');
        $('scrubBtn').setAttribute('aria-pressed', App.scrubOn() ? 'true' : 'false');
        markFling();
        showPop($('moreMenu'), b); break;
      case 'focusBtn': setFocus(true); break;
      case 'focusExit': setFocus(false); break;
      case 'shiftBtn':
        if (!S.hasFile) { closePops(); break; }
        App.setShift(!S.shift);
        b.setAttribute('aria-pressed', S.shift ? 'true' : 'false');
        App.setStatus(S.shift ? '見開きを1ページずらしました（1ページ目は右に1枚だけ）' : '見開きのずらしを元に戻しました');
        break;
      case 'scrubBtn':
        App.setScrub(!App.scrubOn());
        b.setAttribute('aria-pressed', App.scrubOn() ? 'true' : 'false');
        App.setStatus(App.scrubOn() ? '紙の下にめくるバーを出しました' : '紙の下のめくるバーを消しました');
        break;
    }
  });

  /* ---------- 全画面: 道具のバーもパレットも隠して、本だけにする ----------
     道具は、指で1回たたくと出る「道具の帯」で選ぶ（quick.js） */
  function setFocus(on) {
    closePops();
    document.body.classList.toggle('focus', on);
    App.emit('focus', on);
    if (S.hasFile) App.renderPage(); // 紙の大きさを、広くなった（狭くなった）場所に合わせ直す
    window.dispatchEvent(new Event('resize'));
    if (on) App.setStatus('全画面: 指で1回たたくと道具が出ます');
  }

  // 「その他」のいちばん下に、バージョン番号（読み込んだ app.js の ?v=）を出す
  var vm = /[?&]v=(\d+)/.exec((document.querySelector('script[src*="js/app.js"]') || {}).src || '');
  $('verText').textContent = '読書ノート バージョン ' + (vm ? vm[1] : '?');

  App.on('open', function () { closePops(); });
  App.toolbar = {
    setTool: setTool, closePops: closePops, showPop: showPop, setFocus: setFocus,
    // 付箋を貼り終えたら、前に使っていたペン（マーカー）に戻る
    backToPen: function () { if (S.tool === 'note') setTool(cfg.lastPen); },
    noteColors: NOTE_COLORS
  };
  S.tool = cfg.tool;
  apply(); sync();
})();
