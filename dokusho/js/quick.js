/* 全画面のときの、道具の呼び出し
   全画面では、道具のバーもパレットも出さず、本だけを見せる。道具は指で呼び出す
   - 指で1回たたく: 画面の下に「道具の帯」が出る。道具・色・太さ・元に戻すが1枚にまとまっている
     （中身のうち、色・太さなどはパレットの中身をそのまま移して使う）。紙をさわるか、何もしないと数秒で消える
   - 指で長押し: 押した場所のまわりに、道具が輪の形に並ぶ。指を滑らせて離すと選べる。離してからたたいてもよい
   - 2本指でたたく: 元に戻す（全画面でなくても使える。GoodNotesと同じ）
   指の操作を見分けるのは app.js（hooks.singleTap / hold / twoTap） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var tray = $('tray'), panel = $('palPanel'), palette = $('palette'), ring = $('ring');
  var TOOLS = ['highlighter', 'pen', 'eraser', 'note'];

  function focusOn() { return S.hasFile && document.body.classList.contains('focus') && !document.body.classList.contains('home-on'); }
  function icon(t) { var b = document.querySelector('.topbar [data-tool="' + t + '"]'); return b ? b.querySelector('svg').outerHTML : ''; }
  function label(t) { var b = document.querySelector('.topbar [data-tool="' + t + '"]'); return b ? b.getAttribute('aria-label') : t; }

  /* ---------- 道具の帯 ---------- */
  TOOLS.forEach(function (t) {
    var b = document.createElement('button');
    b.dataset.tool = t; b.setAttribute('aria-label', label(t)); b.innerHTML = icon(t);
    $('trayTools').appendChild(b);
  });
  // 全画面に入るときに、パレットの中身（色・太さ・消しゴムの大きさ・付箋の色・元に戻す）を帯へ移す。出るときに戻す
  App.on('focus', function (on) {
    if (on) $('trayPanel').appendChild(panel);
    else { hideTray(true); closeRing(); palette.appendChild(panel); }
  });
  var hideT = 0, closedAt = 0;
  function info() {
    $('trayPage').textContent = App.pageText();
    var f = window.Scrap && S.kind === 'scrap' ? Scrap.sourceOf(S.page) : null;
    $('traySrc').hidden = !f;
    if (f) $('traySrc').textContent = '「' + f.name + '」' + f.page + 'ページ ›';
  }
  function arm(ms) {
    clearTimeout(hideT);
    hideT = setTimeout(function () {
      if (document.querySelector('.pop.open')) { arm(1500); return; } // 色の一覧などを開いている間は消さない
      hideTray();
    }, ms);
  }
  function markTool() {
    $('trayTools').querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === S.tool); });
  }
  function showTray() {
    if (!focusOn()) return;
    App.toolbar.closePops();
    info(); markTool();
    tray.hidden = false; void tray.offsetWidth;
    tray.classList.add('on');
    arm(4000);
  }
  function hideTray(now) {
    clearTimeout(hideT);
    if (tray.hidden) return;
    tray.classList.remove('on');
    if (now) { tray.hidden = true; return; }
    setTimeout(function () { if (!tray.classList.contains('on')) tray.hidden = true; }, 220);
  }
  // 帯をさわっている間は消さない
  tray.addEventListener('pointerdown', function () { arm(4000); }, true);
  tray.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    arm(3000);
    if (b.id === 'trayExit') { hideTray(true); App.toolbar.setFocus(false); }
    else if (b.id === 'trayScrap') Scrap.pick(null, b);
    else if (b.id === 'traySrc') { hideTray(true); Scrap.openSource(S.page); }
  });
  // 帯の外（紙など）をさわったら消す。そのさわった操作（書く・めくる）は、そのまま続く
  document.addEventListener('pointerdown', function (e) {
    if (tray.hidden || !tray.classList.contains('on')) return;
    if (tray.contains(e.target) || (e.target.closest && e.target.closest('.pop'))) return;
    closedAt = performance.now();
    hideTray();
  }, true);
  App.hooks.singleTap = function () {
    if (!focusOn()) return;
    if (performance.now() - closedAt < 900) return; // 帯を消すためにたたいたとき
    if (!ring.hidden) { closeRing(); return; }
    if (tray.hidden) showTray(); else hideTray();
  };
  App.on('page', function () { if (!tray.hidden) info(); });
  App.on('open', function () { hideTray(true); closeRing(); });
  App.on('close', function () { hideTray(true); closeRing(); });

  /* ---------- 輪のメニュー（長押し） ---------- */
  var ITEMS = TOOLS.map(function (t) { return { tool: t, label: label(t), icon: icon(t) }; });
  ITEMS.push({ more: true, label: '色・太さ', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="8.6" cy="10" r="1.4" class="fill"/><circle cx="12" cy="7.8" r="1.4" class="fill"/><circle cx="15.4" cy="10" r="1.4" class="fill"/><path d="M12 13.5c-1.8 0-3 1.3-3 2.6 0 .9.7 1.4 1.6 1.4H12"/></svg>' });
  var R = 78, ANG = ITEMS.map(function (_, k) { return -90 + k * 360 / ITEMS.length; });
  ring.innerHTML = '<div class="rc" id="ringCenter"></div>' + ITEMS.map(function (it, k) {
    var a = ANG[k] * Math.PI / 180;
    return '<button class="ri" data-k="' + k + '" style="--x:' + Math.round(R * Math.cos(a)) + 'px;--y:' + Math.round(R * Math.sin(a)) + 'px" aria-label="' + it.label + '">' +
      it.icon + '<small>' + it.label + '</small></button>';
  }).join('');
  var hot = -1, tapMode = false;
  function setHot(k) {
    if (k === hot) return;
    hot = k;
    ring.querySelectorAll('.ri').forEach(function (b) { b.classList.toggle('hot', +b.dataset.k === k); });
  }
  function choose(k) {
    var it = ITEMS[k]; closeRing();
    if (!it) return;
    if (it.more) showTray();
    else App.toolbar.setTool(it.tool);
  }
  function closeRing() {
    if (ring.hidden) return;
    ring.classList.remove('on'); tapMode = false; setHot(-1);
    setTimeout(function () { if (!ring.classList.contains('on')) ring.hidden = true; }, 180);
  }
  App.hooks.hold = function (x, y) {
    if (!focusOn()) return null;
    hideTray(true); App.toolbar.closePops();
    // 輪が画面からはみ出さないように、まん中をずらす
    var m = R + 44, cx = Math.min(window.innerWidth - m, Math.max(m, x)), cy = Math.min(window.innerHeight - m, Math.max(m, y));
    ring.style.left = cx + 'px'; ring.style.top = cy + 'px';
    var cur = TOOLS.indexOf(S.tool);
    $('ringCenter').innerHTML = cur >= 0 ? ITEMS[cur].icon : '';
    ring.querySelectorAll('.ri').forEach(function (b) { b.classList.toggle('cur', +b.dataset.k === cur); });
    setHot(-1); tapMode = false;
    ring.hidden = false; void ring.offsetWidth; ring.classList.add('on');
    return {
      move: function (e) {
        var dx = e.clientX - cx, dy = e.clientY - cy;
        if (Math.hypot(dx, dy) < 30) { setHot(-1); return; } // まん中のあたりでは、どれも選ばない
        var a = Math.atan2(dy, dx) * 180 / Math.PI, best = -1, bd = 999;
        ANG.forEach(function (g, k) { var d = Math.abs(((a - g) % 360 + 540) % 360 - 180); if (d < bd) { bd = d; best = k; } });
        setHot(best);
      },
      up: function (e, cancel) {
        if (cancel) { closeRing(); return; }
        if (hot >= 0) { choose(hot); return; }
        tapMode = true; // 滑らせずに離した: 輪を出したまま、たたいて選べるようにする
      }
    };
  };
  ring.addEventListener('click', function (e) {
    var b = e.target.closest('.ri'); if (!b || !tapMode) return;
    choose(+b.dataset.k);
  });
  // 輪の外をさわったら閉じる
  document.addEventListener('pointerdown', function (e) {
    if (ring.hidden || !tapMode || ring.contains(e.target)) return;
    closedAt = performance.now();
    closeRing();
  }, true);

  /* ---------- 2本指でたたく: 元に戻す ---------- */
  App.hooks.twoTap = function () {
    if (!S.hasFile) return;
    var u = $('undo');
    if (u.disabled) { App.setStatus('元に戻せるものはありません'); return; }
    u.click();
    App.setStatus('元に戻しました（2本指でたたく）');
  };

  window.Quick = { showTray: showTray, hideTray: hideTray };
})();
