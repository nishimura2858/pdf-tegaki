/* 手書きデータのDrive同期
   - 「ファイルから開く」で開いたPDFが対象（白紙は、この端末にだけ保存）
   - PDFとは、PDFの中身から作った識別子（SHA-256）で結びつける
   - この端末への保存はこれまでどおりすぐ行い、Driveへは書き終えて約10秒後と、アプリを閉じたときに送る
   - 開いたときにDrive側が新しければ読み込む。両方で書き換えていたら、どちらを残すか聞く
   この端末での同期の記録: localStorage「sync:<PDFの識別子>」= { fileId, version, dirty, dirtyAt } */
(function () {
  'use strict';
  var App = window.App;
  var btn = document.getElementById('syncBtn');
  var DELAY = 10000;
  var cur = null;        // 開いているPDF { pdfHash, name, key }
  var timer = null, busy = false, again = false, state = '';
  var folderP = null;

  function readMeta(id) { try { return JSON.parse(localStorage.getItem('sync:' + id)) || {}; } catch (e) { return {}; } }
  function writeMeta(id, m) { try { localStorage.setItem('sync:' + id, JSON.stringify(m)); } catch (e) {} }
  function keepBackup(id, json) { try { localStorage.setItem('strokes:backup:' + id, json); } catch (e) {} }

  function show(s, text) {
    state = s;
    btn.hidden = false;
    btn.textContent = text;
    btn.classList.toggle('warn', s === 'login' || s === 'error');
    App.dbg('Drive同期: ' + text);
  }
  function jsonName(pdfName) { return String(pdfName || 'PDF').replace(/\.pdf$/i, '') + '.strokes.json'; }
  function folder(token) {
    if (!folderP) folderP = Drive.ensureFolder(token).catch(function (e) { folderP = null; throw e; });
    return folderP;
  }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; sync(); }, ms);
  }

  async function sync() {
    if (!cur) return;
    if (busy) { again = true; return; }
    clearTimeout(timer); timer = null;
    var token = GAuth.current();
    if (!token) {
      show('login', readMeta(cur.pdfHash).dirty ? 'Drive未保存・ログイン' : 'Driveにログイン');
      return;
    }
    busy = true;
    var c = cur;
    try {
      var m = readMeta(c.pdfHash);
      if (m.dirty) show('busy', 'Drive保存中…'); else show('busy', 'Drive確認中…');
      var remote = await Drive.findStrokes(c.pdfHash, token);
      if (c !== cur) return;
      var overwriteId = null;

      // Drive側が、この端末が最後に同期したときから変わっている
      if (remote && (remote.id !== m.fileId || remote.version !== m.version)) {
        var data = await Drive.getJson(remote.id, token);
        if (c !== cur) return;
        var now = readMeta(c.pdfHash);
        var useRemote = true;
        if (now.dirty && App.hasStrokes()) {
          useRemote = window.confirm(
            '「' + c.name + '」の手書きが、別の端末でも書き換えられています。\n\n' +
            'OK：Driveの内容に置き換える\n' +
            'キャンセル：この端末の内容でDriveを上書きする\n\n' +
            '選ばなかった方は、この端末に控えとして残します。');
          if (c !== cur) return;
          keepBackup(c.pdfHash, useRemote ? App.exportJson() : JSON.stringify(data));
        }
        if (useRemote) {
          if (!App.replaceData(data)) { again = true; return; } // 書いている最中なら、あとでやり直す
          writeMeta(c.pdfHash, { fileId: remote.id, version: remote.version, dirty: false, dirtyAt: 0 });
          App.setStatus('Driveの手書きを読み込みました');
          show('ok', 'Drive保存済み');
          return;
        }
        overwriteId = remote.id;
      }

      var before = readMeta(c.pdfHash);
      var target = overwriteId || (remote && remote.id) || null;
      if (!before.dirty && !overwriteId && (target || !App.hasStrokes())) { show('ok', 'Drive保存済み'); return; }

      show('busy', 'Drive保存中…');
      var body = App.exportJson();
      var res;
      if (target) {
        try { res = await Drive.updateStrokes(target, body, token); }
        catch (e) { if (e.status !== 404) throw e; target = null; }
      }
      if (!target) res = await Drive.createStrokes(await folder(token), jsonName(c.name), c.pdfHash, body, token);
      // 送っている間にまた書いたら、もう一度送る
      var after = readMeta(c.pdfHash);
      var changed = after.dirtyAt !== before.dirtyAt;
      writeMeta(c.pdfHash, { fileId: res.id, version: res.version, dirty: changed, dirtyAt: after.dirtyAt || 0 });
      if (c !== cur) return;
      if (changed) { show('pending', 'Drive保存待ち'); schedule(DELAY); }
      else show('ok', 'Drive保存済み');
    } catch (e) {
      console.error(e);
      if (e.status === 401) { GAuth.invalidate(); show('login', 'Drive未保存・ログイン'); }
      else if (c === cur) show('error', 'Drive保存失敗・再試行');
    } finally {
      busy = false;
      if (again) { again = false; schedule(1500); }
    }
  }

  // この端末に保存されたとき（＝手書きが変わったとき）
  App.hooks.saved = function (key) {
    if (!cur || key !== cur.key) return;
    var m = readMeta(cur.pdfHash);
    m.dirty = true; m.dirtyAt = Date.now();
    writeMeta(cur.pdfHash, m);
    if (state !== 'login') show('pending', 'Drive保存待ち');
    if (!busy) schedule(DELAY); else again = true;
  };

  // ファイルを開いたとき
  App.hooks.opened = function (key, name) {
    clearTimeout(timer); timer = null;
    var mt = /^strokes:pdf:([0-9a-f]{64})$/.exec(key);
    if (!mt) { cur = null; btn.hidden = true; state = ''; return; }
    cur = { pdfHash: mt[1], name: name, key: key };
    sync();
  };

  // アプリを閉じる・ほかのアプリに切り替えるときは、待たずに送る
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && cur && readMeta(cur.pdfHash).dirty) sync();
  });

  // 通信が戻ったら、Driveに送れていない分を送る
  window.addEventListener('online', function () {
    if (cur && readMeta(cur.pdfHash).dirty) schedule(1000);
  });

  // ボタン: ログインが必要ならログインしてから、それ以外はすぐ同期
  btn.addEventListener('click', function () {
    if (!cur) return;
    if (state === 'login' || !GAuth.hasToken()) {
      GAuth.getToken('sync').then(function () { sync(); }, function (e) {
        App.setStatus(PdfOpen.message(e && e.message));
      });
      return;
    }
    sync();
  });

  window.DriveSync = { sync: sync };
})();
