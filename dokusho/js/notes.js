/* 付箋
   - 付箋の道具を選んで、貼りたい場所を軽くたたくと貼れる（指でもペンでも）。貼ったら、前の道具に戻る
   - 付箋は、どの道具のときでも、軽くたたくと開き（メモを書く・色を変える・はがす）、引っぱると動く
   - 付箋そのものは、線と同じ紙の上に絵として描く（見開きのもう片方・ページ一覧・めくっている途中でも同じに見える）
   - ページ一覧の「付箋」のタブに、この本の付箋を並べる。押すと、そのページへ移る
   データ: App.S.notes = { "ページ番号": [{ id, x, y, color, text, at }, …] }（x, y は付箋のまん中。ページに対する割合） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var SIZE = 0.062;      // 付箋の1辺（ページの横幅に対する割合）
  var hot = null, hotTimer = 0; // いま開いている・目立たせている付箋の id

  function clamp(v) { return Math.min(0.985, Math.max(0.015, v)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- 描く ---------- */
  function drawNote(ctx, t, W, H) {
    var s = Math.max(5, W * SIZE), x = t.x * W - s / 2, y = t.y * H - s / 2, f = s * 0.3, r = s * 0.13;
    ctx.save();
    ctx.shadowColor = 'rgba(40,30,10,.32)'; ctx.shadowBlur = s * 0.2; ctx.shadowOffsetY = s * 0.07;
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + s - r, y); ctx.quadraticCurveTo(x + s, y, x + s, y + r);
    ctx.lineTo(x + s, y + s - f); ctx.lineTo(x + s - f, y + s);
    ctx.lineTo(x + r, y + s); ctx.quadraticCurveTo(x, y + s, x, y + s - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath(); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // 折り返した角
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.moveTo(x + s, y + s - f); ctx.lineTo(x + s - f, y + s); ctx.lineTo(x + s - f, y + s - f); ctx.closePath(); ctx.fill();
    // メモが書いてある付箋には、横線の印
    if (t.text) {
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = Math.max(1, s * 0.075); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + s * 0.22, y + s * 0.3); ctx.lineTo(x + s * 0.78, y + s * 0.3);
      ctx.moveTo(x + s * 0.22, y + s * 0.52); ctx.lineTo(x + s * 0.78, y + s * 0.52);
      ctx.moveTo(x + s * 0.22, y + s * 0.74); ctx.lineTo(x + s * 0.5, y + s * 0.74);
      ctx.stroke();
    }
    if (t.id === hot) {
      ctx.strokeStyle = '#d7282f'; ctx.lineWidth = Math.max(1.5, s * 0.09);
      ctx.strokeRect(x - s * 0.1, y - s * 0.1, s * 1.2, s * 1.2);
    }
    ctx.restore();
  }
  App.hooks.drawNotes = function (ctx, list, W, H) {
    for (var i = 0; i < list.length; i++) drawNote(ctx, list[i], W, H);
  };

  /* ---------- その場所にある付箋 ---------- */
  // pt: いまの書ける紙の上の位置（割合）
  function at(pt) {
    var l = S.notes[S.page]; if (!l || !l.length) return null;
    var half = Math.max(S.cssW * SIZE / 2 + 6, 20);
    for (var i = l.length - 1; i >= 0; i--) {
      if (Math.abs((pt[0] - l[i].x) * S.cssW) < half && Math.abs((pt[1] - l[i].y) * S.cssH) < half) return l[i];
    }
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
    var t = { id: App.nid(), x: App.r4(clamp(pt[0])), y: App.r4(clamp(pt[1])), color: S.noteColor || '#ffd84d', text: '', at: Date.now() };
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
      g.t.x = App.r4(clamp(pt[0] + g.ox)); g.t.y = App.r4(clamp(pt[1] + g.oy));
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
      var l = S.notes[hit.n] || [], half = Math.max(hit.rect.width * SIZE / 2 + 6, 20);
      var on = l.some(function (t) { return Math.abs((pt[0] - t.x) * hit.rect.width) < half && Math.abs((pt[1] - t.y) * hit.rect.height) < half; });
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
  function markColors() {
    pop.querySelectorAll('[data-nset]').forEach(function (b) { b.classList.toggle('on', !!cur && b.dataset.nset === cur.color); });
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
    var r = App.wrap.getBoundingClientRect(), s = Math.max(24, r.width * SIZE);
    anchor.style.left = (r.left + t.x * r.width - s / 2) + 'px'; anchor.style.top = (r.top + t.y * r.height - s / 2) + 'px';
    anchor.style.width = anchor.style.height = s + 'px';
    // 文字入力欄はページに常に置かず、開いたときだけ作る（スクリブル対策。手書きノートと同じ）
    ta = document.createElement('textarea');
    ta.id = 'noteText'; ta.placeholder = 'メモ（書かなくても貼れます）'; ta.maxLength = 4000;
    ta.value = t.text || '';
    ta.addEventListener('input', function () {
      if (!cur) return;
      var had = !!cur.text; cur.text = ta.value;
      App.scheduleSave(pageOf(cur) || S.page);
      if (had !== !!cur.text) App.drawInk(); // 横線の印が変わる
    });
    $('noteSlot').textContent = ''; $('noteSlot').appendChild(ta);
    $('notePage').textContent = (pageOf(t) || S.page) + 'ページ';
    markColors();
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

  window.Notes = { size: SIZE, draw: drawNote };
})();
