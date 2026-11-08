/* 動かせる設定パレット（色・太さ・図形・消しゴムの大きさ・元に戻す）
   - 丸いボタンをタップすると、ふわっと開く。もう一度タップすると閉じる
   - 丸いボタンをドラッグすると、好きな場所に動かせる（位置はこの端末に保存）
   - ペンで書き始めると自動で閉じる
   色・太さの切り替えそのものは toolbar.js が担当 */
(function () {
  'use strict';
  var pal = document.getElementById('palette');
  var bub = document.getElementById('palBubble');
  var panel = document.getElementById('palPanel');
  var KEY = 'ui:palette', SIZE = 52, MARGIN = 10;
  var pos = null, drag = null;

  // 道具のバーの外側（上のバーなら下、横画面で左に縦に並んでいるなら右）に置く
  function barEdge() {
    var r = document.querySelector('header').getBoundingClientRect();
    return r.height > r.width * 2 ? { x: r.right, y: 0 } : { x: 0, y: r.bottom };
  }
  function place(x, y) {
    var maxX = window.innerWidth - SIZE - MARGIN, maxY = window.innerHeight - SIZE - MARGIN - 40, e = barEdge();
    x = Math.max(e.x + MARGIN, Math.min(maxX, x));
    y = Math.max(e.y + MARGIN, Math.min(maxY, y));
    pos = { x: x, y: y };
    pal.style.left = x + 'px'; pal.style.top = y + 'px';
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(pos)); } catch (e) {} }
  function load() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (p && isFinite(p.x) && isFinite(p.y)) place(p.x, p.y);
    else place(16, window.innerHeight - SIZE - 90); // 最初は左下
  }
  // 開く向き: 右に入りきるなら右、だめなら左（中身の幅は道具によって変わる）
  function side() {
    var w = panel.offsetWidth, x = pos.x;
    var fitR = x + SIZE + 10 + w <= window.innerWidth - 6, fitL = x - 10 - w >= 6;
    pal.classList.toggle('to-left', fitR && fitL ? x + SIZE / 2 > window.innerWidth / 2 : !fitR);
  }
  function setOpen(v) {
    if (v) side();
    pal.classList.toggle('open', v);
    bub.setAttribute('aria-expanded', String(v));
  }

  bub.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { bub.setPointerCapture(e.pointerId); } catch (err) {}
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: pos.x, y0: pos.y, moved: false };
  });
  bub.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; pal.classList.add('dragging'); setOpen(false); }
    place(drag.x0 + dx, drag.y0 + dy);
  });
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var moved = drag.moved; drag = null;
    pal.classList.remove('dragging');
    if (moved) save();
    else if (e.type === 'pointerup') setOpen(!pal.classList.contains('open'));
  }
  bub.addEventListener('pointerup', end);
  bub.addEventListener('pointercancel', end);
  // ドラッグ中に画面がスクロールしないように
  pal.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });

  // ペンで書き始めたら閉じる
  document.getElementById('ink').addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch') setOpen(false);
  }, true);

  // 元に戻す・やり直す: 上のバーのボタンと同じ動き・同じ押せる／押せない状態
  [['undo', 'palUndo'], ['redo', 'palRedo']].forEach(function (ids) {
    var src = document.getElementById(ids[0]), b = document.getElementById(ids[1]);
    b.addEventListener('click', function () { src.click(); });
    function syncDis() { b.disabled = src.disabled; }
    new MutationObserver(syncDis).observe(src, { attributes: true, attributeFilter: ['disabled'] });
    syncDis();
  });

  // 道具を変えると中身の幅が変わるので、開く向きを確かめ直す
  window.App.on('tool', function () { if (pal.classList.contains('open')) setTimeout(side, 0); });

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (pos) place(pos.x, pos.y); }, 150);
  });
  load();
})();
