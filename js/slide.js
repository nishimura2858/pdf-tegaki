/* 押したまま滑らせて選ぶ（リキッドグラスのような動き）
   - 道具のボタン・色・太さ・消しゴムの大きさ・色の一覧で使える
   - 押すとガラスの玉がふくらみ、指（ペン）を滑らせると、いちばん近いボタンへついてくる
   - 離したところのボタンが選ばれる。押してすぐ離したときは、ふつうのタップと同じ
   - ボタンから大きく離れたところで離すと、何も選ばない */
(function () {
  'use strict';
  var GROUPS = [
    { root: '.topbar .tools', items: '[data-tool]' },
    { root: '#palSlots', items: '[data-slot]', round: true },
    { root: '#palPanel .widths', items: '[data-width]', round: true },
    { root: '#palPanel', items: '[data-esize]', round: true },
    { root: '#colorPop', items: '[data-pick]', round: true }
  ];
  var FAR = 48; // ボタンからこれ以上離れたら「選ばない」
  var lens = document.createElement('div');
  lens.id = 'lens';
  document.body.appendChild(lens);
  var g = null, eat = false, eatTimer = 0, hideTimer = 0;

  function lensTo(b, scale, round) {
    var r = b.getBoundingClientRect(), pad = round ? 5 : 3;
    var w = r.width + pad * 2, h = r.height + pad * 2;
    if (round) w = h = Math.max(w, h);
    lens.style.width = w + 'px'; lens.style.height = h + 'px';
    lens.style.borderRadius = round ? '50%' : '14px';
    lens.style.transform = 'translate(' + (r.left + r.width / 2 - w / 2) + 'px,' + (r.top + r.height / 2 - h / 2) + 'px) scale(' + scale + ')';
  }
  function nearest(x, y) {
    var best = null, bd = 1e9;
    g.items.forEach(function (b) {
      if (b.disabled || !b.offsetWidth) return;
      var r = b.getBoundingClientRect();
      var dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom), d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = b; }
    });
    return bd <= FAR ? best : null;
  }
  function hot(b) {
    if (g.cur === b) return;
    if (g.cur) g.cur.classList.remove('slide-hot');
    g.cur = b;
    if (b) { b.classList.add('slide-hot'); lensTo(b, 1.18, g.round); lens.classList.add('on'); }
    else lens.classList.remove('on');
  }

  document.addEventListener('pointerdown', function (e) {
    if (g) return;
    var t = e.target.closest && e.target.closest('button');
    if (!t) return;
    for (var i = 0; i < GROUPS.length; i++) {
      var gr = GROUPS[i], root = t.closest(gr.root);
      if (!root || !t.matches(gr.items)) continue;
      clearTimeout(hideTimer);
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, start: t, cur: null, moved: false, round: !!gr.round,
        items: Array.prototype.slice.call(root.querySelectorAll(gr.items)) };
      lens.style.transition = 'none'; // 最初の位置へは、すっと出す
      hot(t);
      void lens.offsetWidth; lens.style.transition = '';
      try { t.setPointerCapture(e.pointerId); } catch (er) {}
      return;
    }
  }, true);

  document.addEventListener('pointermove', function (e) {
    if (!g || e.pointerId !== g.id) return;
    if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 8) return;
    g.moved = true;
    hot(nearest(e.clientX, e.clientY));
  }, true);

  function end(e) {
    if (!g || e.pointerId !== g.id) return;
    var b = g.cur, moved = g.moved, round = g.round;
    if (b) b.classList.remove('slide-hot');
    g = null;
    if (moved && e.type === 'pointerup' && b) {
      b.click(); // 離したところのボタンを選ぶ
      eat = true; clearTimeout(eatTimer); // このあとに来る、押し始めたボタンのクリックは捨てる
      eatTimer = setTimeout(function () { eat = false; }, 400);
    }
    if (b && b.isConnected) lensTo(b, 1, round);
    hideTimer = setTimeout(function () { lens.classList.remove('on'); }, 160);
  }
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('click', function (e) {
    if (!eat || !e.isTrusted) return;
    eat = false; e.stopPropagation(); e.preventDefault();
  }, true);
})();
