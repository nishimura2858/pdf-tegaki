/* Googleドライブに新しく保存されたPDFを見つけて「開きますか？」と聞く
   - iPadの共有メニューにWebアプリは出られないので、「"ファイル"に保存」でGoogleドライブの
     好きなフォルダに保存してから、このアプリを開いてもらう
   - このアプリが前に出たとき（起動・ほかのアプリから戻ったとき）、この10分のあいだに
     自分のドライブに新しく置かれたPDFがあれば、いちばん新しいものについて聞く
   - Driveへの送信には少し時間がかかるので、前に出てから40秒は4秒ごとに見る
   - 聞いたファイルは、開いても断っても、もう聞かない（localStorage「inbox:seen」= { ファイルID: 時刻 }）
   - このアプリが作ったPDF（書き込み前の控え）と、いま開いているPDFと同じ名前のものは聞かない
   - 2026-11-15: 最初は専用フォルダに置く形（ショートカット）にしたが、Googleドライブを保存先に
     選べず、PDFも1か所にたまるので、この形に変えた */
(function () {
  'use strict';
  var App = window.App;
  var WINDOW_MS = 10 * 60 * 1000, POLL_MS = 4000, POLL_FOR = 40000;
  var busy = false, pollTimer = null, pollUntil = 0;

  function readSeen() { try { return JSON.parse(localStorage.getItem('inbox:seen')) || {}; } catch (e) { return {}; } }
  function writeSeen(m) {
    var now = Date.now();
    Object.keys(m).forEach(function (k) { if (now - m[k] > 24 * 3600 * 1000) delete m[k]; }); // 1日たったら忘れる
    try { localStorage.setItem('inbox:seen', JSON.stringify(m)); } catch (e) {}
  }
  function skip(f) {
    if (f.appProperties && f.appProperties.tegakiOrig) return true;      // 書き込み前の控え
    if (/（書き込み前）\.pdf$/.test(f.name || '')) return true;
    return App.S.hasFile && App.S.name === f.name;                        // もう開いている
  }

  async function check() {
    if (busy || document.hidden || !window.GAuth || !GAuth.hasToken() || !navigator.onLine) return;
    busy = true;
    try {
      var token = await GAuth.ensure();
      if (!token) return;
      var files = await Drive.listNewPdfs(new Date(Date.now() - WINDOW_MS).toISOString(), token);
      var seen = readSeen();
      var fresh = files.filter(function (f) { return !seen[f.id]; });
      if (!fresh.length) return;
      fresh.forEach(function (f) { seen[f.id] = Date.now(); }); // 一度に何回も聞かない
      writeSeen(seen);
      var f = fresh.filter(function (x) { return !skip(x); })[0];
      if (!f) return;
      stopPoll();
      if (!window.confirm('Googleドライブに新しいPDF「' + f.name + '」があります。開きますか？')) return;
      App.setStatus('読み込み中…');
      var buf = await Drive.downloadFile(f.id, token);
      await PdfOpen.openBuffer(buf, f.name);
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
        if (pollUntil && Date.now() < pollUntil) pollTimer = setTimeout(tick, POLL_MS); else pollTimer = null;
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
