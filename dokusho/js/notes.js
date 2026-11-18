/* 付箋
   - 付箋の道具を選んで、貼りたい場所を軽くたたくと貼れる（指でもペンでも）。貼ったら、前の道具に戻る
   - 付箋は、どの道具のときでも、軽くたたくと開き（メモを書く・色を変える・はがす）、引っぱると動く
   - 付箋そのものは、線と同じ紙の上に絵として描く（見開きのもう片方・ページ一覧・めくっている途中でも同じに見える）
   - ページ一覧の「付箋」のタブに、この本の付箋を並べる。押すと、そのページへ移る
   - 付箋には、書いたメモがそのまま見える。形は4種類（正方形・横長・縦長〈縦書き〉・小さい印）。
     形は、付箋を開いたときと、付箋の道具のパレットで選べる（選んだ形は、次に貼る付箋にも使う）
   - 付箋を開くと、向き（縦向き⇔横向き。縦向きのときは縦書き）と、大きさ（0.5倍〜2倍）も変えられる。
     選んだ形・向き・大きさは、次に貼る付箋にも使う
   データ: App.S.notes = { "ページ番号": [{ id, x, y, color, text, at, shape, rot, k }, …] }
     （x, y は付箋のまん中。ページに対する割合。shape がない付箋は正方形として扱う。
       rot: 向きを変えた（縦と横を入れかえ、書く向きも入れかえる）、k: 大きさの倍率。ないときは 1） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  /* 付箋の形。w, h はページの横幅に対する割合（縦も横幅を基準にするので、正方形は正方形のまま）
     文字の大きさは、どの形でもページの横幅の FS（見開きのiPadで14ピクセルほど）。入りきらないときだけ少し小さくする */
  var SHAPES = {
    sq:   { w: 0.24,  h: 0.24,  label: '正方形' },
    wide: { w: 0.40,  h: 0.13,  label: '横長' },
    tall: { w: 0.085, h: 0.36,  label: '縦長（縦書き）' },
    mini: { w: 0.065, h: 0.065, label: '小さい印（文字は出さない）' }
  };
  var ORDER = ['sq', 'wide', 'tall', 'mini'], FS = 0.026, FS_MIN = 0.019;
  var K_MIN = 0.5, K_MAX = 2;
  var SHAPE_KEY = 'dk:ui:noteShape', defShape = 'sq', DEF_KEY = 'dk:ui:noteLook', def = { rot: false, k: 1 };
  try {
    var sv = localStorage.getItem(SHAPE_KEY); if (SHAPES[sv]) defShape = sv;
    var dv = JSON.parse(localStorage.getItem(DEF_KEY) || 'null');
    if (dv) def = { rot: !!dv.rot, k: kOf(dv) };
  } catch (e) {}
  var hot = null, hotTimer = 0; // いま開いている・目立たせている付箋の id

  function shapeOf(t) { return SHAPES[t.shape] ? t.shape : 'sq'; }
  function kOf(t) { var k = +t.k; return k >= K_MIN && k <= K_MAX ? k : 1; }
  // 付箋の大きさ（ページの横幅に対する割合）と、縦書きかどうか
  function box(t) {
    var sh = shapeOf(t), b = SHAPES[sh], k = kOf(t), rot = !!t.rot && sh !== 'mini';
    return { w: (rot ? b.h : b.w) * k, h: (rot ? b.w : b.h) * k, k: k, vert: (sh === 'tall') !== rot, mini: sh === 'mini' };
  }
  // 付箋がページからはみ出さないように、まん中の位置をおさえる（ratio: ページの縦÷横）
  function fit(t, ratio) {
    var b = box(t), r = ratio || (S.cssW ? S.cssH / S.cssW : 1.41);
    var mx = Math.min(0.5, b.w / 2 + 0.004), my = Math.min(0.5, (b.h / 2 + 0.004) / r);
    t.x = App.r4(Math.min(1 - mx, Math.max(mx, t.x))); t.y = App.r4(Math.min(1 - my, Math.max(my, t.y)));
  }
  // その位置（ページに対する割合）が、付箋の上か。W, H: ページの大きさ（ピクセル）
  function hit(t, pt, W, H) {
    var b = box(t), hw = Math.max(b.w * W / 2 + 6, 20), hh = Math.max(b.h * W / 2 + 6, 20);
    return Math.abs((pt[0] - t.x) * W) < hw && Math.abs((pt[1] - t.y) * H) < hh;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- 描く ---------- */
  var FONT = '-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
  // 行・列の頭に来てはいけない文字（句読点・閉じかっこなど）は、前の行の終わりにぶら下げる
  var NOSTART = '、。，．,.：；:;？！?!）」』】〉》)］]';
  // 横書き: 幅 maxW に入るように1文字ずつ折り返す。maxN 行を超えたら、最後を「…」にする
  function linesH(ctx, text, maxW, maxN) {
    var out = [], over = false;
    String(text).split('\n').some(function (para) {
      var line = '';
      Array.from(para).forEach(function (ch) {
        if (line && NOSTART.indexOf(ch) < 0 && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; } else line += ch;
      });
      out.push(line);
      return out.length > maxN;
    });
    if (out.length > maxN) { over = true; out.length = maxN; }
    if (over) {
      var l = out[maxN - 1];
      while (l && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
      out[maxN - 1] = l + '…';
    }
    return { lines: out, over: over };
  }
  // 縦書き: 1列 perCol 文字。maxN 列を超えたら、最後を「…」にする
  function colsV(text, perCol, maxN) {
    var out = [], over = false;
    String(text).split('\n').some(function (para) {
      var a = Array.from(para), col = [];
      a.forEach(function (ch) {
        if (col.length >= perCol && NOSTART.indexOf(ch) < 0) { out.push(col); col = []; }
        col.push(ch);
      });
      out.push(col);
      return out.length > maxN;
    });
    if (out.length > maxN) { over = true; out.length = maxN; }
    if (over) { var c = out[maxN - 1]; if (c.length >= perCol) c.length = perCol - 1; c.push('…'); }
    return { cols: out, over: over };
  }
  var ROT = 'ー－—―…‥〜～()（）「」『』[]［］【】〈〉《》<>-=＝→←', TOPR = '、。，．';
  function drawVert(ctx, cols, x0, y0, fs, lh) {
    // 右の列から左へ。1文字ずつ上から下へ
    cols.forEach(function (col, ci) {
      var cx = x0 - ci * lh;
      col.forEach(function (ch, i) {
        var cy = y0 + i * fs * 1.04 + fs / 2;
        if (ROT.indexOf(ch) >= 0) {
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 2); ctx.fillText(ch, 0, 0); ctx.restore();
        } else if (TOPR.indexOf(ch) >= 0) ctx.fillText(ch, cx + fs * 0.55, cy - fs * 0.55);
        else ctx.fillText(ch, cx, cy);
      });
    });
  }
  // 付箋を1枚描く。cx, cy: まん中（ピクセル）、W: ページの横幅（ピクセル）。flat: 影と目立たせる枠をつけない（PDFに書き出すとき）
  function paint(ctx, t, cx, cy, W, flat) {
    var b = box(t), vert = b.vert;
    var w = Math.max(5, b.w * W), h = Math.max(5, b.h * W), x = cx - w / 2, y = cy - h / 2;
    var m = Math.min(w, h), f = m * (b.mini ? 0.3 : 0.16), r = Math.min(m * 0.13, W * 0.01);
    ctx.save();
    if (!flat) { ctx.shadowColor = 'rgba(40,30,10,.3)'; ctx.shadowBlur = Math.min(m * 0.2, W * 0.02); ctx.shadowOffsetY = Math.min(m * 0.07, W * 0.006); }
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - f); ctx.lineTo(x + w - f, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath(); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // 折り返した角
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.beginPath(); ctx.moveTo(x + w, y + h - f); ctx.lineTo(x + w - f, y + h); ctx.lineTo(x + w - f, y + h - f); ctx.closePath(); ctx.fill();
    // 文字は、付箋を大きくすると少し大きく、小さくすると少し小さくなる
    var text = (t.text || '').replace(/\s+$/, ''), fs = W * FS * Math.sqrt(b.k), fmin = Math.min(fs, W * FS_MIN);
    if (text && (b.mini || fs < 5)) {
      // 小さい印・ページ一覧の小さな絵: 文字のかわりに横線の印
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = Math.max(1, m * 0.075); ctx.lineCap = 'round';
      ctx.beginPath();
      [0.3, 0.52, 0.74].forEach(function (k, i) {
        if (vert) { var lx = x + w * (0.72 - i * 0.22); ctx.moveTo(lx, y + h * 0.12); ctx.lineTo(lx, y + h * (i === 2 ? 0.5 : 0.85)); }
        else { ctx.moveTo(x + w * 0.22, y + h * k); ctx.lineTo(x + w * (i === 2 ? 0.5 : 0.78), y + h * k); }
      });
      ctx.stroke();
    } else if (text) {
      var pad = Math.max(fs * 0.55, W * 0.012), iw = w - pad * 2, ih = h - pad * 2 - f * 0.4, res, lh;
      ctx.fillStyle = '#2b2620';
      ctx.beginPath(); ctx.rect(x + 1, y + 1, w - 2, h - 2); ctx.clip();
      // 入りきらなければ、文字を少しずつ小さくする（FS_MIN まで）
      for (var size = fs; ; size = Math.max(fmin, size * 0.9)) {
        ctx.font = size + 'px ' + FONT; lh = size * 1.4;
        res = vert
          ? colsV(text, Math.max(1, Math.floor(ih / (size * 1.04))), Math.max(1, Math.floor((iw + lh - size) / lh)))
          : linesH(ctx, text, iw, Math.max(1, Math.floor((ih + lh - size * 1.2) / lh)));
        if (!res.over || size <= fmin + 0.01) break;
      }
      if (vert) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        drawVert(ctx, res.cols, x + w - pad - size / 2, y + pad, size, lh);
      } else {
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        res.lines.forEach(function (l, i) { ctx.fillText(l, x + pad, y + pad + i * lh + size * 0.1); });
      }
    }
    ctx.restore();
    if (!flat && t.id === hot) {
      ctx.save();
      var g = Math.max(3, m * 0.08);
      ctx.strokeStyle = '#d7282f'; ctx.lineWidth = Math.max(1.5, Math.min(m * 0.06, W * 0.006));
      ctx.strokeRect(x - g, y - g, w + g * 2, h + g * 2);
      ctx.restore();
    }
  }
  function drawNote(ctx, t, W, H) { paint(ctx, t, t.x * W, t.y * H, W); }
  App.hooks.drawNotes = function (ctx, list, W, H) {
    for (var i = 0; i < list.length; i++) drawNote(ctx, list[i], W, H);
  };

  /* ---------- その場所にある付箋 ---------- */
  // pt: いまの書ける紙の上の位置（割合）
  function at(pt) {
    var l = S.notes[S.page]; if (!l || !l.length) return null;
    for (var i = l.length - 1; i >= 0; i--) if (hit(l[i], pt, S.cssW, S.cssH)) return l[i];
    return null;
  }
  App.hooks.noteAt = at;
  function pageOf(t) {
    for (var k in S.notes) if (S.notes[k].indexOf(t) >= 0) return +k;
    return 0;
  }
  function changed(n) {
    App.drawInk(); App.refreshStillInk();
    App.scheduleSave(n || S.page);
    App.emit('data'); App.emit('notes');
  }

  /* ---------- 貼る・動かす ---------- */
  function create(pt) {
    var t = { id: App.nid(), x: pt[0], y: pt[1], color: S.noteColor || '#ffd84d', text: '', at: Date.now(), shape: defShape };
    if (def.rot) t.rot = true;
    if (def.k !== 1) t.k = def.k;
    fit(t);
    (S.notes[S.page] = S.notes[S.page] || []).push(t);
    changed(S.page);
    App.toolbar.backToPen();
    openEditor(t, true);
  }
  var g = null, raf = 0;
  function start(pt, e, t) {
    g = { t: t || null, p0: pt, x0: e.clientX, y0: e.clientY, moved: false, ox: t ? t.x - pt[0] : 0, oy: t ? t.y - pt[1] : 0 };
  }
  App.tools.note = {
    // 指で付箋に触れたとき（付箋の上でなければ、ふつうのスクロール・めくりに任せる）
    grab: function (pt, e) { var t = at(pt); if (!t) return false; start(pt, e, t); return true; },
    down: function (pt, e, onNote) { start(pt, e, onNote || at(pt)); },
    move: function (pt, e) {
      if (!g) return;
      if (!g.moved) {
        if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 7) return;
        g.moved = true;
        if (g.t) App.toolbar.closePops();
      }
      if (!g.t) return;
      g.t.x = pt[0] + g.ox; g.t.y = pt[1] + g.oy; fit(g.t);
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; App.drawInk(); });
    },
    up: function (e) {
      var q = g; g = null;
      if (!q) return;
      if (e && e.type === 'pointercancel') { if (q.t && q.moved) changed(); return; }
      if (q.t) { if (q.moved) changed(); else openEditor(q.t); }
      else if (!q.moved && S.tool === 'note') create(q.p0);
    }
  };
  // 指で軽くたたいたとき: 付箋があれば開く。付箋の道具なら、そこに貼る
  App.hooks.tap = function (e) {
    if (!S.hasFile) return false;
    var hit = App.pageAt(e.clientX, e.clientY);
    if (!hit) return false;
    function rel(r) { return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }
    var pt = rel(hit.rect);
    if (hit.n !== S.page) {
      // 見開きのもう片方など: 付箋に関係するときだけ、そのページを書ける紙にする
      var l = S.notes[hit.n] || [];
      var on = l.some(function (t) { return hit(t, pt, hit.rect.width, hit.rect.height); });
      if (!on && S.tool !== 'note') return false;
      if (!App.focusPage(hit.n)) return false;
      pt = rel(App.wrap.getBoundingClientRect());
    }
    var t = at(pt);
    if (t) { openEditor(t); return true; }
    if (S.tool === 'note') { create(pt); return true; }
    return false;
  };

  /* ---------- 付箋を開く（メモ・色・はがす） ---------- */
  var pop = $('notePop'), anchor = $('noteAnchor'), cur = null, ta = null, showing = false;
  $('noteColors').innerHTML = App.toolbar.noteColors.map(function (c) {
    return '<button class="swatch" data-nset="' + c + '" style="--c:' + c + '" aria-label="付箋の色"></button>';
  }).join('');
  // 形を選ぶボタン（付箋を開いたとき・パレット）
  function shapeBtns() {
    return ORDER.map(function (k) {
      return '<button class="nshape" data-nshape="' + k + '" aria-label="' + SHAPES[k].label + '" title="' + SHAPES[k].label + '"><i class="ns-' + k + '"></i></button>';
    }).join('');
  }
  $('noteShapes').innerHTML = shapeBtns();
  $('palShapes').innerHTML = shapeBtns();
  function markShapes() {
    pop.querySelectorAll('[data-nshape]').forEach(function (b) { b.classList.toggle('on', !!cur && b.dataset.nshape === shapeOf(cur)); });
    $('palShapes').querySelectorAll('[data-nshape]').forEach(function (b) { b.classList.toggle('on', b.dataset.nshape === defShape); });
  }
  function setDefShape(k) {
    defShape = k;
    try { localStorage.setItem(SHAPE_KEY, k); } catch (e) {}
    markShapes();
  }
  $('palShapes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-nshape]'); if (!b) return;
    setDefShape(b.dataset.nshape);
    App.setStatus('次に貼る付箋: ' + SHAPES[b.dataset.nshape].label);
  });
  markShapes();
  /* ---------- 向き・大きさ ---------- */
  function rememberLook(t) {
    def = { rot: !!t.rot, k: kOf(t) };
    try { localStorage.setItem(DEF_KEY, JSON.stringify(def)); } catch (e) {}
  }
  function markLook() {
    if (!cur) return;
    var k = kOf(cur);
    $('noteSize').value = k;
    $('noteSizeV').textContent = Math.round(k * 100) + '%';
    $('noteRot').disabled = shapeOf(cur) === 'mini'; // 小さい印は、向きがない
    $('noteSmaller').disabled = k <= K_MIN + 0.001; $('noteBigger').disabled = k >= K_MAX - 0.001;
  }
  function setK(v) {
    if (!cur) return;
    var k = Math.min(K_MAX, Math.max(K_MIN, Math.round(v * 20) / 20));
    if (k === 1) delete cur.k; else cur.k = k;
    fit(cur); rememberLook(cur); markLook();
    if (!raf) raf = requestAnimationFrame(function () { raf = 0; App.drawInk(); });
    App.scheduleSave(pageOf(cur) || S.page);
  }
  $('noteSize').addEventListener('input', function () { setK(+this.value); });
  function markColors() {
    pop.querySelectorAll('[data-nset]').forEach(function (b) { b.classList.toggle('on', !!cur && b.dataset.nset === cur.color); });
    if (cur) pop.style.setProperty('--ncur', cur.color); // 形の見本を、この付箋の色にする
  }
  function setHot(id, ms) {
    hot = id; clearTimeout(hotTimer);
    if (id && ms) hotTimer = setTimeout(function () { hot = null; App.drawInk(); }, ms);
    App.drawInk();
  }
  function openEditor(t, isNew) {
    App.toolbar.closePops();
    cur = t;
    // 付箋の場所に、見えない目印を置いて、その近くにポップアップを出す
    var r = App.wrap.getBoundingClientRect(), b = box(t), aw = Math.max(24, r.width * b.w), ah = Math.max(24, r.width * b.h);
    anchor.style.left = (r.left + t.x * r.width - aw / 2) + 'px'; anchor.style.top = (r.top + t.y * r.height - ah / 2) + 'px';
    anchor.style.width = aw + 'px'; anchor.style.height = ah + 'px';
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブル対策。手書きノートと同じ）
    ta = document.createElement('textarea');
    ta.id = 'noteText'; ta.placeholder = 'メモ（書かなくても貼れます）'; ta.maxLength = 4000;
    ta.value = t.text || '';
    ta.addEventListener('input', function () {
      if (!cur) return;
      cur.text = ta.value;
      App.scheduleSave(pageOf(cur) || S.page);
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; App.drawInk(); }); // 付箋に書いた文字が見える
    });
    $('noteSlot').textContent = ''; $('noteSlot').appendChild(ta);
    $('notePage').textContent = (pageOf(t) || S.page) + 'ページ';
    markColors(); markShapes(); markLook();
    showing = true; // 出すときに、ほかのポップアップを閉じる知らせが来る。それで自分を閉じてしまわないように
    App.toolbar.showPop(pop, anchor);
    showing = false;
    setHot(t.id);
    if (isNew) { try { ta.focus(); } catch (e) {} }
  }
  function closeEditor() {
    if (!cur) return;
    var t = cur; cur = null;
    if (ta) { t.text = ta.value; try { ta.blur(); } catch (e) {} ta.remove(); ta = null; }
    hot = null;
    changed(pageOf(t) || S.page);
  }
  App.on('popClosed', function () { if (cur && !showing && !pop.classList.contains('open')) closeEditor(); });
  pop.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || !cur) return;
    if (b.dataset.nset) { cur.color = b.dataset.nset; markColors(); App.drawInk(); App.scheduleSave(pageOf(cur) || S.page); return; }
    if (b.dataset.nshape) {
      var ct = cur;
      ct.shape = b.dataset.nshape; fit(ct); setDefShape(ct.shape);
      App.toolbar.closePops(); // ここでメモを保存して閉じる（cur は空になる）
      openEditor(ct); // 大きさが変わるので、ポップアップを出し直す
      return;
    }
    if (b.id === 'noteSmaller' || b.id === 'noteBigger') { setK(kOf(cur) + (b.id === 'noteBigger' ? 0.05 : -0.05)); return; }
    if (b.id === 'noteRot') {
      var rt = cur;
      if (rt.rot) delete rt.rot; else rt.rot = true;
      fit(rt); rememberLook(rt);
      App.toolbar.closePops();
      openEditor(rt); // 形が変わるので、ポップアップを出し直す
      App.setStatus(box(rt).vert ? '縦向き（縦書き）にしました' : '横向き（横書き）にしました');
      return;
    }
    if (b.id === 'noteClose') { App.toolbar.closePops(); return; }
    if (b.id === 'noteDel') {
      var t = cur, n = pageOf(t);
      if (ta && ta.value.trim() && !window.confirm('この付箋をはがしますか？\nメモも一緒に消えます。')) return;
      cur = null; if (ta) { ta.remove(); ta = null; } hot = null;
      App.toolbar.closePops();
      if (n) { S.notes[n] = S.notes[n].filter(function (x) { return x !== t; }); if (!S.notes[n].length) delete S.notes[n]; }
      changed(n);
      App.setStatus('付箋をはがしました');
    }
  });
  // 画面のキーボードが出たとき、ポップアップが隠れないように上へずらす
  if (window.visualViewport) visualViewport.addEventListener('resize', function () {
    if (!cur || !pop.classList.contains('open')) return;
    var vv = visualViewport, max = vv.offsetTop + vv.height - pop.offsetHeight - 8;
    if (pop.getBoundingClientRect().top > max) pop.style.top = Math.max(8, max) + 'px';
  });
  App.on('page', function () { if (cur) App.toolbar.closePops(); });
  App.on('open', function () { cur = null; hot = null; });

  /* ---------- ページ一覧の「付箋」のタブ ---------- */
  var listEl = $('noteList'), tabs = $('sideTabs'), side = $('sidebar'), tab = 'pages';
  function count() { var c = 0; for (var k in S.notes) c += S.notes[k].length; return c; }
  function renderList() {
    $('tabNotesN').textContent = count() || '';
    if (tab !== 'notes') return;
    var keys = Object.keys(S.notes).map(Number).filter(function (n) { return S.notes[n] && S.notes[n].length; }).sort(function (a, b) { return a - b; });
    if (!keys.length) {
      listEl.innerHTML = '<p class="nl-empty">まだ付箋がありません。<br>上の付箋のボタンを押してから、貼りたい場所を軽くたたくと貼れます。</p>';
      return;
    }
    listEl.innerHTML = keys.map(function (n) {
      return S.notes[n].map(function (t) {
        return '<button class="nrow" data-n="' + n + '" data-id="' + esc(t.id) + '"><i style="background:' + esc(t.color) + '"></i>' +
          '<span class="np">' + n + 'ページ</span><span class="nt' + (t.text ? '' : ' none') + '">' + (t.text ? esc(t.text.slice(0, 120)) : 'メモなし') + '</span></button>';
      }).join('');
    }).join('');
  }
  function setTab(v) {
    tab = v;
    side.dataset.tab = v;
    tabs.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === v); });
    renderList();
  }
  tabs.addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  listEl.addEventListener('click', function (e) {
    var b = e.target.closest('.nrow'); if (!b) return;
    var id = b.dataset.id;
    Promise.resolve(App.goPage(+b.dataset.n)).then(function () { setHot(id, 1800); });
  });
  var lt = 0;
  App.on('notes', function () { clearTimeout(lt); lt = setTimeout(renderList, 200); });
  App.on('open', function () { setTab('pages'); });
  App.on('layout', renderList);
  setTab('pages');

  window.Notes = { shapes: SHAPES, box: box, paint: paint, draw: drawNote };
})();
