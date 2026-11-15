/* 共有メニューから届いたPDFを開く
   - iPadの共有メニューに、Webアプリは直接出られない。そこで「ショートカット」アプリで、
     PDFをGoogleドライブの「手書きアプリで開く」フォルダに置くショートカットを作ってもらう
   - このアプリが前に出たとき（起動・ほかのアプリから戻ったとき）、そのフォルダに
     この10分のあいだに置かれたPDFがあれば、いちばん新しいものを開く
   - Driveへの送信には少し時間がかかるので、前に出てから40秒は4秒ごとに見る
   - 一度開いた（見つけた）ファイルは、もう開かない（localStorage「inbox:seen」= { ファイルID: 時刻 }） */
(function () {
  'use strict';
  var App = window.App;
  var WINDOW_MS = 10 * 60 * 1000, POLL_MS = 4000, POLL_FOR = 40000;
  var folderP = null, busy = false, pollTimer = null, pollUntil = 0;

  function readSeen() { try { return JSON.parse(localStorage.getItem('inbox:seen')) || {}; } catch (e) { return {}; } }
  function writeSeen(m) {
    var now = Date.now();
    Object.keys(m).forEach(function (k) { if (now - m[k] > 24 * 3600 * 1000) delete m[k]; }); // 1日たったら忘れる
    try { localStorage.setItem('inbox:seen', JSON.stringify(m)); } catch (e) {}
  }
  function folder(token) {
    if (!folderP) folderP = Drive.ensureInbox(token).catch(function (e) { folderP = null; throw e; });
    return folderP;
  }

  async function check() {
    if (busy || !window.GAuth || !GAuth.hasToken() || !navigator.onLine) return;
    busy = true;
    try {
      var token = await GAuth.ensure();
      if (!token) return;
      var since = new Date(Date.now() - WINDOW_MS).toISOString();
      var files = await Drive.listInbox(await folder(token), since, token);
      var seen = readSeen();
      var fresh = files.filter(function (f) { return !seen[f.id]; });
      if (!fresh.length) return;
      fresh.forEach(function (f) { seen[f.id] = Date.now(); });
      writeSeen(seen);
      var f = fresh[0]; // いちばん新しいもの
      App.setStatus('届いたPDFを読み込み中…');
      var buf = await Drive.downloadFile(f.id, token);
      await PdfOpen.openBuffer(buf, f.name);
      App.setStatus('届いたPDF「' + f.name + '」を開きました');
      stopPoll();
    } catch (e) {
      console.error(e);
      if (e && e.status === 401) GAuth.invalidate();
    } finally { busy = false; }
  }

  function stopPoll() { clearTimeout(pollTimer); pollTimer = null; pollUntil = 0; }
  function startPoll() {
    pollUntil = Date.now() + POLL_FOR;
    if (pollTimer) return;
    (function tick() {
      check().then(function () {
        if (Date.now() < pollUntil) pollTimer = setTimeout(tick, POLL_MS); else pollTimer = null;
      });
    })();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopPoll(); else startPoll();
  });
  window.addEventListener('pageshow', startPoll);
  setTimeout(startPoll, 1500); // 起動したとき（ログインの確認などが終わってから）

  window.Inbox = { check: check };
})();
