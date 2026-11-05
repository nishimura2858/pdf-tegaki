/* 動かせる道具パレット
   - 丸いボタンをタップすると、ふわっと開く。もう一度タップすると閉じる
   - 丸いボタンをドラッグすると、好きな場所に動かせる（位置はこの端末に保存）
   - 道具や色を選ぶか、ペンで書き始めると自動で閉じる
   道具・色の切り替えそのものは app.js が担当（data-tool / data-color のボタン） */
(function () {
  'use strict';
  var pal = document.getElementById('palette');
  var bub = document.getElementById('palBubble');
  var panel = document.getElementById('palPanel');
  var KEY = 'ui:palette', SIZE = 52, MARGIN = 10;
  var pos = null, drag = null;

  function headerBottom() { return document.querySelector('header').getBoundingClientRect().bottom; }
  function place(x, y) {
    var maxX = window.innerWidth - SIZE - MARGIN, maxY = window.innerHeight - SIZE - MARGIN - 40;
    x = Math.max(MARGIN, Math.min(maxX, x));
    y = Math.max(headerBottom() + MARGIN, Math.min(maxY, y));
    pos = { x: x, y: y };
    pal.style.left = x + 'px'; pal.style.top = y + 'px';
    // 画面の右半分にあるときは、パネルを左向きに開く
    pal.classList.toggle('to-left', x + SIZE / 2 > window.innerWidth / 2);
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(pos)); } catch (e) {} }
  function load() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (p && isFinite(p.x) && isFinite(p.y)) place(p.x, p.y);
    else place(16, window.innerHeight - SIZE - 90); // 最初は左下
  }
  function setOpen(v) {
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

  // 道具・色を選んだら閉じる（元に戻すは続けて押せるように閉じない）
  panel.addEventListener('click', function (e) {
    if (e.target.closest('[data-tool],[data-slot]')) setTimeout(function () { setOpen(false); }, 140);
  });
  // ペンで書き始めたら閉じる
  document.getElementById('ink').addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch') setOpen(false);
  }, true);

  // 元に戻す: 上のバーのボタンと同じ動き・同じ押せる／押せない状態
  var undo = document.getElementById('undo'), palUndo = document.getElementById('palUndo');
  palUndo.addEventListener('click', function () { undo.click(); });
  function syncUndo() { palUndo.disabled = undo.disabled; }
  new MutationObserver(syncUndo).observe(undo, { attributes: true, attributeFilter: ['disabled'] });
  syncUndo();

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (pos) place(pos.x, pos.y); }, 150);
  });
  load();
})();
