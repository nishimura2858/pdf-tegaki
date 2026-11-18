/* 全画面のときの、道具の呼び出し
   全画面では、道具のバーもパレットも出さず、本だけを見せる。道具は指で呼び出す
   - 指で1回たたく: 画面の下に「道具の帯」が出る。道具・色・太さ・元に戻すが1枚にまとまっている
     （中身のうち、色・太さなどはパレットの中身をそのまま移して使う）。紙をさわるか、何もしないと数秒で消える
   - 2本指でたたく: 元に戻す（全画面でなくても使える。GoodNotesと同じ）
   - 長押しで出す「輪のメニュー」も作ったが、ユーザーの希望でなくした（2026-11-17）
   指の操作を見分けるのは app.js（hooks.singleTap / twoTap） */
(function () {
  'use strict';
  var App = window.App, S = App.S;
  var $ = function (id) { return document.getElementById(id); };
  var tray = $('tray'), panel = $('palPanel'), palette = $('palette');
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
    else { hideTray(true); palette.appendChild(panel); }
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
    else if (b.id === 'trayBw') Scrap.bwPick(b);
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
    if (tray.hidden) showTray(); else hideTray();
  };
  App.on('page', function () { if (!tray.hidden) info(); });
  App.on('open', function () { hideTray(true); });
  App.on('close', function () { hideTray(true); });

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
